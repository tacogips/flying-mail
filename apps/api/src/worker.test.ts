import { createInMemoryDatabase } from "@flying-mail/adapter/sql/libsql";
import { createMigrationRunner } from "@flying-mail/adapter/migrations/runner";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import {
  MailConfigurationError,
  PublicOriginConfigurationError,
} from "@flying-mail/infrastructure/composition/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
} from "@flying-mail/adapter/sql/d1";
import type { R2BucketLike } from "@flying-mail/adapter/blob/r2";
import type {
  CloudflareEmailMessage,
  CloudflareSendEmailBinding,
} from "@flying-mail/adapter/mail/cloudflare-email";
import {
  buildWorkerConfig,
  clearWorkerCacheForTesting,
  getBuiltWorkerForTesting,
} from "./worker";
import { buildWorkerNotifier } from "./worker-config";
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
    FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.example.com",
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

interface AwaitableExecutionContext {
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly passThroughOnException: () => void;
  readonly props: unknown;
  readonly drain: () => Promise<void>;
}

function createExecutionContext(): AwaitableExecutionContext {
  const scheduled: Promise<unknown>[] = [];
  return {
    waitUntil(promise) {
      scheduled.push(promise);
    },
    passThroughOnException() {},
    props: {},
    async drain() {
      while (scheduled.length > 0) {
        await Promise.all(scheduled.splice(0));
      }
    },
  };
}

