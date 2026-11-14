import { Capability, type CalendarCapability } from "./api-key";
import { UserRole } from "./user";
import { UserPermissionEffect } from "./user-mail-permission";
import type { UserCalendarPermissionId, UserId } from "../value-objects/ids";

/** One admin-assigned grant or denial of a calendar capability, scoped to a
 * calendar *owner* rather than a single calendar.
 *
 * Owner is the axis calendar authorization already turns on -- an API key's
 * `CALENDAR_READ` scope is matched against the owner's account email -- so a
 * user rule naming an owner is the same decision expressed for the other
 * credential kind. */
export interface UserCalendarPermission {
  readonly id: UserCalendarPermissionId;
  readonly userId: UserId;
  readonly capability: CalendarCapability;
  readonly effect: UserPermissionEffect;
  /** `null` means every calendar owner, the viewer's own included. */
  readonly ownerUserId: UserId | null;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

export interface CreateUserCalendarPermissionInput {
  readonly id: UserCalendarPermissionId;
  readonly userId: UserId;
  readonly capability: CalendarCapability;
  readonly effect: UserPermissionEffect;
  readonly ownerUserId: UserId | null;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

export function createUserCalendarPermission(
  input: CreateUserCalendarPermissionInput,
): UserCalendarPermission {
  return {
    id: input.id,
    userId: input.userId,
    capability: input.capability,
    effect: input.effect,
    ownerUserId: input.ownerUserId,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
  };
}

/** Whether a role may hold `capability` **at all**, before any rule is
 * considered. A `VIEWER` can never write a calendar, exactly as it can never
 * send mail -- an ALLOW rule cannot lift that ceiling. */
export function roleGrantsCalendarCapability(
  role: UserRole,
  capability: CalendarCapability,
): boolean {
  if (capability === Capability.CalendarRead) {
    return true;
  }
  return role !== UserRole.Viewer;
}

/** True when `rule` is about this capability and covers this owner. */
function ruleCovers(
  rule: UserCalendarPermission,
  capability: CalendarCapability,
  ownerUserId: UserId,
): boolean {
  if (rule.capability !== capability) {
    return false;
  }
  return rule.ownerUserId === null || rule.ownerUserId === ownerUserId;
}

/** Resolves one user's effective calendar capability over one owner.
 *
 * The order is what makes an admin's access *revocable*: a matching DENY is
 * consulted before the owner check and before the admin baseline, so an
 * admin can hold the power to grant permissions while holding no access to
 * a given calendar. Administration and data access are separate concerns --
 * the same rule mail already follows.
 *
 * 1. Role ceiling (`VIEWER` never writes).
 * 2. A matching DENY rejects.
 * 3. The viewer's own calendars.
 * 4. A matching ALLOW grants -- this is how a MEMBER reaches someone else's.
 * 5. Otherwise the role default: `ADMIN` yes, everyone else no.
 */
export function resolveUserCalendarCapability(
  viewer: {
    readonly userId: UserId;
    readonly role: UserRole;
    readonly calendarPermissions: readonly UserCalendarPermission[];
  },
  capability: CalendarCapability,
  ownerUserId: UserId,
): boolean {
  if (!roleGrantsCalendarCapability(viewer.role, capability)) {
    return false;
  }
  const matching = viewer.calendarPermissions.filter((rule) =>
    ruleCovers(rule, capability, ownerUserId),
  );
  if (matching.some((rule) => rule.effect === UserPermissionEffect.Deny)) {
    return false;
  }
  if (viewer.userId === ownerUserId) {
    return true;
  }
  if (matching.some((rule) => rule.effect === UserPermissionEffect.Allow)) {
    return true;
  }
  return viewer.role === UserRole.Admin;
}
