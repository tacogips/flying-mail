import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import { createInMemoryDatabase } from "../sql/libsql";
import { loadMigrationFiles } from "../repositories/test-support";
import { createMigrationRunner } from "./runner";

const USER_ADMIN_MIGRATION = "0017_user_admin_capability.sql";
const LEGACY_CAPABILITIES = [
  "MAIL_READ",
  "MAIL_SEND",
  "MAIL_MANAGE",
  "FILE_LINK",
  "DOMAIN_ADMIN",
  "KEY_ADMIN",
  "TEMPLATE_READ",
  "TEMPLATE_CREATE",
  "TEMPLATE_UPDATE",
  "TEMPLATE_DELETE",
  "CONTACT_READ",
  "CONTACT_WRITE",
] as const;

async function insertFixture(db: SqlDatabase): Promise<void> {
  await db.execute(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
     VALUES ('usr-1', 'owner@example.com', 'Owner', 'ADMIN', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO domains
       (id, name, status, catch_all, verification_token, created_at, updated_at)
     VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'token', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')`,
  );
  await db.execute(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_by_user_id, created_at)
     VALUES ('key-1', 'Migration fixture', 'hash-1', 'key-prefix-1', 'usr-1', '2026-10-08T00:00:00.000Z')`,
  );

  for (const capability of LEGACY_CAPABILITIES) {
    const domainId = capability === "MAIL_READ" ? "dom-1" : null;
    const addressPattern =
      capability === "MAIL_READ" ? "support@example.com" : "*";
    await db.execute(
      `INSERT INTO api_key_scopes
         (id, api_key_id, capability, domain_id, address_pattern)
       VALUES (?, 'key-1', ?, ?, ?)`,
      [
        `scope-${capability.toLowerCase()}`,
        capability,
        domainId,
        addressPattern,
      ],
    );
  }
}

describe("0017_user_admin_capability.sql", () => {
  test("preserves scopes, widens the CHECK and keeps the index and cascades", async () => {
    const db = createInMemoryDatabase();
    await db.execute("PRAGMA foreign_keys = ON");
    const runner = createMigrationRunner(db);
    const migrations = loadMigrationFiles();
    await runner.apply(
      migrations.filter((migration) => migration.name < USER_ADMIN_MIGRATION),
    );
    await insertFixture(db);

    const expectedRows = await db.query<{
      readonly id: string;
      readonly api_key_id: string;
      readonly capability: string;
      readonly domain_id: string | null;
      readonly address_pattern: string;
    }>(
      `SELECT id, api_key_id, capability, domain_id, address_pattern
       FROM api_key_scopes ORDER BY id`,
    );

    const migration = migrations.find(
      (candidate) => candidate.name === USER_ADMIN_MIGRATION,
    );
    expect(migration).toBeDefined();
    await runner.apply(migration === undefined ? [] : [migration]);

    const rowQuery = `SELECT id, api_key_id, capability, domain_id, address_pattern
                      FROM api_key_scopes ORDER BY id`;
    expect(await db.query(rowQuery)).toEqual(expectedRows);

    await db.execute(
      `INSERT INTO api_key_scopes (id, api_key_id, capability)
       VALUES ('scope-user-admin', 'key-1', 'USER_ADMIN')`,
    );
    await expect(
      db.execute(
        `INSERT INTO api_key_scopes (id, api_key_id, capability)
         VALUES ('scope-bogus', 'key-1', 'BOGUS')`,
      ),
    ).rejects.toThrow();

    expect(
      await db.query<{ readonly name: string; readonly tbl_name: string }>(
        `SELECT name, tbl_name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_api_key_scopes_key'`,
      ),
    ).toEqual([{ name: "idx_api_key_scopes_key", tbl_name: "api_key_scopes" }]);

    await db.execute("DELETE FROM domains WHERE id = 'dom-1'");
    expect(
      await db.query<{ readonly id: string }>(
        "SELECT id FROM api_key_scopes WHERE id = 'scope-mail_read'",
      ),
    ).toEqual([]);

    await db.execute("DELETE FROM api_keys WHERE id = 'key-1'");
    expect(await db.query("SELECT id FROM api_key_scopes")).toEqual([]);
  });
});
