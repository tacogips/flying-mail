import {
  type CalendarCapability,
  Capability,
  isGlobalCapability,
  scopesAuthorize,
  scopesAuthorizeGlobal,
  scopesForCapability,
  type TemplateCapability,
} from "@mailcal/domain/entities/api-key";
import { resolveUserCalendarCapability } from "@mailcal/domain/entities/user-calendar-permission";
import { resolveUserTemplateCapability } from "@mailcal/domain/entities/user-template-permission";
import { UserRole } from "@mailcal/domain/entities/user";
import {
  type AddressPattern,
  matchAddressPattern,
} from "@mailcal/domain/value-objects/address-pattern";
import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import type { DomainId, UserId } from "@mailcal/domain/value-objects/ids";
import { ForbiddenError, UnauthenticatedError } from "../errors";
import { isAdminViewer, type Viewer } from "./viewer";

/** Every authorization decision in mailcal goes through this module. Use
 * cases call it rather than inspecting `Viewer` directly, so the rules exist
 * in exactly one place and can be audited as a unit. */

/** Narrows a possibly-absent viewer, throwing `UnauthenticatedError`. */
export function requireViewer(viewer: Viewer | null): Viewer {
  if (viewer === null) {
    throw new UnauthenticatedError("Authentication required");
  }
  return viewer;
}

/** Non-throwing form of {@link requireGlobalCapability}. */
export function authorizesGlobal(
  viewer: Viewer,
  capability: Capability,
): boolean {
  if (viewer.kind === "USER") {
    // Instance administration is an ADMIN-only user power; a MEMBER never
    // has it, and a deactivated user never resolves to a viewer at all.
    return isGlobalCapability(capability)
      ? isAdminViewer(viewer)
      : // Non-global capabilities are per-address; asking about them here is
        // a caller mistake rather than a grant, so answer conservatively.
        false;
  }
  return scopesAuthorizeGlobal(viewer.scopes, capability);
}

/** Instance-wide capability check (`DOMAIN_ADMIN`, `KEY_ADMIN`). */
export function requireGlobalCapability(
  viewer: Viewer,
  capability: Capability,
): void {
  if (!authorizesGlobal(viewer, capability)) {
    throw new ForbiddenError(
      `This credential is not permitted to perform ${capability} operations`,
    );
  }
}

/** One `UserMailPermission` row, reduced to exactly what an authorization
 * decision or a listing filter needs. The `(effect, domainId,
 * addressPattern)` triple must always travel together: splitting a rule's
 * domain and pattern into independent lists would let an unrelated pairing
 * from a *different* rule match, which is the cross-product bug this shape
 * exists to prevent. */
export interface MailAuthorizationRule {
  readonly effect: "ALLOW" | "DENY";
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
}

/** Everything a listing query needs to enforce a USER viewer's mailbox
 * rules. `baseline: true` (ADMIN) means every domain/address is visible
 * unless a DENY rule matches; `baseline: false` (MEMBER/VIEWER) means only
 * a matching ALLOW with no matching DENY makes a candidate visible. */
export interface MailPermissionFilter {
  readonly baseline: boolean;
  readonly rules: readonly MailAuthorizationRule[];
}

/** Whether a role may exercise `capability` **at all**, before any per-rule
 * ALLOW/DENY is considered. `ADMIN` and `MEMBER` may exercise every
 * non-global capability (subject to `MEMBER` still needing a matching
 * ALLOW rule); `VIEWER` may only ever read mail and mint file links, no
 * matter what its rules say. Callers must already have excluded global
 * capabilities before calling this. */
function roleGrantsCapability(role: UserRole, capability: Capability): boolean {
  switch (role) {
    case UserRole.Admin:
    case UserRole.Member:
      return true;
    case UserRole.Viewer:
      return (
        capability === Capability.MailRead || capability === Capability.FileLink
      );
    default: {
      const exhaustive: never = role;
      throw new Error(`Unhandled user role: ${String(exhaustive)}`);
    }
  }
}

/** The viewer's mailbox rules that are even in play for `capability` --
 * empty for an API-key viewer, a global capability, or a role that a
 * `VIEWER` can never hold (`MAIL_SEND`/`MAIL_MANAGE`). Every rule keeps its
 * own `(effect, domainId, addressPattern)` triple, so a caller can never
 * accidentally recombine one rule's domain with another rule's pattern. */
export function mailAuthorizationRules(
  viewer: Viewer,
  capability: Capability,
): readonly MailAuthorizationRule[] {
  if (viewer.kind !== "USER" || isGlobalCapability(capability)) {
    return [];
  }
  if (!roleGrantsCapability(viewer.role, capability)) {
    return [];
  }
  return viewer.permissions.map((permission) => ({
    effect: permission.effect,
    domainId: permission.domainId,
    addressPattern: permission.addressPattern,
  }));
}

