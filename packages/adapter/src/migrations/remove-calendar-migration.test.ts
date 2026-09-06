import type { BlobStore } from "@mailcal/application/ports/blob-store";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import { createMemoryBlobStore } from "../blob/memory";
import { createInMemoryDatabase } from "../sql/libsql";
import { loadMigrationFiles } from "../repositories/test-support";
import { BlobCleanupError, drainBlobCleanupQueue } from "./blob-cleanup";
import { createMigrationRunner, type MigrationFile } from "./runner";

const REMOVE_CALENDAR_MIGRATION = "0012_remove_calendar.sql";
const REMOVED_TABLES = [
  "calendars",
  "calendar_events",
  "event_mentions",
  "event_links",
  "event_attachments",
  "caldav_accounts",
  "caldav_calendars",
  "caldav_event_states",
  "caldav_deletions",
  "user_calendar_permissions",
] as const;

function migrationsThrough0011(): readonly MigrationFile[] {
  return loadMigrationFiles().filter(
    (migration) => migration.name < REMOVE_CALENDAR_MIGRATION,
  );
}

function migration0012(): MigrationFile {
  const migration = loadMigrationFiles().find(
    (candidate) => candidate.name === REMOVE_CALENDAR_MIGRATION,
  );
  if (migration === undefined) {
    throw new Error(`${REMOVE_CALENDAR_MIGRATION} is missing`);
  }
  return migration;
}

