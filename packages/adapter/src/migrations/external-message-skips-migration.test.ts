import { describe, expect, test } from "vitest";
import { loadMigrationFiles } from "../repositories/test-support";
import { createInMemoryDatabase } from "../sql/libsql";
import { createMigrationRunner } from "./runner";

const SKIPS_MIGRATION = "0018_external_message_skips.sql";

describe("0018_external_message_skips.sql", () => {
  test("keeps existing ledger rows, allows skipped rows and keeps the cascade", async () => {
    const db = createInMemoryDatabase();
    await db.execute("PRAGMA foreign_keys = ON");
    const runner = createMigrationRunner(db);
    const migrations = loadMigrationFiles();
    await runner.apply(
      migrations.filter((migration) => migration.name < SKIPS_MIGRATION),
    );

    await db.execute(
      `INSERT INTO domains
         (id, name, status, catch_all, verification_token, created_at, updated_at)
       VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'tok', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO mail_addresses (id, domain_id, local_part, address, status, created_at, updated_at)
       VALUES ('addr-1', 'dom-1', 'support', 'support@example.com', 'ACTIVE', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO external_mail_accounts
         (id, mail_address_id, external_address, fetch_kind, fetch_config,
          fetch_password_ciphertext, status, created_at, updated_at)
       VALUES ('acc-1', 'addr-1', 'me@gmail.com', 'JMAP', '{}', 'cipher',
          'ACTIVE', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')`,
    );
    await db.execute(
      `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at)
       VALUES ('acc-1', 'old', 'msg-old', '2026-10-08T00:00:00.000Z')`,
    );

    const migration = migrations.find(
      (candidate) => candidate.name === SKIPS_MIGRATION,
    );
    expect(migration).toBeDefined();
    await runner.apply(migration === undefined ? [] : [migration]);

    expect(
      await db.query(
        "SELECT account_id, remote_id, message_id, skip_reason FROM external_message_states",
      ),
    ).toEqual([
      {
        account_id: "acc-1",
        remote_id: "old",
        message_id: "msg-old",
        skip_reason: null,
      },
    ]);

    await db.execute(
      `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at, skip_reason)
       VALUES ('acc-1', 'big', NULL, '2026-10-09T00:00:00.000Z', 'TOO_LARGE')`,
    );
    // A row must be either a fetched message or a skip, never both or neither.
    await expect(
      db.execute(
        `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at, skip_reason)
         VALUES ('acc-1', 'bad1', NULL, '2026-10-09T00:00:00.000Z', NULL)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        `INSERT INTO external_message_states (account_id, remote_id, message_id, fetched_at, skip_reason)
         VALUES ('acc-1', 'bad2', 'msg-x', '2026-10-09T00:00:00.000Z', 'TOO_LARGE')`,
      ),
    ).rejects.toThrow();

    await db.execute("DELETE FROM external_mail_accounts WHERE id = 'acc-1'");
    expect(await db.query("SELECT * FROM external_message_states")).toEqual([]);
  });
});
