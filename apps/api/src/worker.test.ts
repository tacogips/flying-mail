import { createInMemoryDatabase } from "@mailcal/adapter/sql/libsql";
import { createMigrationRunner } from "@mailcal/adapter/migrations/runner";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  MailConfigurationError,
  PublicOriginConfigurationError,
} from "@mailcal/infrastructure/composition/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "@mailcal/adapter/sql/d1";
import type { R2BucketLike } from "@mailcal/adapter/blob/r2";
import type {
  CloudflareEmailMessage,
  CloudflareSendEmailBinding,
} from "@mailcal/adapter/mail/cloudflare-email";
import { buildWorkerConfig, clearWorkerCacheForTesting } from "./worker";
import worker from "./worker";
import { type Env, envToRecord, headersToMap } from "./env";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Bridges the in-memory libsql database behind the structural D1 surface,
 * so the Worker can be exercised end to end against the real schema without
 * a Workers runtime. */
function d1OverLibsql(db: SqlDatabase): D1DatabaseLike {
  function prepare(sql: string): D1PreparedStatementLike {
    let params: readonly unknown[] = [];
    const statement: D1PreparedStatementLike = {
      bind(...values) {
        params = values;
        return statement;
      },
      async all<T>() {
        const rows = await db.query<T>(sql, params as never);
        return { results: rows };
      },
      async run() {
        const result = await db.execute(sql, params as never);
        return { meta: { changes: result.rowsAffected } };
      },
    };
    Object.defineProperty(statement, "__sql", {
      value: () => ({ sql, params }),
      enumerable: false,
    });
    return statement;
  }

  return {
    prepare,
    async batch<T>(statements: readonly D1PreparedStatementLike[]) {
      await db.batch(
        statements.map((statement) => {
          const { sql, params } = (
            statement as unknown as {
              __sql: () => { sql: string; params: readonly unknown[] };
            }
          ).__sql();
          return { sql, params: params as never };
        }),
      );
      return statements.map(() => ({ results: [] as readonly T[] }));
    },
  };
}

function memoryR2(): R2BucketLike {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      objects.set(
        key,
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer()),
      );
      return undefined;
    },
    async get(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) {
        return null;
      }
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: bytes.length,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function recordingEmail(): {
  binding: CloudflareSendEmailBinding;
  sent: CloudflareEmailMessage[];
} {
  const sent: CloudflareEmailMessage[] = [];
  return {
    sent,
    binding: {
      async send(message) {
        sent.push(message);
        return {};
      },
    },
  };
}

interface WorkerHarness {
  readonly env: Env;
  readonly db: SqlDatabase;
  readonly assetRequests: Request[];
}

/** Under `exactOptionalPropertyTypes`, an explicit `undefined` is not a
 * valid value for an optional property -- but "unset this var" is what
 * several cases need to express. The helper strips those keys. */
type EnvOverrides = {
  readonly [K in keyof Env]?: Env[K] | undefined;
};

