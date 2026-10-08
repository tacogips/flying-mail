import type { AppDependencies } from "../dependencies";
import {
  Capability,
  isApiKeyUsable,
  scopesAuthorizeGlobal,
} from "@flying-mail/domain/entities/api-key";
import { UserRole, type User } from "@flying-mail/domain/entities/user";
import { isUserActive } from "@flying-mail/domain/entities/user";
import type { UserMailPermission } from "@flying-mail/domain/entities/user-mail-permission";
import { ForbiddenError, RateLimitedError } from "../errors";
import type { Viewer } from "../policies/viewer";
import type { UserId } from "@flying-mail/domain/value-objects/ids";

export interface UserWithPermissions {
  readonly user: User;
  readonly permissions: readonly UserMailPermission[];
}

export type AuthOperation =
  | "requestEmailAuth"
  | "verifyEmailAuthToken"
  | "bootstrapAdmin";

export function requireAdminUser(
  viewer: Viewer,
): asserts viewer is Extract<Viewer, { kind: "USER" }> {
  if (viewer.kind !== "USER" || viewer.role !== UserRole.Admin) {
    throw new ForbiddenError("Only an admin user may administer users");
  }
}

export interface UserAdministrator {
  readonly actorUserId: UserId;
}

/** Authorizes a signed-in admin or a live USER_ADMIN key on every call. */
export async function requireUserAdministrator(
  deps: AppDependencies,
  viewer: Viewer,
): Promise<UserAdministrator> {
  if (viewer.kind === "USER") {
    if (viewer.role === UserRole.Admin) {
      return { actorUserId: viewer.userId };
    }
    throw new ForbiddenError("Only an admin user may administer users");
  }

  if (!scopesAuthorizeGlobal(viewer.scopes, Capability.UserAdmin)) {
    throw new ForbiddenError("This API key lacks the USER_ADMIN capability");
  }

  const key = await deps.apiKeyRepository.findById(viewer.apiKeyId);
  if (key === null || !isApiKeyUsable(key, deps.clock.now().toISOString())) {
    throw new ForbiddenError(
      "USER_ADMIN is inactive: this key is no longer usable",
    );
  }
  if (key.createdByUserId === null) {
    throw new ForbiddenError(
      "USER_ADMIN is inactive: this key has no creating admin",
    );
  }

  const creator = await deps.userRepository.findById(key.createdByUserId);
  if (
    creator === null ||
    !isUserActive(creator) ||
    creator.role !== UserRole.Admin
  ) {
    throw new ForbiddenError(
      "USER_ADMIN is inactive: the admin who created this key is no longer an active ADMIN",
    );
  }

  return { actorUserId: creator.id };
}

export async function loadUserWithPermissions(
  deps: AppDependencies,
  user: User,
): Promise<UserWithPermissions> {
  const permissions = await deps.userMailPermissionRepository.listByUserId(
    user.id,
  );
  return { user, permissions };
}

export async function enforceAuthRateLimit(
  deps: AppDependencies,
  operation: AuthOperation,
  clientIp: string | null,
): Promise<void> {
  if (deps.rateLimiter === null) {
    return;
  }
  const allowed = await deps.rateLimiter.limit(
    `auth:${operation}:${clientIp ?? "unknown"}`,
  );
  if (!allowed) {
    throw new RateLimitedError("Too many requests; try again later");
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