/** The listing-query filter a USER viewer's mailbox rules impose, or `null`
 * when this mechanism does not apply (an API-key viewer, or a global
 * capability -- both keep using `readableAddressPatterns`/`scopedDomainIds`
 * instead, entirely independently of this one). */
export function mailPermissionListFilter(
  viewer: Viewer,
  capability: Capability,
): MailPermissionFilter | null {
  if (viewer.kind !== "USER" || isGlobalCapability(capability)) {
    return null;
  }
  return {
    baseline: viewer.role === UserRole.Admin,
    rules: mailAuthorizationRules(viewer, capability),
  };
}

/** True when `rule`'s own domain/pattern pairing covers `domainId` and
 * `address`. Never call this with a domain or pattern taken from a
 * *different* rule -- that is exactly the cross-product this type's shape
 * is meant to make impossible. */
function mailRuleMatches(
  rule: Pick<MailAuthorizationRule, "domainId" | "addressPattern">,
  domainId: DomainId,
  address: EmailAddress,
): boolean {
  if (rule.domainId !== null && rule.domainId !== domainId) {
    return false;
  }
  return matchAddressPattern(rule.addressPattern, address);
}

/** Whether `filter`'s rules authorize at least one of `addresses` in
 * `domainId`. Each candidate address is evaluated independently in the
 * order the design doc specifies: a matching DENY always rejects that one
 * address; otherwise `filter.baseline` (an ADMIN) covers it, and a
 * non-baseline viewer (MEMBER/VIEWER) needs a matching ALLOW. A DENY on one
 * address never hides a message that is independently authorized through
 * another address. Takes an already-resolved `MailPermissionFilter` rather
 * than a `Viewer`, so in-memory test doubles for listing repositories can
 * honor a USER viewer's mailbox rules without re-implementing the rule
 * semantics themselves. */
export function mailPermissionFilterAuthorizesAnyAddress(
  filter: MailPermissionFilter,
  domainId: DomainId,
  addresses: readonly EmailAddress[],
): boolean {
  return addresses.some((address) => {
    const denied = filter.rules.some(
      (rule) =>
        rule.effect === "DENY" && mailRuleMatches(rule, domainId, address),
    );
    if (denied) {
      return false;
    }
    if (filter.baseline) {
      return true;
    }
    return filter.rules.some(
      (rule) =>
        rule.effect === "ALLOW" && mailRuleMatches(rule, domainId, address),
    );
  });
}

/** Non-throwing per-address check. Passes when **any** of `addresses` is
 * authorized: a message with several envelope recipients is readable when
 * the key covers even one of them. */
export function authorizesAnyAddress(
  viewer: Viewer,
  capability: Capability,
  domainId: DomainId,
  addresses: readonly EmailAddress[],
): boolean {
  if (viewer.kind === "USER") {
    if (isGlobalCapability(capability)) {
      return false;
    }
    return mailPermissionFilterAuthorizesAnyAddress(
      {
        baseline: viewer.role === UserRole.Admin,
        rules: mailAuthorizationRules(viewer, capability),
      },
      domainId,
      addresses,
    );
  }
  return addresses.some((address) =>
    scopesAuthorize(viewer.scopes, { capability, domainId, address }),
  );
}

/** Throwing per-address check, for write operations. Reads must **not** use
 * this: an unauthorized read is reported as `NOT_FOUND` by its use case, so
 * a key cannot probe for the existence of addresses outside its scope. */
export function requireAddressCapability(
  viewer: Viewer,
  capability: Capability,
  domainId: DomainId,
  addresses: readonly EmailAddress[],
): void {
  if (!authorizesAnyAddress(viewer, capability, domainId, addresses)) {
    throw new ForbiddenError(
      `This credential is not permitted to perform ${capability} on the requested address`,
    );
  }
}

/** The address patterns a listing query must be filtered by.
 *
 * `null` means unrestricted (a user viewer). An **empty array** means the
 * viewer holds no scope for this capability at all and must therefore see
 * nothing -- callers and the repository must treat that as "match none",
 * never as "no filter". */
export function readableAddressPatterns(
  viewer: Viewer,
  capability: Capability,
): readonly AddressPattern[] | null {
  if (viewer.kind === "USER") {
    return null;
  }
  return scopesForCapability(viewer.scopes, capability).map(
    (scope) => scope.addressPattern,
  );
}

/** The domain ids a listing query must be restricted to, or `null` for
 * unrestricted. A scope with a `null` `domainId` is a wildcard, so the
 * presence of even one collapses the whole result to `null`. */
export function scopedDomainIds(
  viewer: Viewer,
  capability: Capability,
): readonly DomainId[] | null {
  if (viewer.kind === "USER") {
    return null;
  }
  const scopes = scopesForCapability(viewer.scopes, capability);
  if (scopes.length === 0) {
    // No scope for this capability: nothing is visible. Signalled as an
    // empty array rather than `null`, which would mean "everything".
    return [];
  }
  const ids: DomainId[] = [];
  for (const scope of scopes) {
    if (scope.domainId === null) {
      return null;
    }
    if (!ids.includes(scope.domainId)) {
      ids.push(scope.domainId);
    }
  }
  return ids;
}

