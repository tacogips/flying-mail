import { createMemoryBlobStore } from "@flying-mail/adapter/blob/memory";
import { createInMemoryDatabase } from "@flying-mail/adapter/sql/libsql";
import { createMigrationRunner } from "@flying-mail/adapter/migrations/runner";
import type { BlobStore } from "@flying-mail/application/ports/blob-store";
import { verifyMailDomain } from "@flying-mail/domain/entities/mail-domain";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createBunFetchHandler,
  createLocalApp,
  createNodeFetchHandler,
  detectRuntime,
  drainBlobCleanupQueueWithRetry,
} from "./server";
import { createBunRealtimeHandlers } from "./realtime-bun";
import type {
  BunRealtimeServer,
  BunRealtimeSocket,
  BunRealtimeSocketData,
} from "./realtime-bun";

const ORIGIN = "http://localhost:8787";
const BOOTSTRAP_TOKEN = "server-test-bootstrap-token-with-32-chars";
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const SAMPLE_EML = [
  "From: Sender <sender@other.com>",
  "To: support@example.com",
  "Subject: Local dev message",
  "Message-ID: <local-1@other.com>",
  "Content-Type: text/plain",
  "",
  "Hello from the dev route.",
  "",
].join("\r\n");

describe("detectRuntime", () => {
  test("reports the runtime the suite is running under", () => {
    expect(["bun", "node"]).toContain(detectRuntime());
  });
});

