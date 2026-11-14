import { describe, expect, test } from "vitest";
import {
  createD1Database,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from "./d1";

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Minimal D1 stand-in. Each prepared statement records its own sql and
 * bound params, which both the direct `all`/`run` paths and `batch` read
 * back -- so a test can assert exactly what the adapter sent. */
function fakeD1(rows: readonly unknown[] = [], changes = 0) {
  const executed: RecordedCall[] = [];
  const batches: RecordedCall[][] = [];

  interface Recorded extends D1PreparedStatementLike {
    readonly recorded: () => RecordedCall;
  }

  function prepare(sql: string): Recorded {
    let params: readonly unknown[] = [];
    const statement: Recorded = {
      recorded: () => ({ sql, params }),
      bind(...values) {
        params = values;
        return statement;
      },
      async all<T>() {
        executed.push({ sql, params });
        return { results: rows as readonly T[] };
      },
      async run() {
        executed.push({ sql, params });
        return { meta: { changes } };
      },
    };
    return statement;
  }

  const db: D1DatabaseLike = {
    prepare,
    async batch<T>(statements: readonly D1PreparedStatementLike[]) {
      batches.push(
        statements.map((statement) => (statement as Recorded).recorded()),
      );
      return statements.map(() => ({ results: [] as readonly T[] }));
    },
  };

  return { db, executed, batches };
}

describe("createD1Database", () => {
  test("query returns the driver's results", async () => {
    const { db } = fakeD1([{ id: "a" }, { id: "b" }]);
    const result = await createD1Database(db).query<{ id: string }>(
      "SELECT * FROM t",
    );
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("query binds parameters when supplied", async () => {
    const { db, executed } = fakeD1();
    await createD1Database(db).query("SELECT * FROM t WHERE id = ?", ["x"]);
    expect(executed[0]).toEqual({
      sql: "SELECT * FROM t WHERE id = ?",
      params: ["x"],
    });
  });

  test("query skips binding for an empty parameter list", async () => {
    const { db, executed } = fakeD1();
    await createD1Database(db).query("SELECT 1", []);
    expect(executed[0]?.params).toEqual([]);
  });

  test("execute reports the affected row count", async () => {
    const { db } = fakeD1([], 3);
    expect(await createD1Database(db).execute("DELETE FROM t")).toEqual({
      rowsAffected: 3,
    });
  });

  test("batch forwards every statement with its parameters", async () => {
    const { db, batches } = fakeD1();
    await createD1Database(db).batch([
      { sql: "INSERT INTO t VALUES (?)", params: ["a"] },
      { sql: "INSERT INTO t VALUES (?)", params: ["b"] },
    ]);
    expect(batches).toEqual([
      [
        { sql: "INSERT INTO t VALUES (?)", params: ["a"] },
        { sql: "INSERT INTO t VALUES (?)", params: ["b"] },
      ],
    ]);
  });

  test("batch is a no-op for an empty list", async () => {
    const { db, batches } = fakeD1();
    await createD1Database(db).batch([]);
    expect(batches).toHaveLength(0);
  });
});