async function seedBlobCleanup(
  harness: WorkerHarness,
  attachmentId: string,
  blobKey: string,
): Promise<void> {
  await harness.db.execute(
    `INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
     VALUES (?, ?, '2026-09-06T00:00:00.000Z')`,
    [attachmentId, blobKey],
  );
  await harness.env.BLOB.put(blobKey, new Uint8Array([1]));
}

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
        // Not used by flying-mail.
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
      FLYING_MAIL_PUBLIC_ORIGIN: "https://mail.example.com",
    } as Env);
    expect(record["FLYING_MAIL_PUBLIC_ORIGIN"]).toBe(
      "https://mail.example.com",
    );
    expect(record["FLYING_MAIL_MAIL_FROM"]).toBeUndefined();
    const authRecord = envToRecord({
      FLYING_MAIL_BOOTSTRAP_TOKEN: "bootstrap-token",
      FLYING_MAIL_TURNSTILE_SECRET_KEY: "turnstile-secret",
      FLYING_MAIL_TURNSTILE_SITE_KEY: "turnstile-site",
      FLYING_MAIL_INVITE_TTL_SECONDS: "86400",
    } as Env);
    expect(authRecord["FLYING_MAIL_BOOTSTRAP_TOKEN"]).toBe("bootstrap-token");
    expect(authRecord["FLYING_MAIL_TURNSTILE_SECRET_KEY"]).toBe(
      "turnstile-secret",
    );
    expect(authRecord["FLYING_MAIL_TURNSTILE_SITE_KEY"]).toBe("turnstile-site");
    expect(authRecord["FLYING_MAIL_INVITE_TTL_SECONDS"]).toBe("86400");
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
    expect(config.inboundMxSuffix).toBe("mx.cloudflare.net");
  });

  test("creates the Workers limiter only when its binding is present", async () => {
    expect(buildWorkerConfig(harness.env).rateLimiter).toBeUndefined();
    const { env } = await createWorkerEnv({
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect(buildWorkerConfig(env).rateLimiter).toBeDefined();
  });

  test("passes an empty inbound MX suffix through as a disabled gate", async () => {
    const { env } = await createWorkerEnv({
      FLYING_MAIL_INBOUND_MX_SUFFIX: "",
    });
    expect(buildWorkerConfig(env).inboundMxSuffix).toBeNull();
    expect(envToRecord(env)["FLYING_MAIL_INBOUND_MX_SUFFIX"]).toBe("");
  });

  test("selects the S3 backend when asked", async () => {
    const { env } = await createWorkerEnv({
      FLYING_MAIL_BLOB_BACKEND: "s3",
      FLYING_MAIL_S3_ENDPOINT: "https://s3.example.com",
      FLYING_MAIL_S3_BUCKET: "mailcal",
      FLYING_MAIL_S3_ACCESS_KEY_ID: "key",
      FLYING_MAIL_S3_SECRET_ACCESS_KEY: "secret",
    });
    const config = buildWorkerConfig(env);
    expect(config.blobBackend).toBe("s3");
    expect(config.s3?.bucket).toBe("mailcal");
    expect(config.r2).toBeUndefined();
  });

  test("throws for an invalid public origin", async () => {
    const { env } = await createWorkerEnv({
      FLYING_MAIL_PUBLIC_ORIGIN: "not-a-url",
    });
    expect(() => buildWorkerConfig(env)).toThrow(
      PublicOriginConfigurationError,
    );
  });

  test("throws for a sender configured without an origin", async () => {
    const { env } = await createWorkerEnv({
      FLYING_MAIL_PUBLIC_ORIGIN: undefined,
      FLYING_MAIL_MAIL_FROM: "postmaster@example.com",
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
    const executionContext = createExecutionContext();
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
    await executionContext.drain();
  });

  test("uses CF-Connecting-IP for the auth rate limit and returns RATE_LIMITED at HTTP 200", async () => {
    const keys: string[] = [];
    const env: Env = {
      ...harness.env,
      AUTH_RATE_LIMITER: {
        async limit({ key }) {
          keys.push(key);
          return { success: false };
        },
      },
    };
    clearWorkerCacheForTesting(env);
    const executionContext = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.7",
          "X-Forwarded-For": "198.51.100.1",
        },
        body: JSON.stringify({
          query: 'mutation { requestEmailAuth(email: "person@example.com") }',
        }),
      }),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"RATE_LIMITED"');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/203\.0\.113\.7$/);
    expect(keys[0]).not.toContain("198.51.100.1");
    await executionContext.drain();
  });

  test("treats a blank CF-Connecting-IP as an unknown client", async () => {
    const keys: string[] = [];
    const env: Env = {
      ...harness.env,
      AUTH_RATE_LIMITER: {
        async limit({ key }) {
          keys.push(key);
          return { success: false };
        },
      },
    };
    clearWorkerCacheForTesting(env);
    const executionContext = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "   ",
        },
        body: JSON.stringify({
          query: 'mutation { requestEmailAuth(email: "person@example.com") }',
        }),
      }),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"code":"RATE_LIMITED"');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/unknown$/);
    await executionContext.drain();
  });

  test("falls through to static assets for an unmatched path", async () => {
    const executionContext = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mail.example.com/mailbox"),
      harness.env,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("spa");
    expect(harness.assetRequests).toHaveLength(1);
    await executionContext.drain();
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

    const request = async (): Promise<Response> => {
      const executionContext = createExecutionContext();
      const response = await worker.fetch(
        new Request("https://mail.example.com/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
        }),
        countingEnv,
        executionContext,
      );
      await executionContext.drain();
      return response;
    };
    await request();
    const afterFirst = prepareCalls;
    await request();
    // Construction itself issues no queries; the second request must not
    // re-run it, which would show up as extra prepares before the query.
    expect(prepareCalls).toBe(afterFirst);
  });

  test("a construction failure is masked and not cached", async () => {
    const { env } = await createWorkerEnv({
      FLYING_MAIL_PUBLIC_ORIGIN: "not-a-url",
    });
    const firstContext = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql"),
      env,
      firstContext,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });

    // Not cached: a second request retries construction and fails the same
    // way rather than serving a wedged isolate.
    await firstContext.drain();
    const secondContext = createExecutionContext();
    const second = await worker.fetch(
      new Request("https://mail.example.com/graphql"),
      env,
      secondContext,
    );
    expect(second.status).toBe(500);
    await secondContext.drain();
  });

  test("deletes a queued blob and removes its durable queue row", async () => {
    const blobKey = "att/att-worker-cleanup/file.bin";
    await seedBlobCleanup(harness, "att-worker-cleanup", blobKey);
    const executionContext = createExecutionContext();

    await worker.fetch(
      new Request("https://mail.example.com/mailbox"),
      harness.env,
      executionContext,
    );
    await executionContext.drain();

    expect(await harness.env.BLOB.get(blobKey)).toBeNull();
    expect(await harness.db.query("SELECT * FROM blob_cleanup_queue")).toEqual(
      [],
    );
  });

  test("retries cleanup on the next request after a transient failure", async () => {
    const blobKey = "att/att-worker-retry/file.bin";
    await seedBlobCleanup(harness, "att-worker-retry", blobKey);
    const backing = harness.env.BLOB;
    let deleteAttempts = 0;
    const retryEnv: Env = {
      ...harness.env,
      BLOB: {
        put: (key, value, options) => backing.put(key, value, options),
        get: (key) => backing.get(key),
        async delete(key) {
          deleteAttempts += 1;
          if (deleteAttempts === 1) {
            throw new Error("transient R2 failure");
          }
          await backing.delete(key);
        },
      },
    };
    clearWorkerCacheForTesting(retryEnv);

    const firstContext = createExecutionContext();
    await worker.fetch(
      new Request("https://mail.example.com/mailbox"),
      retryEnv,
      firstContext,
    );
    await firstContext.drain();
    expect(
      await harness.db.query("SELECT attachment_id FROM blob_cleanup_queue"),
    ).toEqual([{ attachment_id: "att-worker-retry" }]);

    const secondContext = createExecutionContext();
    await worker.fetch(
      new Request("https://mail.example.com/mailbox"),
      retryEnv,
      secondContext,
    );
    await secondContext.drain();

    expect(deleteAttempts).toBe(2);
    expect(await backing.get(blobKey)).toBeNull();
    expect(await harness.db.query("SELECT * FROM blob_cleanup_queue")).toEqual(
      [],
    );
  });

  test("shares one cleanup attempt and stops scheduling work after completion", async () => {
    const blobKey = "att/att-worker-single-flight/file.bin";
    await seedBlobCleanup(harness, "att-worker-single-flight", blobKey);
    const backing = harness.env.BLOB;
    let deleteCalls = 0;
    let cleanupSelects = 0;
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const gatedEnv: Env = {
      ...harness.env,
      DB: {
        prepare(sql) {
          if (
            sql.trimStart().startsWith("SELECT") &&
            sql.includes("FROM blob_cleanup_queue")
          ) {
            cleanupSelects += 1;
          }
          return harness.env.DB.prepare(sql);
        },
        batch: (statements) => harness.env.DB.batch(statements),
      },
      BLOB: {
        put: (key, value, options) => backing.put(key, value, options),
        get: (key) => backing.get(key),
        async delete(key) {
          deleteCalls += 1;
          await deleteGate;
          await backing.delete(key);
        },
      },
    };
    clearWorkerCacheForTesting(gatedEnv);
    const firstContext = createExecutionContext();
    const secondContext = createExecutionContext();

    await Promise.all([
      worker.fetch(
        new Request("https://mail.example.com/first"),
        gatedEnv,
        firstContext,
      ),
      worker.fetch(
        new Request("https://mail.example.com/second"),
        gatedEnv,
        secondContext,
      ),
    ]);
    await vi.waitFor(() => expect(deleteCalls).toBe(1));
    expect(cleanupSelects).toBe(1);
    releaseDelete?.();
    await Promise.all([firstContext.drain(), secondContext.drain()]);
    const cleanupSelectsAfterCompletion = cleanupSelects;
    expect(cleanupSelectsAfterCompletion).toBe(2);

    const completedContext = createExecutionContext();
    await worker.fetch(
      new Request("https://mail.example.com/third"),
      gatedEnv,
      completedContext,
    );
    await completedContext.drain();
    expect(deleteCalls).toBe(1);
    expect(cleanupSelects).toBe(cleanupSelectsAfterCompletion);
    expect(await harness.db.query("SELECT * FROM blob_cleanup_queue")).toEqual(
      [],
    );
  });
});