async function createWorkerEnv(
  overrides: EnvOverrides = {},
): Promise<WorkerHarness> {
  const db = createInMemoryDatabase();
  await createMigrationRunner(db).apply(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => ({
        name,
        sql: readFileSync(join(MIGRATIONS_DIR, name), "utf-8"),
      })),
  );

  const assetRequests: Request[] = [];
  const merged: Record<string, unknown> = {
    DB: d1OverLibsql(db),
    BLOB: memoryR2(),
    EMAIL: recordingEmail().binding,
    ASSETS: {
      async fetch(request: Request) {
        assetRequests.push(request);
        return new Response("<html>spa</html>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
    MAILCAL_PUBLIC_ORIGIN: "https://mail.example.com",
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  const env = merged as unknown as Env;

  clearWorkerCacheForTesting(env);
  return { env, db, assetRequests };
}

async function seedActiveDomain(db: SqlDatabase): Promise<void> {
  await db.execute(
    `INSERT INTO domains
       (id, name, status, catch_all, verification_token, verified_at, created_at, updated_at)
     VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'tok',
             '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z',
             '2026-08-23T00:00:00.000Z')`,
  );
}

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};

function inboundMessage(options: {
  readonly from: string;
  readonly to: string;
  readonly raw: string;
}) {
  const rejections: string[] = [];
  const bytes = new TextEncoder().encode(options.raw);
  return {
    rejections,
    message: {
      from: options.from,
      to: options.to,
      headers: new Headers({ "authentication-results": "spf=pass" }),
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      rawSize: bytes.length,
      setReject(reason: string) {
        rejections.push(reason);
      },
      async forward() {
        // Not used by mailcal.
      },
    },
  };
}

const SAMPLE_EML = [
  "From: Sender <sender@other.com>",
  "To: support@example.com",
  "Subject: Help please",
  "Message-ID: <inbound-1@other.com>",
  "Content-Type: text/plain",
  "",
  "I need help.",
  "",
].join("\r\n");

describe("env helpers", () => {
  test("envToRecord exposes every var the config resolvers read", () => {
    const record = envToRecord({
      MAILCAL_PUBLIC_ORIGIN: "https://mail.example.com",
      MAILCAL_SIGNUP: "open",
    } as Env);
    expect(record["MAILCAL_PUBLIC_ORIGIN"]).toBe("https://mail.example.com");
    expect(record["MAILCAL_SIGNUP"]).toBe("open");
    expect(record["MAILCAL_MAIL_FROM"]).toBeUndefined();
  });

  test("headersToMap lower-cases keys and joins repeats", () => {
    const headers = new Headers();
    headers.append("Authentication-Results", "spf=pass");
    headers.append("Authentication-Results", "dkim=fail");
    const map = headersToMap(headers);
    expect(map.get("authentication-results")).toContain("spf=pass");
    expect(map.get("authentication-results")).toContain("dkim=fail");
  });
});

describe("buildWorkerConfig", () => {
  let harness: WorkerHarness;

  beforeEach(async () => {
    harness = await createWorkerEnv();
  });

  test("defaults to D1 plus R2", () => {
    const config = buildWorkerConfig(harness.env);
    expect(config.sqlBackend).toBe("d1");
    expect(config.blobBackend).toBe("r2");
    expect(config.r2).toBe(harness.env.BLOB);
    expect(config.publicOrigin).toBe("https://mail.example.com");
  });

  test("selects the S3 backend when asked", async () => {
    const { env } = await createWorkerEnv({
      MAILCAL_BLOB_BACKEND: "s3",
      MAILCAL_S3_ENDPOINT: "https://s3.example.com",
      MAILCAL_S3_BUCKET: "mailcal",
      MAILCAL_S3_ACCESS_KEY_ID: "key",
      MAILCAL_S3_SECRET_ACCESS_KEY: "secret",
    });
    const config = buildWorkerConfig(env);
    expect(config.blobBackend).toBe("s3");
    expect(config.s3?.bucket).toBe("mailcal");
    expect(config.r2).toBeUndefined();
  });

  test("throws for an invalid public origin", async () => {
    const { env } = await createWorkerEnv({
      MAILCAL_PUBLIC_ORIGIN: "not-a-url",
    });
    expect(() => buildWorkerConfig(env)).toThrow(
      PublicOriginConfigurationError,
    );
  });

  test("throws for a sender configured without an origin", async () => {
    const { env } = await createWorkerEnv({
      MAILCAL_PUBLIC_ORIGIN: undefined,
      MAILCAL_MAIL_FROM: "postmaster@example.com",
    });
    expect(() => buildWorkerConfig(env)).toThrow(MailConfigurationError);
  });
});

describe("worker fetch", () => {
  let harness: WorkerHarness;

  beforeEach(async () => {
    harness = await createWorkerEnv();
  });

  test("serves GraphQL", async () => {
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
      harness.env,
      executionContext,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { viewer: null } };
    expect(body.data.viewer).toBeNull();
  });

  test("falls through to static assets for an unmatched path", async () => {
    const response = await worker.fetch(
      new Request("https://mail.example.com/mailbox"),
      harness.env,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa");
    expect(harness.assetRequests).toHaveLength(1);
  });

  test("builds the app once per isolate", async () => {
    let prepareCalls = 0;
    const countingEnv: Env = {
      ...harness.env,
      DB: {
        prepare(sql) {
          prepareCalls += 1;
          return harness.env.DB.prepare(sql);
        },
        batch: (statements) => harness.env.DB.batch(statements),
      },
    };
    clearWorkerCacheForTesting(countingEnv);

    const request = () =>
      worker.fetch(
        new Request("https://mail.example.com/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
        }),
        countingEnv,
        executionContext,
      );
    await request();
    const afterFirst = prepareCalls;
    await request();
    // Construction itself issues no queries; the second request must not
    // re-run it, which would show up as extra prepares before the query.
    expect(prepareCalls).toBe(afterFirst);
  });

  test("a construction failure is masked and not cached", async () => {
    const { env } = await createWorkerEnv({
      MAILCAL_PUBLIC_ORIGIN: "not-a-url",
    });
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql"),
      env,
      executionContext,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });

    // Not cached: a second request retries construction and fails the same
    // way rather than serving a wedged isolate.
    const second = await worker.fetch(
      new Request("https://mail.example.com/graphql"),
      env,
      executionContext,
    );
    expect(second.status).toBe(500);
  });
});

