import type { MailAddressRepository } from "@mailcal/application/ports/mail-address-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type MailAddress,
  MailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createMailAddressId,
  createUserId,
  type MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface MailAddressRow {
  readonly id: string;
  readonly domain_id: string;
  readonly local_part: string;
  readonly address: string;
  readonly display_name: string | null;
  readonly status: string;
  readonly created_by_user_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToMailAddress(row: MailAddressRow): MailAddress {
  return {
    id: createMailAddressId(row.id),
    domainId: createDomainId(row.domain_id),
    localPart: row.local_part,
    address: createEmailAddress(row.address, "address"),
    displayName: row.display_name,
    status: assertEnumValue(
      MailAddressStatus,
      row.status,
      "mail address status",
    ),
    createdByUserId:
      row.created_by_user_id === null
        ? null
        : createUserId(row.created_by_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The local part is immutable by design (see `renameMailAddress`), so the
 * upsert deliberately does not touch `local_part`, `address` or
 * `domain_id` -- only the mutable label and status. */
const UPSERT_SQL = `INSERT INTO mail_addresses
  (id, domain_id, local_part, address, display_name, status,
   created_by_user_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name,
    status = excluded.status,
    updated_at = excluded.updated_at`;

export function createMailAddressRepository(
  db: SqlDatabase,
): MailAddressRepository {
  return {
    async findById(id) {
      const rows = await db.query<MailAddressRow>(
        "SELECT * FROM mail_addresses WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToMailAddress(rows[0]);
    },

    /** Addresses are stored already normalized, so this is a plain indexed
     * equality match -- it runs on every inbound message. */
    async findByAddress(address) {
      const rows = await db.query<MailAddressRow>(
        "SELECT * FROM mail_addresses WHERE address = ?",
        [address.trim().toLowerCase()],
      );
      return rows[0] === undefined ? null : rowToMailAddress(rows[0]);
    },

    async listByDomain(domainId) {
      const rows = await db.query<MailAddressRow>(
        "SELECT * FROM mail_addresses WHERE domain_id = ? ORDER BY local_part ASC",
        [domainId],
      );
      return rows.map(rowToMailAddress);
    },

    async list() {
      const rows = await db.query<MailAddressRow>(
        "SELECT * FROM mail_addresses ORDER BY address ASC",
      );
      return rows.map(rowToMailAddress);
    },

    async save(address) {
      await db.execute(UPSERT_SQL, [
        address.id,
        address.domainId,
        address.localPart,
        address.address,
        address.displayName,
        address.status,
        address.createdByUserId,
        address.createdAt,
        address.updatedAt,
      ]);
    },

    async delete(id: MailAddressId) {
      await db.execute("DELETE FROM mail_addresses WHERE id = ?", [id]);
    },

    /** Counts mail that reached this mailbox in either direction, so a
     * delete cannot orphan stored messages. */
    async countMessages(id) {
      const rows = await db.query<{ count: number }>(
        `SELECT
           (SELECT COUNT(*)
            FROM message_recipients
            JOIN mail_addresses ON mail_addresses.address = message_recipients.address
            WHERE mail_addresses.id = ?)
           +
           (SELECT COUNT(*)
            FROM messages
            JOIN mail_addresses ON mail_addresses.address = messages.from_address
            WHERE mail_addresses.id = ?)
           AS count`,
        [id, id],
      );
      return rows[0]?.count ?? 0;
    },
  };
}
