import type { ApiKeyScope } from "@mailcal/domain/entities/api-key";
import type { UserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import type { UserMailPermission } from "@mailcal/domain/entities/user-mail-permission";
import type { UserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import { UserRole } from "@mailcal/domain/entities/user";
import type { ApiKeyId, UserId } from "@mailcal/domain/value-objects/ids";

/** Both credential kinds resolve to this one union, which every use case
 * takes as its first argument.
 *
 * An `API_KEY` viewer is authorized purely by its own scope list -- there is
 * deliberately no inheritance from the user that created it, so deactivating
 * a user neither silently widens nor narrows an existing key's reach. A
 * `USER` viewer carries the permission snapshot loaded for its current
 * request; it is never reused as session state. */
export type Viewer =
  | {
      readonly kind: "USER";
      readonly userId: UserId;
      readonly role: UserRole;
      readonly permissions: readonly UserMailPermission[];
      /** Admin-assigned template rules, loaded alongside the mail ones. */
      readonly templatePermissions: readonly UserTemplatePermission[];
      /** Admin-assigned calendar rules, layered over the role baseline. */
      readonly calendarPermissions: readonly UserCalendarPermission[];
    }
  | {
      readonly kind: "API_KEY";
      readonly apiKeyId: ApiKeyId;
      readonly scopes: readonly ApiKeyScope[];
    };

export function isUserViewer(
  viewer: Viewer,
): viewer is Extract<Viewer, { kind: "USER" }> {
  return viewer.kind === "USER";
}

export function isApiKeyViewer(
  viewer: Viewer,
): viewer is Extract<Viewer, { kind: "API_KEY" }> {
  return viewer.kind === "API_KEY";
}

/** True only for an `ADMIN` *user*. An API key never counts as an admin
 * regardless of its scopes -- `DOMAIN_ADMIN`/`KEY_ADMIN` are checked
 * individually, so a key holding one does not thereby acquire the other. */
export function isAdminViewer(viewer: Viewer): boolean {
  return viewer.kind === "USER" && viewer.role === UserRole.Admin;
}

/** The calling API key's id, or `null` for a user viewer. Fetch state is
 * keyed by this, which is why a user viewer has none of its own. */
export function viewerApiKeyId(viewer: Viewer): ApiKeyId | null {
  return viewer.kind === "API_KEY" ? viewer.apiKeyId : null;
}

/** A short, non-secret identifier for logs and error context. Never
 * includes a key secret or hash. */
export function describeViewer(viewer: Viewer): string {
  return viewer.kind === "USER"
    ? `user:${viewer.userId}`
    : `apiKey:${viewer.apiKeyId}`;
}
