import { revokeApiKey } from "@flying-mail/domain/entities/api-key";
import {
  createUser,
  deactivateUser,
  isAdmin,
  reactivateUser,
  setUserRole,
  type User,
  UserRole,
} from "@flying-mail/domain/entities/user";
import {
  createUserMailPermission,
  type UserMailPermission,
  UserPermissionEffect,
} from "@flying-mail/domain/entities/user-mail-permission";
import {
  type AddressPattern,
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@flying-mail/domain/value-objects/address-pattern";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createUserId,
  createUserMailPermissionId,
  type DomainId,
  type UserId,
  type UserMailPermissionId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import {
  loadUserWithPermissions,
  requireAdminUser,
  requireUserAdministrator,
  type UserWithPermissions,
} from "./auth-guards";
import { issueInvitation } from "./invitations";
import { requireMailConfigured } from "./email-auth";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
}

export type { UserWithPermissions } from "./auth-guards";

export interface UserMailPermissionInput {
  readonly effect: UserPermissionEffect;
  readonly domainId: DomainId | null;
  readonly addressPattern: string;
}

/** The number of users who are both `ADMIN` and active -- the quantity the
 * last-active-admin invariant is checked against. Reads the full user list
 * rather than adding a dedicated repository method: administration is a
 * low-volume, admin-only path where this is not worth the extra port
 * surface. */
async function countActiveAdmins(deps: AppDependencies): Promise<number> {
  const users = await deps.userRepository.list();
  return users.filter(isAdmin).length;
}

const DEMOTE_CONFLICT_MESSAGE =
  "Cannot demote the last active admin; promote another user first";
const DEACTIVATE_CONFLICT_MESSAGE =
  "Cannot deactivate the last active admin; activate another admin first";

/** Persists a change that removes an active admin's admin power. The count
 * in the caller is only a pre-check for a clear message; this conditional
 * write is what actually holds the invariant under concurrency, because it
 * refuses to apply when no other active admin exists at write time. */
async function saveAdminRemoval(
  deps: AppDependencies,
  updated: User,
  conflictMessage: string,
): Promise<void> {
  if (!(await deps.userRepository.saveUnlessLastActiveAdmin(updated))) {
    throw new ConflictError(conflictMessage);
  }
}

/** A deactivated user must not keep working through keys it minted: an API
 * key authorizes by its own scopes and would otherwise outlive the user.
 * Uses the same domain revoke as the explicit revoke use case. */
async function revokeKeysCreatedBy(
  deps: AppDependencies,
  userId: UserId,
  now: string,
): Promise<void> {
  const keys = await deps.apiKeyRepository.listByCreator(userId);
  for (const key of keys) {
    if (key.revokedAt === null) {
      await deps.apiKeyRepository.save(revokeApiKey(key, now));
    }
  }
}

function parsePermissionPattern(value: string): AddressPattern {
  return value === "*"
    ? MATCH_ALL_ADDRESSES
    : createAddressPattern(value, "addressPattern");
}

export function createListUsersUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly UserWithPermissions[]> {
  return async (viewer) => {
    await requireUserAdministrator(deps, viewer);
    const users = await deps.userRepository.list();
    return Promise.all(
      users.map((user) => loadUserWithPermissions(deps, user)),
    );
  };
}

export function createGetUserUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: UserId) => Promise<UserWithPermissions | null> {
  return async (viewer, id) => {
    await requireUserAdministrator(deps, viewer);
    const user = await deps.userRepository.findById(id);
    return user === null ? null : loadUserWithPermissions(deps, user);
  };
}

export function createCreateUserUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateUserInput) => Promise<UserWithPermissions> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      const mail = requireMailConfigured(deps);
      const email = createEmailAddress(input.email, "email");
      const existing = await deps.userRepository.findByEmail(email);
      if (existing !== null) {
        throw new ConflictError(`A user with email ${email} already exists`);
      }
      // No password: the new user signs in through the existing
      // passwordless email flow, same as every other user.
      const user = createUser({
        id: createUserId(deps.random.uuid()),
        email,
        name: input.name,
        role: input.role,
        invitationAcceptedAt: null,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.userRepository.save(user);
      await issueInvitation(deps, mail, user);
      return { user, permissions: [] };
    });
}

