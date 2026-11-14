import {
  isTemplateCapability,
  type TemplateCapability,
} from "@mailcal/domain/entities/api-key";
import { UserRole } from "@mailcal/domain/entities/user";
import type { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import {
  createUserTemplatePermission,
  type UserTemplatePermission,
} from "@mailcal/domain/entities/user-template-permission";
import {
  createUserTemplatePermissionId,
  type UserId,
  type UserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface UserTemplatePermissionInput {
  readonly capability: TemplateCapability;
  readonly effect: UserPermissionEffect;
}

/** Template rules are user administration, so they follow the same rule as
 * roles and mailbox permissions: an `ADMIN` *user* only, never an API key.
 * A key holding `TEMPLATE_CREATE` can create templates; it can never widen
 * somebody else's account. */
function requireAdminUser(
  viewer: Viewer,
): asserts viewer is Extract<Viewer, { kind: "USER" }> {
  if (viewer.kind !== "USER" || viewer.role !== UserRole.Admin) {
    throw new ForbiddenError(
      "Only an administrator can manage template permissions",
    );
  }
}

export function createListUserTemplatePermissionsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userIds: readonly UserId[],
) => Promise<ReadonlyMap<string, readonly UserTemplatePermission[]>> {
  return async (viewer, userIds) => {
    requireAdminUser(viewer);
    return deps.userTemplatePermissionRepository.listByUserIds(userIds);
  };
}

export function createAddUserTemplatePermissionUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userId: UserId,
  input: UserTemplatePermissionInput,
) => Promise<UserTemplatePermission> {
  return async (viewer, userId, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      if (!isTemplateCapability(input.capability)) {
        throw new BadUserInputError(
          `${input.capability} is not a template capability`,
          "capability",
        );
      }
      const target = await deps.userRepository.findById(userId);
      if (target === null) {
        throw new NotFoundError("User", userId);
      }
      // `(userId, capability)` is unique, so re-granting replaces rather
      // than stacking: a rule list can never hold a contradictory
      // ALLOW/DENY pair whose outcome depends on evaluation order.
      const existing =
        await deps.userTemplatePermissionRepository.findByUserAndCapability(
          userId,
          input.capability,
        );
      const permission = createUserTemplatePermission({
        id: existing?.id ?? createUserTemplatePermissionId(deps.random.uuid()),
        userId,
        capability: input.capability,
        effect: input.effect,
        createdByUserId: viewer.userId,
        createdAt: existing?.createdAt ?? deps.clock.now().toISOString(),
      });
      await deps.userTemplatePermissionRepository.save(permission);
      return permission;
    });
}

export function createRemoveUserTemplatePermissionUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: UserTemplatePermissionId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      const existing = await deps.userTemplatePermissionRepository.findById(id);
      if (existing === null) {
        throw new NotFoundError("UserTemplatePermission", id);
      }
      await deps.userTemplatePermissionRepository.delete(id);
      return true;
    });
}
