import type { AppDependencies } from "../dependencies";
import { UserRole, type User } from "@flying-mail/domain/entities/user";
import type { UserMailPermission } from "@flying-mail/domain/entities/user-mail-permission";
import { ForbiddenError, RateLimitedError } from "../errors";
import type { Viewer } from "../policies/viewer";

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
