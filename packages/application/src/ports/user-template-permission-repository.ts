import type { TemplateCapability } from "@mailcal/domain/entities/api-key";
import type { UserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import type {
  UserId,
  UserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";

/** Persistence boundary for per-user template-capability rules. */
export interface UserTemplatePermissionRepository {
  findById(
    id: UserTemplatePermissionId,
  ): Promise<UserTemplatePermission | null>;
  listByUserId(userId: UserId): Promise<readonly UserTemplatePermission[]>;
  listByUserIds(
    userIds: readonly UserId[],
  ): Promise<ReadonlyMap<string, readonly UserTemplatePermission[]>>;
  /** `(userId, capability)` is unique: re-granting a capability replaces the
   * existing rule rather than stacking a second one, so a rule list can
   * never hold a contradictory ALLOW/DENY pair for the same capability. */
  save(permission: UserTemplatePermission): Promise<void>;
  findByUserAndCapability(
    userId: UserId,
    capability: TemplateCapability,
  ): Promise<UserTemplatePermission | null>;
  delete(id: UserTemplatePermissionId): Promise<void>;
}
