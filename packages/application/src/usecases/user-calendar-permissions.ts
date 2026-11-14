import {
  type CalendarCapability,
  isCalendarCapability,
} from "@mailcal/domain/entities/api-key";
import { UserRole } from "@mailcal/domain/entities/user";
import type { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import {
  createUserCalendarPermission,
  type UserCalendarPermission,
} from "@mailcal/domain/entities/user-calendar-permission";
import {
  createUserCalendarPermissionId,
  type UserCalendarPermissionId,
  type UserId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface UserCalendarPermissionInput {
  readonly capability: CalendarCapability;
  readonly effect: UserPermissionEffect;
  /** `null` means every calendar owner. */
  readonly ownerUserId: UserId | null;
}

/** Managing who may see a calendar is user administration, and is gated on
 * the ADMIN *role* alone.
 *
 * Deliberately not gated on the admin's own calendar access: an admin that
 * has denied itself a calendar keeps the power to grant that calendar to
 * somebody else, because administering permissions and reading data are
 * separate concerns. An API key never reaches this at all, whatever
 * capabilities it holds. */
function requireAdminUser(
  viewer: Viewer,
): asserts viewer is Extract<Viewer, { kind: "USER" }> {
  if (viewer.kind !== "USER" || viewer.role !== UserRole.Admin) {
    throw new ForbiddenError(
      "Only an administrator can manage calendar permissions",
    );
  }
}

export function createListUserCalendarPermissionsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userIds: readonly UserId[],
) => Promise<ReadonlyMap<string, readonly UserCalendarPermission[]>> {
  return async (viewer, userIds) => {
    requireAdminUser(viewer);
    return deps.userCalendarPermissionRepository.listByUserIds(userIds);
  };
}

export function createAddUserCalendarPermissionUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userId: UserId,
  input: UserCalendarPermissionInput,
) => Promise<UserCalendarPermission> {
  return async (viewer, userId, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      if (!isCalendarCapability(input.capability)) {
        throw new BadUserInputError(
          `${input.capability} is not a calendar capability`,
          "capability",
        );
      }
      const target = await deps.userRepository.findById(userId);
      if (target === null) {
        throw new NotFoundError("User", userId);
      }
      if (input.ownerUserId !== null) {
        const owner = await deps.userRepository.findById(input.ownerUserId);
        if (owner === null) {
          throw new NotFoundError("User", input.ownerUserId);
        }
      }
      // Replaces rather than stacks, so one exact target can never hold a
      // contradictory ALLOW/DENY pair whose outcome depends on order.
      const existing = await deps.userCalendarPermissionRepository.findByTarget(
        userId,
        input.capability,
        input.ownerUserId,
      );
      const permission = createUserCalendarPermission({
        id: existing?.id ?? createUserCalendarPermissionId(deps.random.uuid()),
        userId,
        capability: input.capability,
        effect: input.effect,
        ownerUserId: input.ownerUserId,
        createdByUserId: viewer.userId,
        createdAt: existing?.createdAt ?? deps.clock.now().toISOString(),
      });
      await deps.userCalendarPermissionRepository.save(permission);
      return permission;
    });
}

export function createRemoveUserCalendarPermissionUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: UserCalendarPermissionId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      const existing = await deps.userCalendarPermissionRepository.findById(id);
      if (existing === null) {
        throw new NotFoundError("UserCalendarPermission", id);
      }
      await deps.userCalendarPermissionRepository.delete(id);
      return true;
    });
}
