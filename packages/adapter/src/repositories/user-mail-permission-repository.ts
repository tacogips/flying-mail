import type { UserMailPermissionRepository } from "@mailcal/application/ports/user-mail-permission-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type UserMailPermission,
  UserPermissionEffect,
} from "@mailcal/domain/entities/user-mail-permission";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import {
  createDomainId,
  createUserId,
  createUserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface UserMailPermissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly effect: string;
  readonly domain_id: string | null;
  readonly address_pattern: string;
  readonly created_by_user_id: string;
  readonly created_at: string;
}

function rowToPermission(row: UserMailPermissionRow): UserMailPermission {
  return {
    id: createUserMailPermissionId(row.id),
    userId: createUserId(row.user_id),
    effect: assertEnumValue(
      UserPermissionEffect,
      row.effect,
      "user permission effect",
    ),
    domainId: row.domain_id === null ? null : createDomainId(row.domain_id),
    addressPattern:
      row.address_pattern === "*"
        ? MATCH_ALL_ADDRESSES
        : createAddressPattern(row.address_pattern),
    createdByUserId: createUserId(row.created_by_user_id),
    createdAt: row.created_at,
  };
}

const UPSERT_PERMISSION_SQL = `INSERT INTO user_mail_permissions
  (id, user_id, effect, domain_id, address_pattern, created_by_user_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    effect = excluded.effect,
    domain_id = excluded.domain_id,
    address_pattern = excluded.address_pattern,
    created_by_user_id = excluded.created_by_user_id,
    created_at = excluded.created_at`;

/** Creates the SQL-backed store for interactive-user mailbox rules. */
export function createUserMailPermissionRepository(
  db: SqlDatabase,
): UserMailPermissionRepository {
  return {
    async findById(id) {
      const rows = await db.query<UserMailPermissionRow>(
        "SELECT * FROM user_mail_permissions WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToPermission(rows[0]);
    },

    async listByUserId(userId) {
      const rows = await db.query<UserMailPermissionRow>(
        `SELECT * FROM user_mail_permissions
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return rows.map(rowToPermission);
    },

    async save(permission) {
      await db.execute(UPSERT_PERMISSION_SQL, [
        permission.id,
        permission.userId,
        permission.effect,
        permission.domainId,
        permission.addressPattern,
        permission.createdByUserId,
        permission.createdAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM user_mail_permissions WHERE id = ?", [id]);
    },
  };
}
