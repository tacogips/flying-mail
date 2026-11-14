import type {
  SqlDatabase,
  SqlStatement,
  SqlValue,
} from "@mailcal/application/ports/sql-database";

/** Minimal structural surface of a Cloudflare D1 prepared statement that
 * this adapter uses. Kept as a local, non-ambient interface (rather than
 * importing the ambient-global `@cloudflare/workers-types` package) so this
 * file's types do not merge into the global scope, where they would collide
 * with Bun's global runtime types used by the rest of `@mailcal/adapter`. A
 * real `D1PreparedStatement`, and hand-rolled test fakes, satisfy this
 * structurally. */
export interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
}

/** Minimal structural surface of a Cloudflare D1 binding. See
 * {@link D1PreparedStatementLike} for why this is a local type. */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T>(
    statements: readonly D1PreparedStatementLike[],
  ): Promise<readonly { readonly results: readonly T[] }[]>;
}

function bindParams(
  stmt: D1PreparedStatementLike,
  params: readonly SqlValue[] | undefined,
): D1PreparedStatementLike {
  return params === undefined || params.length === 0
    ? stmt
    : stmt.bind(...params);
}

/** Maps a Cloudflare D1 binding onto the `SqlDatabase` port.
 *
 * Unlike libsql (see `enableForeignKeys` in `./libsql.ts`), this adapter
 * does not issue `PRAGMA foreign_keys = ON`: D1 enforces foreign keys by
 * default, and D1's binding surface has no pragma/session API to hook into
 * safely -- against hand-rolled test fakes that implement only
 * `prepare`/`batch`, such a call would be an outright error. */
export function createD1Database(d1: D1DatabaseLike): SqlDatabase {
  return {
    async query<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<readonly T[]> {
      const stmt = bindParams(d1.prepare(sql), params);
      const result = await stmt.all<T>();
      return result.results;
    },

    async execute(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ rowsAffected: number }> {
      const stmt = bindParams(d1.prepare(sql), params);
      const result = await stmt.run();
      return { rowsAffected: result.meta.changes };
    },

    async batch(statements: readonly SqlStatement[]): Promise<void> {
      if (statements.length === 0) {
        return;
      }
      const prepared = statements.map((statement) =>
        bindParams(d1.prepare(statement.sql), statement.params),
      );
      await d1.batch(prepared);
    },
  };
}