describe("createLocalApp", () => {
  const originalEnv = { ...process.env };
  const temporaryDirectories: string[] = [];

  beforeEach(() => {
    // A throwaway in-memory database per test, so migrations run fresh.
    process.env["FLYING_MAIL_SQLITE_URL"] = ":memory:";
    process.env["FLYING_MAIL_BLOB_BACKEND"] = "memory";
    process.env["FLYING_MAIL_BOOTSTRAP_TOKEN"] = BOOTSTRAP_TOKEN;
    delete process.env["FLYING_MAIL_PUBLIC_ORIGIN"];
    delete process.env["FLYING_MAIL_MAIL_FROM"];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function migrationsWithQueuedBlob(): string {
    const directory = mkdtempSync(join(tmpdir(), "flying-mail-migrations-"));
    temporaryDirectories.push(directory);
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (name.endsWith(".sql")) {
        writeFileSync(
          join(directory, name),
          readFileSync(join(MIGRATIONS_DIR, name)),
        );
      }
    }
    writeFileSync(
      join(directory, "0013_test_blob_cleanup.sql"),
      `INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
       VALUES ('att-local-cleanup', 'att/att-local-cleanup/file.bin',
               '2026-09-06T00:00:00.000Z');`,
    );
    return directory;
  }

  test("applies migrations before serving a request", async () => {
    const { app, deps, realtime } = await createLocalApp();

    expect(realtime.hub).toBeDefined();

    // The schema exists, so a query that depends on it succeeds rather than
    // failing with "no such table".
    const tags = await deps.tagRepository.list();
    expect(tags.length).toBeGreaterThanOrEqual(3);

    const response = await app.request(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  test("Bun fetch branches explicitly around WebSocket upgrades", async () => {
    const { app } = await createLocalApp();
    const fetchSpy = vi.spyOn(app, "fetch");
    const upgrade = vi.fn().mockResolvedValue(undefined);
    const handler = createBunFetchHandler({
      app,
      handlers: {
        upgrade,
        websocket: {
          open: async () => {},
          message: async () => {},
          close: async () => {},
          maxPayloadLength: 65_536,
          idleTimeout: 960,
        },
      },
    });
    const server = {
      requestIP: vi.fn(() => ({ address: "198.51.100.18" })),
      upgrade: vi.fn(() => true),
    };
    const upgradeRequest = new Request(`${ORIGIN}/graphql`, {
      method: "GET",
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "graphql-transport-ws",
      },
    });

    await expect(handler(upgradeRequest, server)).resolves.toBeUndefined();
    expect(upgrade).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();

    upgrade.mockResolvedValueOnce(new Response("failed", { status: 400 }));
    const rejected = await handler(upgradeRequest, server);
    expect(rejected?.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    await handler(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
      server,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual({ clientIp: "198.51.100.18" });
  });

  test("the Node fetch wrapper returns 501 for upgrades and passes other requests through", async () => {
    const { app } = await createLocalApp();
    const fetchSpy = vi.spyOn(app, "fetch");
    const fetch = createNodeFetchHandler(app);
    const upgrade = await fetch(
      new Request(`${ORIGIN}/graphql`, {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "graphql-transport-ws",
        },
      }),
    );
    expect(upgrade.status).toBe(501);
    expect(await upgrade.text()).toBe(
      "WebSocket subscriptions require the Bun or Workers runtime",
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const plain = await fetch(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
      }),
    );
    expect(plain.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test("the in-process host wake binding closes an uninitialized socket after ten seconds", async () => {
    vi.useFakeTimers();
    const local = await createLocalApp();
    const handlers = createBunRealtimeHandlers({
      hub: local.realtime.hub,
      host: local.realtime.host,
      deps: local.deps,
    });
    const server: BunRealtimeServer = {
      requestIP: () => ({ address: "192.0.2.72" }),
      upgrade: (_request, options) => {
        socketData = options.data;
        return true;
      },
    };
    let socketData: BunRealtimeSocketData | null = null;
    const response = await handlers.upgrade(
      new Request(`${ORIGIN}/graphql`, {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "graphql-transport-ws",
        },
      }),
      server,
    );
    expect(response).toBeUndefined();
    if (socketData === null) throw new Error("Upgrade info was not captured");
    const socket: BunRealtimeSocket = {
      data: socketData,
      send: vi.fn(),
      close: vi.fn(),
    };
    await handlers.websocket.open(socket);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(socket.close).toHaveBeenCalledWith(
      4408,
      "Connection initialization timed out",
    );
    await handlers.websocket.close(socket);
  });

  test("seeds the system tags (SPAM retired to message_spam)", async () => {
    const { deps } = await createLocalApp();
    const slugs = (await deps.tagRepository.list())
      .filter((tag) => tag.systemSlug !== null)
      .map((tag) => tag.systemSlug)
      .sort();
    expect(slugs).toEqual(["ARCHIVED", "STARRED", "TRASH"]);
  });

  test("drains the durable blob cleanup queue without blocking app creation", async () => {
    const localApp = await createLocalApp(migrationsWithQueuedBlob());

    await localApp.blobCleanup;

    expect(
      await localApp.deps.db.query("SELECT * FROM blob_cleanup_queue"),
    ).toEqual([]);
  });

  test("the dev inbound route round-trips a raw message", async () => {
    const { app, deps, usecases } = await createLocalApp();

    // The route needs a managed, active domain, exactly like production.
    const { user } = await usecases.bootstrapAdmin({
      email: "admin@example.com",
      name: "Admin",
      token: BOOTSTRAP_TOKEN,
      clientIp: null,
    });
    await expect(
      usecases.bootstrapAdmin({
        email: "second@example.com",
        name: "Second",
        token: BOOTSTRAP_TOKEN,
        clientIp: null,
      }),
    ).rejects.toThrow();
    const viewer = {
      kind: "USER" as const,
      userId: user.id,
      role: user.role,
      permissions: [],
      templatePermissions: [],
    };
    const domain = await usecases.createDomain(viewer, "example.com", true);
    // Activate directly at the repository: verifyDomain now performs a
    // real DNS-over-HTTPS lookup, and a unit test must not touch the
    // network (nor own the example.com zone).
    await deps.mailDomainRepository.save(
      verifyMailDomain(domain, new Date().toISOString()),
    );

    const response = await app.request(
      new Request(
        `${ORIGIN}/dev/inbound?from=sender@other.com&to=support@example.com`,
        { method: "POST", body: SAMPLE_EML },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      kind: string;
      subject: string;
    };
    expect(body.kind).toBe("STORED");
    expect(body.subject).toBe("Local dev message");

    const page = await deps.messageRepository.list(
      { allowedPatterns: null, mailPermissionFilter: null },
      10,
      null,
    );
    expect(page.totalCount).toBe(1);
  });

  test("the dev inbound route rejects an unmanaged recipient", async () => {
    const { app } = await createLocalApp();
    const response = await app.request(
      new Request(
        `${ORIGIN}/dev/inbound?from=sender@other.com&to=someone@unmanaged.com`,
        { method: "POST", body: SAMPLE_EML },
      ),
    );
    expect(response.status).toBe(422);
  });

  test("the dev inbound route requires both envelope parameters", async () => {
    const { app } = await createLocalApp();
    const response = await app.request(
      new Request(`${ORIGIN}/dev/inbound`, {
        method: "POST",
        body: SAMPLE_EML,
      }),
    );
    expect(response.status).toBe(400);
  });

  test("uses app.request client IP env and ignores spoofed IP headers", async () => {
    const { app } = await createLocalApp();
    const responses: Response[] = [];
    for (let call = 0; call < 11; call += 1) {
      responses.push(
        await app.request(
          new Request(`${ORIGIN}/graphql`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "CF-Connecting-IP": `203.0.113.${call + 1}`,
              "X-Forwarded-For": `198.51.100.${call + 1}`,
            },
            body: JSON.stringify({
              query:
                'mutation { requestEmailAuth(email: "person@example.com") }',
            }),
          }),
          undefined,
          { clientIp: "192.0.2.1" },
        ),
      );
    }

    expect(responses).toHaveLength(11);
    for (const response of responses.slice(0, 10)) {
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('"code":"RATE_LIMITED"');
    }
    expect(responses[10]?.status).toBe(200);
    expect(await responses[10]?.text()).toContain('"code":"RATE_LIMITED"');

    const otherAddress = await app.request(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: 'mutation { requestEmailAuth(email: "person@example.com") }',
        }),
      }),
      undefined,
      { clientIp: "192.0.2.2" },
    );
    expect(otherAddress.status).toBe(200);
    expect(await otherAddress.text()).not.toContain('"code":"RATE_LIMITED"');
  });

  test("uses the Node socket peer address as an independent rate limit key", async () => {
    const { app } = await createLocalApp();
    const depleted = { clientIp: "192.0.2.1" };
    for (let call = 0; call < 11; call += 1) {
      await app.request(
        new Request(`${ORIGIN}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: 'mutation { requestEmailAuth(email: "person@example.com") }',
          }),
        }),
        undefined,
        depleted,
      );
    }

    const socketAddress = await app.request(
      new Request(`${ORIGIN}/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Forwarded-For": "198.51.100.10",
        },
        body: JSON.stringify({
          query: 'mutation { requestEmailAuth(email: "person@example.com") }',
        }),
      }),
      undefined,
      { incoming: { socket: { remoteAddress: "192.0.2.3" } } },
    );
    expect(socketAddress.status).toBe(200);
    expect(await socketAddress.text()).not.toContain('"code":"RATE_LIMITED"');
  });
});

