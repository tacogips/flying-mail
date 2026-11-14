import type { MailDomainRepository } from "@mailcal/application/ports/mail-domain-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  DomainStatus,
  type MailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createDomainId } from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, boolToSql, sqlToBool } from "./sql-helpers";

interface DomainRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly catch_all: number;
  readonly verification_token: string;
  readonly verified_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToDomain(row: DomainRow): MailDomain {
  return {
    id: createDomainId(row.id),
    name: createDomainName(row.name),
    status: assertEnumValue(DomainStatus, row.status, "domain status"),
    catchAll: sqlToBool(row.catch_all),
    verificationToken: row.verification_token,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_SQL = `INSERT INTO domains
  (id, name, status, catch_all, verification_token, verified_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    status = excluded.status,
    catch_all = excluded.catch_all,
    verification_token = excluded.verification_token,
    verified_at = excluded.verified_at,
    updated_at = excluded.updated_at`;

export function createMailDomainRepository(
  db: SqlDatabase,
): MailDomainRepository {
  return {
    async findById(id) {
      const rows = await db.query<DomainRow>(
        "SELECT * FROM domains WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToDomain(rows[0]);
    },

    async findByName(name) {
      const rows = await db.query<DomainRow>(
        "SELECT * FROM domains WHERE name = ?",
        [name],
      );
      return rows[0] === undefined ? null : rowToDomain(rows[0]);
    },

    async list() {
      const rows = await db.query<DomainRow>(
        "SELECT * FROM domains ORDER BY name ASC",
      );
      return rows.map(rowToDomain);
    },

    async save(domain) {
      await db.execute(UPSERT_SQL, [
        domain.id,
        domain.name,
        domain.status,
        boolToSql(domain.catchAll),
        domain.verificationToken,
        domain.verifiedAt,
        domain.createdAt,
        domain.updatedAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM domains WHERE id = ?", [id]);
    },

    async countMessages(id) {
      const rows = await db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages WHERE domain_id = ?",
        [id],
      );
      return rows[0]?.count ?? 0;
    },

    /** Backs the non-catch-all accept decision. An address counts as known
     * once mail has been delivered to it on this domain, **or once mail has
     * been sent from it** -- the second clause is what breaks the
     * bootstrap deadlock: without it a non-catch-all domain could never
     * receive its first message, because the only way to become known
     * would be to have already received one. Sending once from a mailbox
     * is the act that establishes it. */
    async hasKnownLocalPart(id, address) {
      const rows = await db.query<{ count: number }>(
        `SELECT
           (SELECT COUNT(*)
            FROM message_recipients
            JOIN messages ON messages.id = message_recipients.message_id
            WHERE messages.domain_id = ? AND message_recipients.address = ?)
           +
           (SELECT COUNT(*)
            FROM messages
            WHERE messages.domain_id = ? AND messages.from_address = ?)
           AS count`,
        [id, address, id, address],
      );
      return (rows[0]?.count ?? 0) > 0;
    },
  };
}
