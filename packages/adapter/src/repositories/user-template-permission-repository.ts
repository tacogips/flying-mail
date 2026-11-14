import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { UserTemplatePermissionRepository } from "@mailcal/application/ports/user-template-permission-repository";
import {
  Capability,
  isTemplateCapability,
} from "@mailcal/domain/entities/api-key";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import type { UserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import {
  createUserId,
  createUserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, buildInPlaceholders } from "./sql-helpers";

interface UserTemplatePermissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly capability: string;
  readonly effect: string;
  readonly created_by_user_id: string;
  readonly created_at: string;
}

function rowToPermission(
  row: UserTemplatePermissionRow,
): UserTemplatePermission {
  const capability = assertEnumValue(
    Capability,
    row.capability,
    "template capability",
  );
  if (!isTemplateCapability(capability)) {
    // The column's CHECK constraint already excludes this; failing loudly
    // beats letting a non-template capability masquerade as a rule.
    throw new Error(
      `Invalid template capability value from database: "${row.capability}"`,
    );
  }
  return {
    id: createUserTemplatePermissionId(row.id),
    userId: createUserId(row.user_id),
    capability,
    effect: assertEnumValue(
      UserPermissionEffect,
      row.effect,
      "user permission effect",
    ),
    createdByUserId: createUserId(row.created_by_user_id),
    createdAt: row.created_at,
  };
}

/** Conflict target is `(user_id, capability)` rather than `id`: re-granting
 * a capability must replace the existing rule, so the two can never
 * contradict each other. The use case reuses the existing row's id when it
 * finds one, which keeps `id` stable across a flip. */
const UPSERT_SQL = `INSERT INTO user_template_permissions
  (id, user_id, capability, effect, created_by_user_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, capability) DO UPDATE SET
    effect = excluded.effect,
    created_by_user_id = excluded.created_by_user_id`;

export function createUserTemplatePermissionRepository(
  db: SqlDatabase,
): UserTemplatePermissionRepository {
  return {
    async findById(id) {
      const rows = await db.query<UserTemplatePermissionRow>(
        "SELECT * FROM user_template_permissions WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToPermission(rows[0]);
    },

    async listByUserId(userId) {
      const rows = await db.query<UserTemplatePermissionRow>(
        `SELECT * FROM user_template_permissions
         WHERE user_id = ? ORDER BY capability ASC`,
        [userId],
      );
      return rows.map(rowToPermission);
    },

    async listByUserIds(userIds) {
      const byUser = new Map<string, UserTemplatePermission[]>(
        userIds.map((userId) => [userId as string, []]),
      );
      if (userIds.length === 0) {
        return byUser;
      }
      const rows = await db.query<UserTemplatePermissionRow>(
        `SELECT * FROM user_template_permissions
         WHERE user_id IN (${buildInPlaceholders(userIds.length)})
         ORDER BY user_id ASC, capability ASC`,
        [...userIds],
      );
      for (const row of rows) {
        byUser.get(row.user_id)?.push(rowToPermission(row));
      }
      return byUser;
    },

    async findByUserAndCapability(userId, capability) {
      const rows = await db.query<UserTemplatePermissionRow>(
        "SELECT * FROM user_template_permissions WHERE user_id = ? AND capability = ?",
        [userId, capability],
      );
      return rows[0] === undefined ? null : rowToPermission(rows[0]);
    },

    async save(permission) {
      await db.execute(UPSERT_SQL, [
        permission.id,
        permission.userId,
        permission.capability,
        permission.effect,
        permission.createdByUserId,
        permission.createdAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM user_template_permissions WHERE id = ?", [
        id,
      ]);
    },
  };
}