describe("worker email", () => {
  let harness: WorkerHarness;

  beforeEach(async () => {
    harness = await createWorkerEnv();
  });

  test("email registers notifier settle with the binding", async () => {
    const release: { current: (() => void) | null } = { current: null };
    let notifyStarted = false;
    const pending = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    const env = {
      ...harness.env,
      MAIL_EVENT_HUB: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return {
            async fetch() {
              notifyStarted = true;
              await pending;
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    } as Env;
    getBuiltWorkerForTesting(env).deps.mailEventNotifier.notify();
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        scheduled.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "unknown@unmanaged.com",
      raw: SAMPLE_EML,
    });
    await worker.email(inbound.message, env, ctx);
    expect(notifyStarted).toBe(true);
    expect(scheduled).toHaveLength(2);
    let settleFinished = false;
    void scheduled[1]?.then(() => {
      settleFinished = true;
    });
    await Promise.resolve();
    expect(settleFinished).toBe(false);
    release.current?.();
    await Promise.all(scheduled);
    expect(settleFinished).toBe(true);
  });

  test("email does not register notifier settle without the binding", async () => {
    harness = await createWorkerEnv({
      FLYING_MAIL_EVENT_RETENTION_SECONDS: "3600",
    });
    expect(
      envToRecord(harness.env)["FLYING_MAIL_EVENT_RETENTION_SECONDS"],
    ).toBe("3600");
    expect(buildWorkerConfig(harness.env).eventRetentionSeconds).toBe(3600);
    expect(buildWorkerNotifier(harness.env)).toBeNull();
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        scheduled.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "unknown@unmanaged.com",
      raw: SAMPLE_EML,
    });
    await worker.email(inbound.message, harness.env, ctx);
    expect(getBuiltWorkerForTesting(harness.env).notifier).toBeNull();
    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
  });

  test("stores mail for a managed domain", async () => {
    await seedActiveDomain(harness.db);
    const inbound = inboundMessage({
      from: "sender@other.com",
      to: "support@example.com",
      raw: SAMPLE_EML,
    });

    const executionContext = createExecutionContext();
    await worker.email(inbound.message, harness.env, executionContext);
    await executionContext.drain();

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

    const executionContext = createExecutionContext();
    await worker.email(inbound.message, harness.env, executionContext);
    await executionContext.drain();

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
      const executionContext = createExecutionContext();
      await worker.email(inbound.message, harness.env, executionContext);
      await executionContext.drain();
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
    const executionContext = createExecutionContext();
    await worker.email(inbound.message, harness.env, executionContext);
    await executionContext.drain();

    const rows = await harness.db.query<{ raw_key: string }>(
      "SELECT raw_key FROM messages",
    );
    const rawKey = rows[0]?.raw_key ?? "";
    expect(rawKey).toMatch(/^raw\/.+\.eml$/);
    expect(await harness.env.BLOB.get(rawKey)).not.toBeNull();
  });
});