/** Identity of a calendar's owner, as an authorization decision needs it.
 *
 * The owner's *account email* (plus its domain, when that domain is managed
 * here) is what an API key's calendar scope is matched against, mirroring
 * how a mail scope is matched against a mailbox address. */
export interface CalendarOwnerRef {
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly domainId: DomainId | null;
}

function keyAuthorizesCalendar(
  viewer: Extract<Viewer, { kind: "API_KEY" }>,
  capability: CalendarCapability,
  owner: CalendarOwnerRef,
): boolean {
  return viewer.scopes.some(
    (scope) =>
      scope.capability === capability &&
      (scope.domainId === null || scope.domainId === owner.domainId) &&
      matchAddressPattern(scope.addressPattern, owner.email),
  );
}

/** One calendar capability check, for either credential kind.
 *
 * A per-user DENY rule is consulted before *every* other consideration,
 * including an admin's, so an admin's default access to every calendar can
 * be revoked while leaving that admin able to administer permissions -- as
 * in mail: `addUserCalendarPermission` is gated on the ADMIN role, and never
 * on whether the admin can read the calendar it is granting. */
export function authorizesCalendarCapability(
  viewer: Viewer,
  capability: CalendarCapability,
  owner: CalendarOwnerRef,
): boolean {
  if (viewer.kind === "USER") {
    return resolveUserCalendarCapability(viewer, capability, owner.userId);
  }
  return keyAuthorizesCalendar(viewer, capability, owner);
}

/** Non-throwing calendar read check. A failing read is reported by its use
 * case as `NOT_FOUND`, never `FORBIDDEN`. */
export function authorizesCalendarRead(
  viewer: Viewer,
  owner: CalendarOwnerRef,
): boolean {
  return authorizesCalendarCapability(viewer, Capability.CalendarRead, owner);
}

export function authorizesCalendarWrite(
  viewer: Viewer,
  owner: CalendarOwnerRef,
): boolean {
  return authorizesCalendarCapability(viewer, Capability.CalendarWrite, owner);
}

/** Throwing write check. Callers must have already established that the
 * viewer can *read* the calendar, so reporting FORBIDDEN here leaks nothing
 * the caller does not already know. */
export function requireCalendarWrite(
  viewer: Viewer,
  owner: CalendarOwnerRef,
): void {
  if (!authorizesCalendarWrite(viewer, owner)) {
    throw new ForbiddenError(
      "This credential is not permitted to modify this calendar",
    );
  }
}

/** Read authorization for one event: calendar-level read, or a mention of
 * the viewer's own account address. A mention grants that one event, read
 * only -- never the calendar, and never a write. */
export function authorizesEventRead(
  viewer: Viewer,
  owner: CalendarOwnerRef,
  mentions: readonly EmailAddress[],
  viewerEmail: EmailAddress | null,
): boolean {
  if (authorizesCalendarRead(viewer, owner)) {
    return true;
  }
  return viewerEmail !== null && mentions.includes(viewerEmail);
}

/** Narrows to a USER viewer, for the operations that need a user identity to
 * act on -- creating a calendar needs an owner, and a key inherits none. */
export function requireUserViewer(
  viewer: Viewer,
  message: string,
): Extract<Viewer, { kind: "USER" }> {
  if (viewer.kind !== "USER") {
    throw new ForbiddenError(message);
  }
  return viewer;
}

/** CalDAV accounts are strictly per-user: an API key must not be able to
 * connect, rotate or delete one, because that would let an agent exfiltrate
 * a person's iCloud credentials. A suitably scoped key may still trigger
 * `syncCalendar`, which touches no credential of its own. */
export function requireCaldavAccountUser(viewer: Viewer): UserId {
  return requireUserViewer(
    viewer,
    "CalDAV accounts can only be managed by a signed-in user",
  ).userId;
}

/** Non-throwing template capability check. Templates are instance-wide, so
 * there is no address axis: a key's scope is the capability alone. */
export function authorizesTemplateCapability(
  viewer: Viewer,
  capability: TemplateCapability,
): boolean {
  if (viewer.kind === "USER") {
    return resolveUserTemplateCapability(
      viewer.role,
      viewer.templatePermissions,
      capability,
    );
  }
  return viewer.scopes.some((scope) => scope.capability === capability);
}

export function requireTemplateCapability(
  viewer: Viewer,
  capability: TemplateCapability,
): void {
  if (!authorizesTemplateCapability(viewer, capability)) {
    throw new ForbiddenError(
      `This credential is not permitted to perform ${capability} operations`,
    );
  }
}
