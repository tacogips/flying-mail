import type { ApiKeyScopeView, Capability } from "../api/schema-types";

/** Human-readable label for each capability, so the key settings page does
 * not show raw enum names to an operator. */
export const CAPABILITY_LABELS: Readonly<Record<Capability, string>> = {
  MAIL_READ: "Read mail",
  MAIL_SEND: "Send mail",
  MAIL_MANAGE: "Manage mail (tag, mark, delete)",
  FILE_LINK: "Create file links",
  DOMAIN_ADMIN: "Administer domains",
  TEMPLATE_READ: "Read templates",
  TEMPLATE_CREATE: "Create templates",
  TEMPLATE_UPDATE: "Update templates",
  TEMPLATE_DELETE: "Delete templates",
  CALENDAR_READ: "Read calendars",
  CALENDAR_WRITE: "Write calendars",
  KEY_ADMIN: "Issue and revoke API keys",
};

/** Capabilities that are instance-wide, so the scope builder can hide the
 * domain and address controls for them rather than offering inputs the
 * server will ignore. */
export const GLOBAL_CAPABILITIES: readonly Capability[] = [
  "DOMAIN_ADMIN",
  "KEY_ADMIN",
];

export function isGlobalCapability(capability: Capability): boolean {
  return GLOBAL_CAPABILITIES.includes(capability);
}

/** One readable line describing exactly what a scope grants. */
export function formatScope(scope: ApiKeyScopeView): string {
  const label = CAPABILITY_LABELS[scope.capability];
  if (isGlobalCapability(scope.capability)) {
    return `${label} (instance-wide)`;
  }
  const domain =
    scope.domain === null ? "every managed domain" : scope.domain.name;
  const addresses =
    scope.addressPattern === "*"
      ? "every address"
      : `addresses matching ${scope.addressPattern}`;
  return `${label} on ${domain}, ${addresses}`;
}

/**
 * Client-side mirror of the server's `AddressPattern` grammar, so the scope
 * builder can reject an invalid pattern before issuing a key rather than
 * surfacing a server error afterwards.
 *
 * Kept intentionally strict and identical to the server rule: at most one
 * `*`, only in the local part (or as the whole pattern), and a literal
 * domain part. A client check that were looser than the server would just
 * move the failure later; one that were tighter would block valid scopes.
 */
export function isValidAddressPattern(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  if (normalized === "*") {
    return true;
  }
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) {
    return false;
  }
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);

  if (local.includes("@") || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    return false;
  }
  if (local.split("*").length - 1 > 1) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || domain.length > 253) {
    return false;
  }
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}
