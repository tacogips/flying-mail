import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { UserCalendarPermissionRepository } from "@mailcal/application/ports/user-calendar-permission-repository";
import {
  Capability,
  isCalendarCapability,
} from "@mailcal/domain/entities/api-key";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import type { UserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import {
  createUserCalendarPermissionId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, buildInPlaceholders } from "./sql-helpers";

interface UserCalendarPermissionRow {
  readonly id: string;
  readonly user_id: string;
  readonly capability: string;
  readonly effect: string;
  readonly owner_user_id: string | null;
  readonly created_by_user_id: string;
  readonly created_at: string;
}

function rowToPermission(
  row: UserCalendarPermissionRow,
): UserCalendarPermission {
  const capability = assertEnumValue(
    Capability,
    row.capability,
    "calendar capability",
  );
  if (!isCalendarCapability(capability)) {
    // The column's CHECK already excludes this; failing loudly beats letting
    // a non-calendar capability masquerade as a calendar rule.
    throw new Error(
      `Invalid calendar capability value from database: "${row.capability}"`,
    );
  }
  return {
    id: createUserCalendarPermissionId(row.id),
    userId: createUserId(row.user_id),
    capability,
    effect: assertEnumValue(
      UserPermissionEffect,
      row.effect,
      "user permission effect",
    ),
    ownerUserId:
      row.owner_user_id === null ? null : createUserId(row.owner_user_id),
    createdByUserId: createUserId(row.created_by_user_id),
    createdAt: row.created_at,
  };
}

/** The conflict target is the rule's *target* -- `(user, capability, owner)`
 * -- not its id, so re-issuing a rule replaces it. `ifnull(owner_user_id,
 * '')` is what makes the all-owners row participate in the unique index at
 * all: SQLite treats distinct NULLs as unequal, which would otherwise let a
 * second all-owners rule stack on the first. */
const UPSERT_SQL = `INSERT INTO user_calendar_permissions
  (id, user_id, capability, effect, owner_user_id, created_by_user_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, capability, ifnull(owner_user_id, '')) DO UPDATE SET
    effect = excluded.effect,
    created_by_user_id = excluded.created_by_user_id`;

export function createUserCalendarPermissionRepository(
  db: SqlDatabase,
): UserCalendarPermissionRepository {
  return {
    async findById(id) {
      const rows = await db.query<UserCalendarPermissionRow>(
        "SELECT * FROM user_calendar_permissions WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToPermission(rows[0]);
    },

    async listByUserId(userId) {
      const rows = await db.query<UserCalendarPermissionRow>(
        `SELECT * FROM user_calendar_permissions
         WHERE user_id = ?
         ORDER BY capability ASC, ifnull(owner_user_id, '') ASC`,
        [userId],
      );
      return rows.map(rowToPermission);
    },

    async listByUserIds(userIds) {
      const byUser = new Map<string, UserCalendarPermission[]>(
        userIds.map((userId) => [userId as string, []]),
      );
      if (userIds.length === 0) {
        return byUser;
      }
      const rows = await db.query<UserCalendarPermissionRow>(
        `SELECT * FROM user_calendar_permissions
         WHERE user_id IN (${buildInPlaceholders(userIds.length)})
         ORDER BY user_id ASC, capability ASC, ifnull(owner_user_id, '') ASC`,
        [...userIds],
      );
      for (const row of rows) {
        byUser.get(row.user_id)?.push(rowToPermission(row));
      }
      return byUser;
    },

    async findByTarget(userId, capability, ownerUserId) {
      const rows = await db.query<UserCalendarPermissionRow>(
        `SELECT * FROM user_calendar_permissions
         WHERE user_id = ? AND capability = ?
           AND ifnull(owner_user_id, '') = ifnull(?, '')`,
        [userId, capability, ownerUserId],
      );
      return rows[0] === undefined ? null : rowToPermission(rows[0]);
    },

    async save(permission) {
      await db.execute(UPSERT_SQL, [
        permission.id,
        permission.userId,
        permission.capability,
        permission.effect,
        permission.ownerUserId,
        permission.createdByUserId,
        permission.createdAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM user_calendar_permissions WHERE id = ?", [
        id,
      ]);
    },
  };
}
