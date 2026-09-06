import { createMemoryBlobStore } from "@mailcal/adapter/blob/memory";
import { createInMemoryDatabase } from "@mailcal/adapter/sql/libsql";
import { createMigrationRunner } from "@mailcal/adapter/migrations/runner";
import type { BlobStore } from "@mailcal/application/ports/blob-store";
import { verifyMailDomain } from "@mailcal/domain/entities/mail-domain";
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createLocalApp,
  detectRuntime,
  drainBlobCleanupQueueWithRetry,
} from "./server";

const ORIGIN = "http://localhost:8787";
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
    process.env["MAILCAL_SQLITE_URL"] = ":memory:";
    process.env["MAILCAL_BLOB_BACKEND"] = "memory";
    delete process.env["MAILCAL_PUBLIC_ORIGIN"];
    delete process.env["MAILCAL_MAIL_FROM"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function migrationsWithQueuedBlob(): string {
    const directory = mkdtempSync(join(tmpdir(), "mailcal-migrations-"));
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
    const { app, deps } = await createLocalApp();

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
    const { user } = await usecases.bootstrapAdmin(
      "admin@example.com",
      "Admin",
    );
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