export function createSetUserRoleUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: UserId,
  role: UserRole,
) => Promise<UserWithPermissions> {
  return async (viewer, id, role) =>
    withAsyncDomainErrorTranslation(async () => {
      await requireUserAdministrator(deps, viewer);
      const user = await deps.userRepository.findById(id);
      if (user === null) {
        throw new NotFoundError("User", id);
      }
      if (isAdmin(user) && role !== UserRole.Admin) {
        const activeAdmins = await countActiveAdmins(deps);
        if (activeAdmins <= 1) {
          throw new ConflictError(DEMOTE_CONFLICT_MESSAGE);
        }
      }
      const updated = setUserRole(user, role, deps.clock.now().toISOString());
      if (isAdmin(user) && role !== UserRole.Admin) {
        await saveAdminRemoval(deps, updated, DEMOTE_CONFLICT_MESSAGE);
      } else {
        await deps.userRepository.save(updated);
      }
      return loadUserWithPermissions(deps, updated);
    });
}

export function createSetUserActiveUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: UserId,
  active: boolean,
) => Promise<UserWithPermissions> {
  return async (viewer, id, active) =>
    withAsyncDomainErrorTranslation(async () => {
      await requireUserAdministrator(deps, viewer);
      const user = await deps.userRepository.findById(id);
      if (user === null) {
        throw new NotFoundError("User", id);
      }
      if (!active && isAdmin(user)) {
        const activeAdmins = await countActiveAdmins(deps);
        if (activeAdmins <= 1) {
          throw new ConflictError(DEACTIVATE_CONFLICT_MESSAGE);
        }
      }
      const now = deps.clock.now().toISOString();
      // Reactivation is always allowed: it can only ever add an admin back,
      // never remove the last one, so it needs no invariant check.
      const updated = active
        ? reactivateUser(user, now)
        : deactivateUser(user, now);
      if (!active && isAdmin(user)) {
        await saveAdminRemoval(deps, updated, DEACTIVATE_CONFLICT_MESSAGE);
      } else {
        await deps.userRepository.save(updated);
      }
      if (!active) {
        await revokeKeysCreatedBy(deps, user.id, now);
      }
      return loadUserWithPermissions(deps, updated);
    });
}

export function createAddUserMailPermissionUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  userId: UserId,
  input: UserMailPermissionInput,
) => Promise<UserMailPermission> {
  return async (viewer, userId, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const { actorUserId } = await requireUserAdministrator(deps, viewer);
      const target = await deps.userRepository.findById(userId);
      if (target === null) {
        throw new NotFoundError("User", userId);
      }
      if (input.domainId !== null) {
        const domain = await deps.mailDomainRepository.findById(input.domainId);
        if (domain === null) {
          throw new NotFoundError("Domain", input.domainId);
        }
      }
      // An admin may add a deny rule against itself: that only removes
      // mailbox access, never administrative authority, so it needs no
      // extra guard here (unlike the last-active-admin checks above).
      const permission = createUserMailPermission({
        id: createUserMailPermissionId(deps.random.uuid()),
        userId,
        effect: input.effect,
        domainId: input.domainId,
        addressPattern: parsePermissionPattern(input.addressPattern),
        createdByUserId: actorUserId,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.userMailPermissionRepository.save(permission);
      return permission;
    });
}

export function createRemoveUserMailPermissionUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: UserMailPermissionId) => Promise<boolean> {
  return async (viewer, id) => {
    await requireUserAdministrator(deps, viewer);
    const permission = await deps.userMailPermissionRepository.findById(id);
    if (permission === null) {
      throw new NotFoundError("UserMailPermission", id);
    }
    await deps.userMailPermissionRepository.delete(id);
    return true;
  };
}

export { UserPermissionEffect };