describe("worker email", () => {
  let harness: WorkerHarness;

  beforeEach(async () => {
    harness = await createWorkerEnv();
  });

  test("stores mail for a managed domain", async () => {
    await seedActiveDomain(harness.db);
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "support@example.com",
      raw: SAMPLE_EML,
    });

    await worker.email(inbound.message, harness.env, executionContext);

    expect(inbound.rejections).toEqual([]);
    const rows = await harness.db.query<{ subject: string; id: string }>(
      "SELECT id, subject FROM messages",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("Help please");

    const recipients = await harness.db.query<{ address: string }>(
      "SELECT address FROM message_recipients WHERE kind = 'ENVELOPE'",
    );
    expect(recipients[0]?.address).toBe("support@example.com");
  });

  test("rejects mail for an unknown domain at SMTP time", async () => {
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "someone@unmanaged.com",
      raw: SAMPLE_EML,
    });

    await worker.email(inbound.message, harness.env, executionContext);

    expect(inbound.rejections).toEqual([
      "Recipient address is not served here",
    ]);
    const rows = await harness.db.query<{ id: string }>(
      "SELECT id FROM messages",
    );
    expect(rows).toHaveLength(0);
  });

  test("a duplicate Message-ID does not store a second copy", async () => {
    await seedActiveDomain(harness.db);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inbound = inboundMessage({
        from: "sender@other.com",
        to: "support@example.com",
        raw: SAMPLE_EML,
      });
      await worker.email(inbound.message, harness.env, executionContext);
    }
    const rows = await harness.db.query<{ id: string }>(
      "SELECT id FROM messages",
    );
    expect(rows).toHaveLength(1);
  });

  test("stores the raw source in the blob store", async () => {
    await seedActiveDomain(harness.db);
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "support@example.com",
      raw: SAMPLE_EML,
    });
    await worker.email(inbound.message, harness.env, executionContext);

    const rows = await harness.db.query<{ raw_key: string }>(
      "SELECT raw_key FROM messages",
    );
    const rawKey = rows[0]?.raw_key ?? "";
    expect(rawKey).toMatch(/^raw\/.+\.eml$/);
    expect(await harness.env.BLOB.get(rawKey)).not.toBeNull();
  });
});
