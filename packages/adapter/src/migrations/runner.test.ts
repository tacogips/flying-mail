import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import { createInMemoryDatabase } from "../sql/libsql";
import { loadMigrationFiles } from "../repositories/test-support";
import { createMigrationRunner, type MigrationFile } from "./runner";

const simple: readonly MigrationFile[] = [
  { name: "0001_a.sql", sql: "CREATE TABLE a (id TEXT PRIMARY KEY);" },
  { name: "0002_b.sql", sql: "CREATE TABLE b (id TEXT PRIMARY KEY);" },
];

async function tableNames(db: SqlDatabase): Promise<readonly string[]> {
  const rows = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return rows.map((row) => row.name);
}

describe("createMigrationRunner", () => {
  test("applies pending migrations and records them", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    const { applied } = await runner.apply(simple);
    expect(applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(await tableNames(db)).toContain("a");
    expect(await tableNames(db)).toContain("b");
  });

  test("re-applying is a no-op", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply(simple);
    expect((await runner.apply(simple)).applied).toEqual([]);
  });

  test("applies only the newly added migration", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply([simple[0] as MigrationFile]);
    expect((await runner.apply(simple)).applied).toEqual(["0002_b.sql"]);
  });

  test("applies in name order regardless of input order", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    const { applied } = await runner.apply([
      simple[1] as MigrationFile,
      simple[0] as MigrationFile,
    ]);
    expect(applied).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  test("a failing migration is rolled back and rethrown", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await expect(
      runner.apply([
        {
          name: "0001_bad.sql",
          sql: "CREATE TABLE ok (id TEXT); THIS IS NOT SQL;",
        },
      ]),
    ).rejects.toThrow();
    expect(await tableNames(db)).not.toContain("ok");
  });

  test("concurrent runners converge without error", async () => {
    const db = createInMemoryDatabase();
    const [first, second] = await Promise.all([
      createMigrationRunner(db).apply(simple),
      createMigrationRunner(db).apply(simple),
    ]);
    // Exactly one runner claims each migration; neither throws.
    const claimed = [...first.applied, ...second.applied].sort();
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(await tableNames(db)).toContain("a");
  });

  /** The splitter in `runner.ts` has no awareness of comments or string
   * literals, so a `;` written inside either silently cuts a statement in
   * half -- and the resulting failure ("not an error") points nowhere near
   * the real cause. Cheaper to forbid it outright than to debug it twice. */
  test("no migration writes a statement terminator inside a comment", () => {
    const offenders: string[] = [];
    for (const migration of loadMigrationFiles()) {
      migration.sql.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("--") && trimmed.includes(";")) {
          offenders.push(`${migration.name}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("applies the real production migrations cleanly", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    const { applied } = await runner.apply(loadMigrationFiles());
    expect(applied).toEqual([
      "0001_init.sql",
      "0002_system_tags.sql",
      "0003_attachment_kind.sql",
      "0004_spam_status_events.sql",
      "0005_user_mail_permissions.sql",
      "0006_calendar.sql",
      "0007_mail_templates.sql",
      "0008_user_calendar_permissions.sql",
      "0009_mail_addresses.sql",
    ]);

    const names = await tableNames(db);
    for (const expected of [
      "users",
      "sessions",
      "email_auth_challenges",
      "domains",
      "messages",
      "message_recipients",
      "attachments",
      "tags",
      "message_tags",
      "api_keys",
      "api_key_scopes",
      "message_fetch_states",
      "file_links",
      "user_mail_permissions",
    ]) {
      expect(names).toContain(expected);
    }

    const systemTags = await db.query<{ system_slug: string }>(
      "SELECT system_slug FROM tags WHERE kind = 'SYSTEM' ORDER BY system_slug",
    );
    // SPAM is deliberately absent: migration 0004 retires the spam tag in
    // favour of the message_spam table.
    expect(systemTags.map((row) => row.system_slug)).toEqual([
      "ARCHIVED",
      "STARRED",
      "TRASH",
    ]);
  });

  test("upgrades populated users to VIEWER without losing dependent rows", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    const migrations = loadMigrationFiles();
    await runner.apply(
      migrations.filter(
        (migration) => migration.name !== "0005_user_mail_permissions.sql",
      ),
    );

    await db.execute(
      `INSERT INTO users
         (id, email, name, role, created_at, updated_at)
       VALUES ('usr-admin', 'admin@example.com', 'Admin', 'ADMIN',
               '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
       VALUES ('ses-1', 'session-hash', 'usr-admin',
               '2026-08-24T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO api_keys
         (id, name, key_hash, key_prefix, created_by_user_id, created_at)
       VALUES ('key-1', 'Agent', 'key-hash', 'yb_key', 'usr-admin',
               '2026-08-23T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO api_key_scopes
         (id, api_key_id, capability, domain_id, address_pattern)
       VALUES ('scope-1', 'key-1', 'MAIL_READ', NULL, '*')`,
    );

    await runner.apply(
      migrations.filter(
        (migration) => migration.name === "0005_user_mail_permissions.sql",
      ),
    );

    await db.execute(
      `INSERT INTO users
         (id, email, name, role, created_at, updated_at)
       VALUES ('usr-viewer', 'viewer@example.com', 'Viewer', 'VIEWER',
               '2026-08-23T01:00:00.000Z', '2026-08-23T01:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO user_mail_permissions
         (id, user_id, effect, domain_id, address_pattern,
          created_by_user_id, created_at)
       VALUES ('ump-1', 'usr-viewer', 'ALLOW', NULL, 'support@example.com',
               'usr-admin', '2026-08-23T01:00:00.000Z')`,
    );

    expect(await db.query<{ id: string }>("SELECT id FROM sessions")).toEqual([
      { id: "ses-1" },
    ]);
    expect(await db.query<{ id: string }>("SELECT id FROM api_keys")).toEqual([
      { id: "key-1" },
    ]);
    expect(
      await db.query<{ id: string }>("SELECT id FROM api_key_scopes"),
    ).toEqual([{ id: "scope-1" }]);
    expect(
      await db.query<{ role: string }>(
        "SELECT role FROM users WHERE id = 'usr-viewer'",
      ),
    ).toEqual([{ role: "VIEWER" }]);
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
    await expect(
      db.execute(
        `INSERT INTO user_mail_permissions
           (id, user_id, effect, domain_id, address_pattern,
            created_by_user_id, created_at)
         VALUES ('ump-bad', 'usr-viewer', 'UNKNOWN', NULL, '*',
                 'usr-admin', '2026-08-23T01:00:00.000Z')`,
      ),
    ).rejects.toThrow();
  });

  test("the real migrations create their indexes", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
    );
    const names = rows.map((row) => row.name);
    for (const expected of [
      "idx_messages_listing",
      "idx_recipients_address",
      "idx_fetch_states_key",
      "idx_file_links_token",
      "idx_api_keys_key_hash",
      "idx_user_mail_permissions_user",
      "idx_user_mail_permissions_domain",
      "idx_user_mail_permissions_rule",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
