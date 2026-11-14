import { Capability, type TemplateCapability } from "./api-key";
import { UserRole } from "./user";
import { UserPermissionEffect } from "./user-mail-permission";
import type { UserId, UserTemplatePermissionId } from "../value-objects/ids";

/** One admin-assigned grant or denial of a template capability. Unlike a
 * mailbox rule there is no domain or address: templates are instance-wide,
 * so a rule is exactly `(user, capability, effect)`. */
export interface UserTemplatePermission {
  readonly id: UserTemplatePermissionId;
  readonly userId: UserId;
  readonly capability: TemplateCapability;
  readonly effect: UserPermissionEffect;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

export interface CreateUserTemplatePermissionInput {
  readonly id: UserTemplatePermissionId;
  readonly userId: UserId;
  readonly capability: TemplateCapability;
  readonly effect: UserPermissionEffect;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

export function createUserTemplatePermission(
  input: CreateUserTemplatePermissionInput,
): UserTemplatePermission {
  return {
    id: input.id,
    userId: input.userId,
    capability: input.capability,
    effect: input.effect,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
  };
}

/** What a role holds before any explicit rule is applied.
 *
 * Reading the catalogue is open to every signed-in role -- a template is not
 * secret, and a MEMBER who may send mail needs to see what it can send.
 * The three mutating capabilities are closed by default for everyone except
 * an ADMIN: a capability that changes the mail *other* people send is
 * granted deliberately, not inherited from a role. */
export function roleGrantsTemplateCapability(
  role: UserRole,
  capability: TemplateCapability,
): boolean {
  if (capability === Capability.TemplateRead) {
    return true;
  }
  return role === UserRole.Admin;
}

/** Resolves one user's effective template capability: a matching `DENY`
 * always wins, then a matching `ALLOW`, then the role default. The deny-first
 * order is what lets an admin revoke its own default, mirroring how an admin
 * can deny itself a mailbox. */
export function resolveUserTemplateCapability(
  role: UserRole,
  rules: readonly UserTemplatePermission[],
  capability: TemplateCapability,
): boolean {
  const matching = rules.filter((rule) => rule.capability === capability);
  if (matching.some((rule) => rule.effect === UserPermissionEffect.Deny)) {
    return false;
  }
  if (matching.some((rule) => rule.effect === UserPermissionEffect.Allow)) {
    return true;
  }
  return roleGrantsTemplateCapability(role, capability);
}
