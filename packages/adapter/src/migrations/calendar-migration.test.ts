import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import { loadMigrationFiles } from "../repositories/test-support";
import { createInMemoryDatabase } from "../sql/libsql";
import { createMigrationRunner, type MigrationFile } from "./runner";

/** `0006_calendar.sql` rebuilds `api_key_scopes`, which live mail
 * authorization depends on. These tests assert the rebuild is lossless on a
 * database that already holds scope rows -- the failure mode being silently
 * revoked mail keys on the first deploy after the calendar release. */

const CALENDAR_MIGRATION = "0006_calendar.sql";

function migrationsUpToFive(): readonly MigrationFile[] {
  return loadMigrationFiles().filter(
    (migration) => migration.name < CALENDAR_MIGRATION,
  );
}

function calendarMigration(): MigrationFile {
  const found = loadMigrationFiles().find(
    (migration) => migration.name === CALENDAR_MIGRATION,
  );
  if (found === undefined) {
    throw new Error(`${CALENDAR_MIGRATION} is missing`);
  }
  return found;
}

async function tableNames(db: SqlDatabase): Promise<readonly string[]> {
  const rows = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

async function seedKeyWithScopes(db: SqlDatabase): Promise<void> {
  await db.execute(
    `INSERT INTO domains
       (id, name, status, catch_all, verification_token, verified_at, created_at, updated_at)
     VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'tok', '2026-08-23T00:00:00.000Z',
             '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
     VALUES ('key-1', 'agent', 'hash-1', 'ybm_key1', '2026-08-23T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
     VALUES ('scope-1', 'key-1', 'MAIL_READ', 'dom-1', 'support@example.com')`,
  );
  await db.execute(
    `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
     VALUES ('scope-2', 'key-1', 'KEY_ADMIN', NULL, '*')`,
  );
}

describe("0006_calendar.sql", () => {
  test("copies existing api_key_scopes rows verbatim", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply(migrationsUpToFive());
    await seedKeyWithScopes(db);

    const before = await db.query<Record<string, unknown>>(
      "SELECT id, api_key_id, capability, domain_id, address_pattern FROM api_key_scopes ORDER BY id",
    );

    // Only 0001..0006 are applied here: the rebuild has to be lossless on
    // its own, independently of whatever later migrations happen to do.
    const { applied } = await runner.apply([
      ...migrationsUpToFive(),
      calendarMigration(),
    ]);
    expect(applied).toEqual([CALENDAR_MIGRATION]);

    const after = await db.query<Record<string, unknown>>(
      "SELECT id, api_key_id, capability, domain_id, address_pattern FROM api_key_scopes ORDER BY id",
    );
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
  });

  test("widens the capability CHECK to admit calendar scopes", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedKeyWithScopes(db);

    await db.execute(
      `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
       VALUES ('scope-3', 'key-1', 'CALENDAR_READ', NULL, 'taco@example.com')`,
    );
    await db.execute(
      `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
       VALUES ('scope-4', 'key-1', 'CALENDAR_WRITE', NULL, '*')`,
    );
    const rows = await db.query<{ capability: string }>(
      "SELECT capability FROM api_key_scopes WHERE id IN ('scope-3','scope-4') ORDER BY id",
    );
    expect(rows.map((row) => row.capability)).toEqual([
      "CALENDAR_READ",
      "CALENDAR_WRITE",
    ]);

    await expect(
      db.execute(
        `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
         VALUES ('scope-5', 'key-1', 'NOT_A_CAPABILITY', NULL, '*')`,
      ),
    ).rejects.toThrow();
  });

  test("keeps the api_key_scopes lookup index", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_key_scopes'",
    );
    expect(rows.map((row) => row.name)).toContain("idx_api_key_scopes_key");
  });

  test("creates every calendar table", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    const names = await tableNames(db);
    for (const table of [
      "calendars",
      "calendar_events",
      "event_mentions",
      "event_links",
      "event_attachments",
      "caldav_accounts",
      "caldav_calendars",
      "caldav_event_states",
      "caldav_deletions",
    ]) {
      expect(names).toContain(table);
    }
    expect(names).not.toContain("api_key_scopes_new");
  });

  test("enforces the timed/all-day column exclusivity CHECK", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await db.execute(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('usr-1', 'taco@example.com', 'Taco', 'ADMIN',
               '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO calendars (id, owner_user_id, name, color, created_at, updated_at)
       VALUES ('cal-1', 'usr-1', 'Work', '#3b82f6',
               '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    );

    await expect(
      db.execute(
        `INSERT INTO calendar_events
           (id, calendar_id, uid, all_day, starts_at, ends_at, time_zone,
            start_date, end_date_exclusive, range_start_utc, range_end_utc,
            title, created_at, updated_at)
         VALUES ('evt-bad', 'cal-1', 'uid-bad', 0, 1, 2, 'UTC',
                 '2026-09-01', '2026-09-02', 1, 2, 'Broken',
                 '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
      ),
    ).rejects.toThrow();
  });

  test("scopes UID uniqueness per calendar, NULL instance start included", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await db.execute(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('usr-1', 'taco@example.com', 'Taco', 'ADMIN',
               '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    );
    for (const id of ["cal-1", "cal-2"]) {
      await db.execute(
        `INSERT INTO calendars (id, owner_user_id, name, color, created_at, updated_at)
         VALUES (?, 'usr-1', 'Work', '#3b82f6',
                 '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
        [id],
      );
    }
    const insert = (id: string, calendarId: string): Promise<unknown> =>
      db.execute(
        `INSERT INTO calendar_events
           (id, calendar_id, uid, all_day, starts_at, ends_at, time_zone,
            range_start_utc, range_end_utc, title, created_at, updated_at)
         VALUES (?, ?, 'shared-uid', 0, 1, 2, 'UTC', 1, 2, 'Event',
                 '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
        [id, calendarId],
      );

    await insert("evt-1", "cal-1");
    // Same UID in a different calendar is fine -- UID identity is per
    // collection in CalDAV.
    await insert("evt-2", "cal-2");
    await expect(insert("evt-3", "cal-1")).rejects.toThrow();
  });
});
