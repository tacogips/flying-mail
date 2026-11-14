import type { CalendarCapability } from "@mailcal/domain/entities/api-key";
import type { UserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import type {
  UserCalendarPermissionId,
  UserId,
} from "@mailcal/domain/value-objects/ids";

/** Persistence boundary for per-user calendar rules. */
export interface UserCalendarPermissionRepository {
  findById(
    id: UserCalendarPermissionId,
  ): Promise<UserCalendarPermission | null>;
  listByUserId(userId: UserId): Promise<readonly UserCalendarPermission[]>;
  listByUserIds(
    userIds: readonly UserId[],
  ): Promise<ReadonlyMap<string, readonly UserCalendarPermission[]>>;
  /** `(userId, capability, ownerUserId)` is unique: re-issuing a rule for
   * the same target replaces it rather than stacking a second one, so a
   * rule list can never hold a contradictory pair for one exact target. */
  findByTarget(
    userId: UserId,
    capability: CalendarCapability,
    ownerUserId: UserId | null,
  ): Promise<UserCalendarPermission | null>;
  save(permission: UserCalendarPermission): Promise<void>;
  delete(id: UserCalendarPermissionId): Promise<void>;
}
