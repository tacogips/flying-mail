import { createClient, type Client, type InValue } from "@libsql/client";
import type {
  SqlDatabase,
  SqlStatement,
  SqlValue,
} from "@mailcal/application/ports/sql-database";

function toInValues(params: readonly SqlValue[] | undefined): InValue[] {
  return [...(params ?? [])] as InValue[];
}

function wrapClient(client: Client): SqlDatabase {
  return {
    async query<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<readonly T[]> {
      const result = await client.execute({
        sql,
        args: toInValues(params),
      });
      return result.rows as unknown as readonly T[];
    },

    async execute(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ rowsAffected: number }> {
      const result = await client.execute({ sql, args: toInValues(params) });
      return { rowsAffected: result.rowsAffected };
    },

    async batch(statements: readonly SqlStatement[]): Promise<void> {
      if (statements.length === 0) {
        return;
      }
      // "write" mode gives the same all-or-nothing semantics D1's `batch()`
      // has, which is what the `SqlDatabase` port promises.
      await client.batch(
        statements.map((statement) => ({
          sql: statement.sql,
          args: toInValues(statement.params),
        })),
        "write",
      );
    },
  };
}

/** libsql-backed `SqlDatabase` for the local Bun/Node server.
 *
 * SQLite does *not* enforce foreign keys unless asked, and the schema relies
 * on `ON DELETE CASCADE` for message recipients, attachments, tags and fetch
 * states -- so the pragma is issued eagerly at construction. Without it,
 * deleting a message on the local server would leave orphan rows that the
 * production D1 deployment would never have. */
export function createLibsqlDatabase(url: string): SqlDatabase {
  const client = createClient({ url });
  void client.execute("PRAGMA foreign_keys = ON").catch(() => {
    // A backend that rejects the pragma still works; it just does not
    // cascade. Surfacing this as a construction failure would be worse
    // than the degraded behavior.
  });
  return wrapClient(client);
}

/** In-memory libsql database, used by the adapter's own integration tests
 * and available as a throwaway backend for local experimentation. */
export function createInMemoryDatabase(): SqlDatabase {
  return createLibsqlDatabase(":memory:");
}