async function tableNames(db: SqlDatabase): Promise<readonly string[]> {
  const rows = await db.query<{ readonly name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

async function seedUpgradeFixture(db: SqlDatabase): Promise<void> {
  await db.execute(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
     VALUES ('usr-1', 'owner@example.com', 'Owner', 'ADMIN', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO domains
       (id, name, status, catch_all, verification_token, created_at, updated_at)
     VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'token', '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO messages
       (id, domain_id, direction, thread_id, subject, from_address,
        references_json, body_truncated, snippet, raw_size, delivery_status,
        occurred_at, created_at, updated_at)
     VALUES ('msg-1', 'dom-1', 'INBOUND', 'thread-1', 'Invite',
             'sender@example.com', '[]', 0, '', 0, 'RECEIVED',
             '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z',
             '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
     VALUES ('key-1', 'Migration fixture', 'hash-1', 'mailcal_1',
             '2026-09-06T00:00:00.000Z')`,
  );
  for (const [id, capability] of [
    ["scope-mail", "MAIL_READ"],
    ["scope-template", "TEMPLATE_CREATE"],
    ["scope-contact", "CONTACT_WRITE"],
    ["scope-calendar-read", "CALENDAR_READ"],
    ["scope-calendar-write", "CALENDAR_WRITE"],
  ] as const) {
    await db.execute(
      `INSERT INTO api_key_scopes
         (id, api_key_id, capability, domain_id, address_pattern)
       VALUES (?, 'key-1', ?, NULL, '*')`,
      [id, capability],
    );
  }
  await db.execute(
    `INSERT INTO calendars
       (id, owner_user_id, name, color, created_at, updated_at)
     VALUES ('cal-1', 'usr-1', 'Calendar', '#000000',
             '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO calendar_events
       (id, calendar_id, uid, all_day, start_date, end_date_exclusive,
        range_start_utc, range_end_utc, exdates_json, title, created_at,
        updated_at)
     VALUES ('evt-1', 'cal-1', 'uid-1', 1, '2026-09-06', '2026-09-07',
             1788652800000, 1788739200000, '[]', 'Event',
             '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO attachments
       (id, message_id, file_name, content_type, size, blob_key, created_at)
     VALUES
       ('att-calendar-only', NULL, 'event.pdf', 'application/pdf', 10,
        'att/att-calendar-only/event.pdf', '2026-09-06T00:00:00.000Z'),
       ('att-message-calendar', 'msg-1', 'invite.ics', 'text/calendar', 20,
        'att/att-message-calendar/invite.ics', '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO event_attachments (event_id, attachment_id, position, created_at)
     VALUES
       ('evt-1', 'att-calendar-only', 0, '2026-09-06T00:00:00.000Z'),
       ('evt-1', 'att-message-calendar', 1, '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO file_links
       (id, token_hash, target, attachment_id, expires_at, download_count,
        created_at)
     VALUES
       ('link-calendar-only', 'token-1', 'ATTACHMENT', 'att-calendar-only',
        '2026-09-07T00:00:00.000Z', 0, '2026-09-06T00:00:00.000Z'),
       ('link-message-calendar', 'token-2', 'ATTACHMENT',
        'att-message-calendar', '2026-09-07T00:00:00.000Z', 0,
        '2026-09-06T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO user_calendar_permissions
       (id, user_id, capability, effect, created_by_user_id, created_at)
     VALUES ('ucp-1', 'usr-1', 'CALENDAR_READ', 'ALLOW', 'usr-1',
             '2026-09-06T00:00:00.000Z')`,
  );
}

describe("0012_remove_calendar.sql", () => {
  test("fresh migrations expose no calendar schema or scope values", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());

    const names = await tableNames(db);
    for (const removed of REMOVED_TABLES) {
      expect(names).not.toContain(removed);
    }
    expect(names).toContain("blob_cleanup_queue");
    await db.execute(
      `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
       VALUES ('key-fresh', 'Fresh key', 'hash-fresh', 'mailcal_fresh',
               '2026-09-06T00:00:00.000Z')`,
    );
    await expect(
      db.execute(
        `INSERT INTO api_key_scopes
           (id, api_key_id, capability, domain_id, address_pattern)
         VALUES ('scope-calendar', 'key-fresh', 'CALENDAR_READ', NULL, '*')`,
      ),
    ).rejects.toThrow();
    const scopeTable = await db.query<{ readonly sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_scopes'",
    );
    expect(scopeTable[0]?.sql).not.toContain("CALENDAR_READ");
    expect(scopeTable[0]?.sql).not.toContain("CALENDAR_WRITE");
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("upgrade preserves unrelated scopes and message-backed attachments", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply(migrationsThrough0011());
    await seedUpgradeFixture(db);

    await runner.apply([migration0012()]);

    expect(
      await db.query<{ readonly id: string; readonly capability: string }>(
        "SELECT id, capability FROM api_key_scopes ORDER BY id",
      ),
    ).toEqual([
      { id: "scope-contact", capability: "CONTACT_WRITE" },
      { id: "scope-mail", capability: "MAIL_READ" },
      { id: "scope-template", capability: "TEMPLATE_CREATE" },
    ]);
    expect(
      await db.query<{ readonly id: string }>(
        "SELECT id FROM attachments ORDER BY id",
      ),
    ).toEqual([{ id: "att-message-calendar" }]);
    expect(
      await db.query<{ readonly id: string }>(
        "SELECT id FROM file_links ORDER BY id",
      ),
    ).toEqual([{ id: "link-message-calendar" }]);
    expect(
      await db.query("SELECT attachment_id, blob_key FROM blob_cleanup_queue"),
    ).toEqual([
      {
        attachment_id: "att-calendar-only",
        blob_key: "att/att-calendar-only/event.pdf",
      },
    ]);
    const names = await tableNames(db);
    for (const removed of REMOVED_TABLES) {
      expect(names).not.toContain(removed);
    }
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("blob cleanup is narrowly targeted and idempotent", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply(migrationsThrough0011());
    await seedUpgradeFixture(db);
    await runner.apply([migration0012()]);
    const blobs = createMemoryBlobStore();
    await blobs.put(
      "att/att-calendar-only/event.pdf",
      new TextEncoder().encode("event"),
    );
    await blobs.put(
      "att/att-message-calendar/invite.ics",
      new TextEncoder().encode("invite"),
    );

    expect(await drainBlobCleanupQueue(db, blobs)).toEqual({ deleted: 1 });
    expect(await drainBlobCleanupQueue(db, blobs)).toEqual({ deleted: 0 });
    expect(await blobs.get("att/att-calendar-only/event.pdf")).toBeNull();
    expect(
      await blobs.get("att/att-message-calendar/invite.ics"),
    ).not.toBeNull();
    expect(await db.query("SELECT * FROM blob_cleanup_queue")).toEqual([]);
  });

  test("failed blob deletion retains the queue row for retry", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await db.execute(
      `INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
       VALUES ('att-retry', 'att/att-retry/file.bin',
               '2026-09-06T00:00:00.000Z')`,
    );
    let shouldFail = true;
    const deleted: string[] = [];
    const blobs: BlobStore = {
      async put() {},
      async get() {
        return null;
      },
      async delete(key) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transient object-store failure");
        }
        deleted.push(key);
      },
    };

    await expect(drainBlobCleanupQueue(db, blobs)).rejects.toBeInstanceOf(
      BlobCleanupError,
    );
    expect(
      await db.query("SELECT attachment_id FROM blob_cleanup_queue"),
    ).toEqual([{ attachment_id: "att-retry" }]);
    expect(await drainBlobCleanupQueue(db, blobs)).toEqual({ deleted: 1 });
    expect(deleted).toEqual(["att/att-retry/file.bin"]);
  });
});
