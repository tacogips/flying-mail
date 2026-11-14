/** A single SQL bind parameter value. D1 and libsql both accept this set. */
export type SqlValue = string | number | null | Uint8Array;

/** One statement in a {@link SqlDatabase.batch} call. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlValue[];
}

/** Port over the relational store backing mailcal. Implementations: D1
 * (Cloudflare Workers), libsql (a local SQLite file under Bun/Node), and an
 * in-memory libsql database for tests.
 *
 * There is intentionally no `transaction(fn)` callback API: D1 does not
 * support interactive transactions. `batch()` is the common denominator that
 * is atomic on both D1 and SQLite, so any operation needing read-then-write
 * consistency -- message ingest writing a message plus its recipients,
 * attachments and tags -- composes its writes into a single `batch()` call
 * instead. */
export interface SqlDatabase {
  /** Runs a `SELECT` and returns the resulting rows. */
  query<T>(sql: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  /** Runs an `INSERT`/`UPDATE`/`DELETE` and returns the affected row count. */
  execute(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<{ rowsAffected: number }>;
  /** Executes all statements atomically, in order. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}