describe("Worker realtime upgrades", () => {
  let harness: WorkerHarness;
  beforeEach(async () => {
    harness = await createWorkerEnv();
  });

  function hubBinding(
    fetch: (input: string, init?: RequestInit) => Promise<Response>,
  ) {
    return {
      idFromName(name: string) {
        return name;
      },
      get() {
        return { fetch };
      },
    };
  }

  function upgradeRequest(
    origin = "https://mail.example.com",
    cookie = false,
  ): Request {
    return new Request("https://mail.example.com/graphql", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "graphql-transport-ws",
        origin,
        ...(cookie ? { cookie: "mailcal_session=session-secret" } : {}),
      },
    });
  }

  test("returns 503 when the realtime Durable Object binding is absent", async () => {
    const response = await worker.fetch(
      upgradeRequest(),
      harness.env,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
  });

  test("rejects cross-origin upgrades before contacting the Durable Object", async () => {
    let calls = 0;
    const env = {
      ...harness.env,
      MAIL_EVENT_HUB: hubBinding(async () => {
        calls += 1;
        return new Response();
      }),
    } as Env;
    const response = await worker.fetch(
      upgradeRequest("https://evil.example"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("forwards only trusted headers and a server-computed cookie hash", async () => {
    const forwarded: {
      value: { input: string; init: RequestInit | undefined } | null;
    } = { value: null };
    const env = {
      ...harness.env,
      MAIL_EVENT_HUB: hubBinding(async (input, init) => {
        forwarded.value = { input, init };
        return new Response("upgrade", { status: 200 });
      }),
    } as Env;
    const request = new Request(upgradeRequest(undefined, true), {
      headers: new Headers(upgradeRequest(undefined, true).headers),
    });
    request.headers.set("cf-connecting-ip", "203.0.113.9");
    request.headers.set("x-flying-mail-session-token-hash", "forged");
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(200);
    expect(forwarded.value?.input).toBe(
      "https://mail-event-hub.internal/connect",
    );
    const init = forwarded.value?.init;
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual([
      "sec-websocket-protocol",
      "upgrade",
      "x-flying-mail-client-ip",
      "x-flying-mail-session-token-hash",
    ]);
    expect(headers.get("x-flying-mail-client-ip")).toBe("203.0.113.9");
    const built = getBuiltWorkerForTesting(env);
    const expectedHash = await built.deps.tokenHasher.hash("session-secret");
    expect(headers.get("x-flying-mail-session-token-hash")).toBe(expectedHash);
    expect(headers.get("x-flying-mail-session-token-hash")).not.toBe("forged");
    expect(headers.has("cookie")).toBe(false);
  });
});

describe("Worker notifier ownership", () => {
  test("shares one notifier and keeps an in-flight poke alive with waitUntil", async () => {
    const harness = await createWorkerEnv();
    const release: { current: (() => void) | null } = { current: null };
    let called = false;
    const pending = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    const env = {
      ...harness.env,
      MAIL_EVENT_HUB: {
        idFromName(name: string) {
          return name;
        },
        get() {
          return {
            async fetch() {
              called = true;
              await pending;
              return new Response(null, { status: 204 });
            },
          };
        },
      },
    } as Env;
    const built = getBuiltWorkerForTesting(env);
    expect(built.deps.mailEventNotifier).toBe(built.notifier);
    built.deps.mailEventNotifier.notify();
    const promises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
      passThroughOnException() {},
      props: {},
    };
    const response = await worker.fetch(
      new Request("https://mail.example.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(called).toBe(true);
    const settle = promises.at(-1);
    expect(settle).toBeDefined();
    let settled = false;
    void settle?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.current?.();
    await settle;
    expect(settled).toBe(true);
  });
});
