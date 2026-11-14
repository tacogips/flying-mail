import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import { loadMigrationFiles } from "../repositories/test-support";
import { createInMemoryDatabase } from "../sql/libsql";
import { createMigrationRunner, type MigrationFile } from "./runner";

/** `0007_mail_templates.sql` rebuilds `api_key_scopes` for the third time.
 * These tests assert the rebuild is lossless on a database that already
 * holds mail *and* calendar scopes -- the failure mode being silently
 * revoked keys on the first deploy after the templates release. */

const TEMPLATE_MIGRATION = "0007_mail_templates.sql";
const TS = "2026-08-23T00:00:00.000Z";

function migrationsBeforeTemplates(): readonly MigrationFile[] {
  return loadMigrationFiles().filter(
    (migration) => migration.name < TEMPLATE_MIGRATION,
  );
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
     VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'tok', ?, ?, ?)`,
    [TS, TS, TS],
  );
  await db.execute(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
     VALUES ('key-1', 'agent', 'hash-1', 'ybm_key1', ?)`,
    [TS],
  );
  for (const [id, capability, domainId, pattern] of [
    ["scope-1", "MAIL_READ", "dom-1", "support@example.com"],
    ["scope-2", "KEY_ADMIN", null, "*"],
    ["scope-3", "CALENDAR_WRITE", null, "taco@example.com"],
  ] as const) {
    await db.execute(
      `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
       VALUES (?, 'key-1', ?, ?, ?)`,
      [id, capability, domainId, pattern],
    );
  }
}

async function seedUser(db: SqlDatabase, id: string): Promise<void> {
  await db.execute(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
     VALUES (?, ?, 'Test User', 'ADMIN', ?, ?)`,
    [id, `${id}@example.com`, TS, TS],
  );
}

async function seedTemplate(db: SqlDatabase, id: string): Promise<void> {
  await db.execute(
    `INSERT INTO mail_templates
       (id, name, subject, text_body, created_at, updated_at)
     VALUES (?, ?, 'Hi', 'body', ?, ?)`,
    [id, id, TS, TS],
  );
}

describe("0007_mail_templates.sql", () => {
  test("copies existing api_key_scopes rows verbatim", async () => {
    const db = createInMemoryDatabase();
    const runner = createMigrationRunner(db);
    await runner.apply(migrationsBeforeTemplates());
    await seedKeyWithScopes(db);

    const columns = "id, api_key_id, capability, domain_id, address_pattern";
    const before = await db.query<Record<string, unknown>>(
      `SELECT ${columns} FROM api_key_scopes ORDER BY id`,
    );

    const { applied } = await runner.apply(loadMigrationFiles());
    expect(applied).toContain(TEMPLATE_MIGRATION);

    const after = await db.query<Record<string, unknown>>(
      `SELECT ${columns} FROM api_key_scopes ORDER BY id`,
    );
    expect(after).toEqual(before);
    expect(after).toHaveLength(3);
  });

  test("widens the capability CHECK to admit template scopes", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedKeyWithScopes(db);

    for (const [id, capability] of [
      ["scope-t1", "TEMPLATE_READ"],
      ["scope-t2", "TEMPLATE_CREATE"],
      ["scope-t3", "TEMPLATE_UPDATE"],
      ["scope-t4", "TEMPLATE_DELETE"],
    ] as const) {
      await db.execute(
        `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
         VALUES (?, 'key-1', ?, NULL, '*')`,
        [id, capability],
      );
    }
    const rows = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM api_key_scopes WHERE capability LIKE 'TEMPLATE_%'",
    );
    expect(rows[0]?.count).toBe(4);

    await expect(
      db.execute(
        `INSERT INTO api_key_scopes (id, api_key_id, capability, domain_id, address_pattern)
         VALUES ('scope-bad', 'key-1', 'TEMPLATE_EVERYTHING', NULL, '*')`,
      ),
    ).rejects.toThrow();
  });

  test("keeps the api_key_scopes lookup index and drops the scratch table", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_key_scopes'",
    );
    expect(indexes.map((row) => row.name)).toContain("idx_api_key_scopes_key");
    expect(await tableNames(db)).not.toContain("api_key_scopes_new");
  });

  test("creates every template table", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    const names = await tableNames(db);
    for (const table of [
      "mail_templates",
      "mail_template_variables",
      "user_template_permissions",
    ]) {
      expect(names).toContain(table);
    }
  });

  test("requires at least one body", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await expect(
      db.execute(
        `INSERT INTO mail_templates (id, name, subject, created_at, updated_at)
         VALUES ('tpl-bad', 'No body', 'Hi', ?, ?)`,
        [TS, TS],
      ),
    ).rejects.toThrow();
  });

  test("enforces a case-insensitively unique template name", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedTemplate(db, "Invoice");
    await expect(
      db.execute(
        `INSERT INTO mail_templates (id, name, subject, text_body, created_at, updated_at)
         VALUES ('tpl-2', 'INVOICE', 'Hi', 'body', ?, ?)`,
        [TS, TS],
      ),
    ).rejects.toThrow();
  });

  test("enforces one variable per key and cascades on template delete", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedTemplate(db, "tpl-1");
    const insertVariable = (id: string): Promise<unknown> =>
      db.execute(
        `INSERT INTO mail_template_variables
           (id, template_id, key, label, type, required, position)
         VALUES (?, 'tpl-1', 'customerName', 'Customer', 'TEXT', 1, 0)`,
        [id],
      );
    await insertVariable("var-1");
    await expect(insertVariable("var-2")).rejects.toThrow();

    await db.execute("DELETE FROM mail_templates WHERE id = 'tpl-1'");
    const remaining = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM mail_template_variables",
    );
    expect(remaining[0]?.count).toBe(0);
  });

  test("allows one rule per (user, capability) and no more", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedUser(db, "usr-1");
    const insertRule = (id: string, effect: string): Promise<unknown> =>
      db.execute(
        `INSERT INTO user_template_permissions
           (id, user_id, capability, effect, created_by_user_id, created_at)
         VALUES (?, 'usr-1', 'TEMPLATE_CREATE', ?, 'usr-1', ?)`,
        [id, effect, TS],
      );
    await insertRule("rule-1", "ALLOW");
    await expect(insertRule("rule-2", "DENY")).rejects.toThrow();
  });

  test("rejects a non-template capability in a template rule", async () => {
    const db = createInMemoryDatabase();
    await createMigrationRunner(db).apply(loadMigrationFiles());
    await seedUser(db, "usr-1");
    await expect(
      db.execute(
        `INSERT INTO user_template_permissions
           (id, user_id, capability, effect, created_by_user_id, created_at)
         VALUES ('rule-1', 'usr-1', 'MAIL_SEND', 'ALLOW', 'usr-1', ?)`,
        [TS],
      ),
    ).rejects.toThrow();
  });
});
