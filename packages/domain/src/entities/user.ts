import { ValidationError } from "../errors";
import type { EmailAddress } from "../value-objects/email-address";
import type { UserId } from "../value-objects/ids";

/** `ADMIN` administers the instance, `MEMBER` may mutate assigned mail, and
 * `VIEWER` has read-only access to assigned mail. */
export enum UserRole {
  Admin = "ADMIN",
  Member = "MEMBER",
  Viewer = "VIEWER",
}

export interface User {
  readonly id: UserId;
  readonly email: EmailAddress;
  readonly name: string;
  readonly role: UserRole;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt: string | null;
}

export interface CreateUserInput {
  readonly id: UserId;
  readonly email: EmailAddress;
  readonly name: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

const MAX_USER_NAME_LENGTH = 128;

export function createUser(input: CreateUserInput): User {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("user name must not be empty", "name");
  }
  if (name.length > MAX_USER_NAME_LENGTH) {
    throw new ValidationError(
      `user name must be at most ${MAX_USER_NAME_LENGTH} characters`,
      "name",
    );
  }
  return {
    id: input.id,
    email: input.email,
    name,
    role: input.role,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    deactivatedAt: null,
  };
}

export function deactivateUser(user: User, at: string): User {
  return user.deactivatedAt === null
    ? { ...user, deactivatedAt: at, updatedAt: at }
    : user;
}

export function reactivateUser(user: User, at: string): User {
  return { ...user, deactivatedAt: null, updatedAt: at };
}

export function setUserRole(user: User, role: UserRole, at: string): User {
  return { ...user, role, updatedAt: at };
}

export function isUserActive(user: User): boolean {
  return user.deactivatedAt === null;
}

export function isAdmin(user: User): boolean {
  return user.role === UserRole.Admin && isUserActive(user);
}
