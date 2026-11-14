import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { describe, expect, test } from "vitest";
import {
  loadMigrationFiles,
  seedDomain,
  seedMailAddress,
} from "../repositories/test-support";
import { createInMemoryDatabase } from "../sql/libsql";
import { createMigrationRunner } from "./runner";

/** `0011_external_mail.sql` shape tests: table/index presence, the `CHECK`
 * constraints on `fetch_kind`/`status`, the "one external account per
 * managed address" unique index, and both cascade-delete edges. */

const DOMAIN_ID = "dom-1";
const MAIL_ADDRESS_ID = "addr-1";

async function migratedDb(): Promise<SqlDatabase> {
  const db = createInMemoryDatabase();
  await createMigrationRunner(db).apply(loadMigrationFiles());
  await seedDomain(db, { id: DOMAIN_ID, name: "example.com" });
  await seedMailAddress(db, {
    id: MAIL_ADDRESS_ID,
    domainId: DOMAIN_ID,
    localPart: "support",
    address: "support@example.com",
  });
  return db;
}

async function insertAccount(
  db: SqlDatabase,
  overrides: {
    readonly id?: string;
    readonly mailAddressId?: string;
    readonly fetchKind?: string;
    readonly status?: string;
  } = {},
): Promise<void> {
  await db.execute(
    `INSERT INTO external_mail_accounts
       (id, mail_address_id, external_address, display_name, fetch_kind,
        fetch_config, fetch_password_ciphertext, smtp_config,
        smtp_password_ciphertext, status, last_fetched_at, created_at, updated_at)
     VALUES (?, ?, 'taco@gmail.com', NULL, ?, '{}', 'cipher', NULL, NULL, ?,
             NULL, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
    [
      overrides.id ?? "acc-1",
      overrides.mailAddressId ?? MAIL_ADDRESS_ID,
      overrides.fetchKind ?? "JMAP",
      overrides.status ?? "ACTIVE",
    ],
  );
}

describe("0011_external_mail.sql", () => {
  test("creates both tables and their indexes", async () => {
    const db = await migratedDb();
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((row) => row.name);
    expect(names).toContain("external_mail_accounts");
    expect(names).toContain("external_message_states");

    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    );
    const indexNames = indexes.map((row) => row.name);
    expect(indexNames).toContain("idx_external_mail_accounts_mail_address");
    expect(indexNames).toContain("idx_external_message_states_message");
  });

  test("enforces the fetch_kind CHECK", async () => {
    const db = await migratedDb();
    await insertAccount(db, { fetchKind: "POP3" });
    await expect(
      insertAccount(db, { id: "acc-bad", fetchKind: "IMAP" }),
    ).rejects.toThrow();
  });

  test("enforces the status CHECK", async () => {
    const db = await migratedDb();
    await insertAccount(db, { status: "DISABLED" });
    await expect(
      insertAccount(db, { id: "acc-bad", status: "PENDING" }),
    ).rejects.toThrow();
  });

  test("at most one external account per managed mail address", async () => {
    const db = await migratedDb();
    await insertAccount(db, { id: "acc-1" });
    await expect(insertAccount(db, { id: "acc-2" })).rejects.toThrow();
  });

  test("deleting a mail address cascades to its external account", async () => {
    const db = await migratedDb();
    await insertAccount(db);
    await db.execute("DELETE FROM mail_addresses WHERE id = ?", [
      MAIL_ADDRESS_ID,
    ]);
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM external_mail_accounts",
    );
    expect(rows).toEqual([]);
  });

  test("deleting an external account cascades to its message states", async () => {
    const db = await migratedDb();
    await insertAccount(db);
    await db.execute(
      `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at)
       VALUES ('acc-1', 'remote-1', 'msg-1', '2026-08-24T00:00:00.000Z')`,
    );
    await db.execute("DELETE FROM external_mail_accounts WHERE id = 'acc-1'");
    const rows = await db.query<{ account_id: string }>(
      "SELECT account_id FROM external_message_states",
    );
    expect(rows).toEqual([]);
  });

  test("the message-state primary key rejects a duplicate (account_id, remote_id)", async () => {
    const db = await migratedDb();
    await insertAccount(db);
    await db.execute(
      `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at)
       VALUES ('acc-1', 'remote-1', 'msg-1', '2026-08-24T00:00:00.000Z')`,
    );
    await expect(
      db.execute(
        `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at)
         VALUES ('acc-1', 'remote-1', 'msg-2', '2026-08-24T01:00:00.000Z')`,
      ),
    ).rejects.toThrow();
  });
});
