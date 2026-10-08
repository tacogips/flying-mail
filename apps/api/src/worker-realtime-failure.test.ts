import { createInMemoryDatabase } from "@flying-mail/adapter/sql/libsql";
import { createMigrationRunner } from "@flying-mail/adapter/migrations/runner";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "@flying-mail/adapter/sql/d1";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "./env";
import worker, { clearWorkerCacheForTesting } from "./worker";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

function d1OverLibsql(db: SqlDatabase): D1DatabaseLike {
  return {
    prepare(sql) {
      let params: readonly unknown[] = [];
      const statement: D1PreparedStatementLike = {
        bind(...values) {
          params = values;
          return statement;
        },
        async all<T>() {
          return { results: await db.query<T>(sql, params as never) };
        },
        async run() {
          const result = await db.execute(sql, params as never);
          return { meta: { changes: result.rowsAffected } };
        },
      };
      Object.defineProperty(statement, "__sql", {
        value: () => ({ sql, params }),
      });
      return statement;
    },
    async batch<T>(statements: readonly D1PreparedStatementLike[]) {
      await db.batch(
        statements.map((statement) => {
          const stored = statement as unknown as {
            __sql(): { sql: string; params: readonly unknown[] };
          };
          return { ...stored.__sql(), params: stored.__sql().params as never };
        }),
      );
      return statements.map(() => ({ results: [] as readonly T[] }));
    },
  };
}

async function makeEnv(): Promise<Env> {
  const db = createInMemoryDatabase();
  await createMigrationRunner(db).apply(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({
        name,
        sql: readFileSync(join(MIGRATIONS_DIR, name), "utf-8"),
      })),
  );
  return {
    DB: d1OverLibsql(db),
    BLOB: {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    },
    EMAIL: {
      async send() {
        return {};
      },
    },
    ASSETS: {
      async fetch() {
        return new Response();
      },
    },
    FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.example.com",
  };
}

describe("Worker realtime failure handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("masks Durable Object fetch failures as plain-text 503 responses", async () => {
    const env = await makeEnv();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingEnv = {
      ...env,
      MAIL_EVENT_HUB: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return {
            async fetch() {
              throw new Error("private upstream detail");
            },
          };
        },
      },
    } as Env;
    clearWorkerCacheForTesting(failingEnv);

    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql", {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "graphql-transport-ws",
          origin: "https://mail.example.com",
        },
      }),
      failingEnv,
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(
      "Realtime subscriptions are unavailable",
    );
    expect(log).toHaveBeenCalledWith("Realtime Durable Object request failed");
  });
});
