import {
  isTemplateCapability,
  type TemplateCapability,
} from "@flying-mail/domain/entities/api-key";
import type { UserPermissionEffect } from "@flying-mail/domain/entities/user-mail-permission";
import {
  createUserTemplatePermission,
  type UserTemplatePermission,
} from "@flying-mail/domain/entities/user-template-permission";
import {
  createUserTemplatePermissionId,
  type UserId,
  type UserTemplatePermissionId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { requireUserAdministrator } from "./auth-guards";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface UserTemplatePermissionInput {
  readonly capability: TemplateCapability;
  readonly effect: UserPermissionEffect;
}

export function createListUserTemplatePermissionsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userIds: readonly UserId[],
) => Promise<ReadonlyMap<string, readonly UserTemplatePermission[]>> {
  return async (viewer, userIds) => {
    await requireUserAdministrator(deps, viewer);
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
      const { actorUserId } = await requireUserAdministrator(deps, viewer);
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
        createdByUserId: actorUserId,
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
      await requireUserAdministrator(deps, viewer);
      const existing = await deps.userTemplatePermissionRepository.findById(id);
      if (existing === null) {
        throw new NotFoundError("UserTemplatePermission", id);
      }
      await deps.userTemplatePermissionRepository.delete(id);
      return true;
    });
}
