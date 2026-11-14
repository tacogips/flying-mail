import type {
  SqlDatabase,
  SqlStatement,
} from "@mailcal/application/ports/sql-database";

/** One `.sql` migration file, keyed by its filename (e.g.
 * `"0001_init.sql"`); applied in lexicographic `name` order. */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export interface MigrationRunner {
  /** Applies not-yet-applied migrations in order; each file's statements run
   * inside its own `batch()`. Returns the names applied by this call. */
  apply(
    migrations: readonly MigrationFile[],
  ): Promise<{ applied: readonly string[] }>;
}

const ENSURE_SCHEMA_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

/** D1 and libsql `batch()` do not accept multi-statement strings, so each
 * file is split first.
 *
 * CAUTION for future migration authors: this splitter has no awareness of
 * string literals or comments. A `;` inside a quoted value would be split as
 * if it ended the statement, silently corrupting the migration. Keep
 * migrations to plain DDL and simple `INSERT`s without embedded `;`, or
 * replace this with a real SQL splitter first. */
function splitStatements(sql: string): readonly string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Applies plain `.sql` files -- the same files `wrangler d1 migrations
 * apply` uses in production -- against any `SqlDatabase`, tracking applied
 * names in a `schema_migrations` table it owns. D1's own wrangler-side
 * tracking is separate and out of scope here. */
export function createMigrationRunner(db: SqlDatabase): MigrationRunner {
  return {
    async apply(
      migrations: readonly MigrationFile[],
    ): Promise<{ applied: readonly string[] }> {
      await db.execute(ENSURE_SCHEMA_MIGRATIONS_TABLE);

      const appliedRows = await db.query<{ name: string }>(
        "SELECT name FROM schema_migrations",
      );
      const alreadyApplied = new Set(appliedRows.map((row) => row.name));

      // Plain codepoint comparison, never `localeCompare`: that is
      // ICU/locale-dependent and would make migration ordering differ
      // between machines. File names are ASCII `NNNN_description.sql`.
      const sorted = [...migrations].sort((a, b) => {
        if (a.name < b.name) {
          return -1;
        }
        return a.name > b.name ? 1 : 0;
      });

      const applied: string[] = [];
      for (const migration of sorted) {
        if (alreadyApplied.has(migration.name)) {
          continue;
        }
        const statements: SqlStatement[] = splitStatements(migration.sql).map(
          (sql) => ({ sql }),
        );
        try {
          await db.batch([
            ...statements,
            {
              sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
              params: [migration.name, new Date().toISOString()],
            },
          ]);
        } catch (error) {
          // Two processes can both see a migration as pending and both
          // attempt it. The loser fails in one of two ways depending on
          // timing: its DDL collides with the winner's ("table already
          // exists"), or its DDL succeeds and only the `schema_migrations`
          // insert loses on the PRIMARY KEY. Neither is a real error.
          //
          // The error class cannot reliably tell those apart from a genuine
          // failure -- a migration's own content can trip either shape. So
          // the ground truth is the follow-up query: if the migration is
          // recorded now, some process applied it successfully and this one
          // simply lost the race. Otherwise the failure is real and is
          // rethrown, because silently skipping a broken migration would
          // leave the schema quietly wrong.
          const recorded = await db.query<{ name: string }>(
            "SELECT name FROM schema_migrations WHERE name = ?",
            [migration.name],
          );
          if (recorded.length > 0) {
            continue;
          }
          throw error;
        }
        applied.push(migration.name);
      }
      return { applied };
    },
  };
}