describe("drainBlobCleanupQueueWithRetry", () => {
  test("retries a transient failure with bounded exponential backoff", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(
      readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => ({
          name,
          sql: readFileSync(join(MIGRATIONS_DIR, name), "utf-8"),
        })),
    );
    await db.execute(
      `INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
       VALUES ('att-retry', 'att/att-retry/file.bin',
               '2026-09-06T00:00:00.000Z')`,
    );
    const backing = createMemoryBlobStore();
    await backing.put("att/att-retry/file.bin", new Uint8Array([1]));
    let deleteAttempts = 0;
    const blobs: BlobStore = {
      put: (key, body, options) => backing.put(key, body, options),
      get: (key) => backing.get(key),
      async delete(key) {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("transient object-store failure");
        }
        await backing.delete(key);
      },
    };
    const delays: number[] = [];

    await drainBlobCleanupQueueWithRetry(db, blobs, {
      maxAttempts: 3,
      baseDelayMs: 5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(deleteAttempts).toBe(2);
    expect(delays).toEqual([5]);
    expect(await backing.get("att/att-retry/file.bin")).toBeNull();
    expect(await db.query("SELECT * FROM blob_cleanup_queue")).toEqual([]);
  });

  test("stops after the configured attempt bound and leaves work durable", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(
      readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => ({
          name,
          sql: readFileSync(join(MIGRATIONS_DIR, name), "utf-8"),
        })),
    );
    await db.execute(
      `INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
       VALUES ('att-bounded', 'att/att-bounded/file.bin',
               '2026-09-06T00:00:00.000Z')`,
    );
    let deleteAttempts = 0;
    const blobs: BlobStore = {
      async put() {},
      async get() {
        return null;
      },
      async delete() {
        deleteAttempts += 1;
        throw new Error("persistent object-store failure");
      },
    };
    const delays: number[] = [];

    await expect(
      drainBlobCleanupQueueWithRetry(db, blobs, {
        maxAttempts: 3,
        baseDelayMs: 5,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toThrow("Failed to delete 1 queued blob object(s)");

    expect(deleteAttempts).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(
      await db.query("SELECT attachment_id FROM blob_cleanup_queue"),
    ).toEqual([{ attachment_id: "att-bounded" }]);
  });
});
