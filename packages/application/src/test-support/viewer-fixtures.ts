import {
  type ApiKeyScope,
  Capability,
  createApiKeyScope,
} from "@flying-mail/domain/entities/api-key";
import { UserRole } from "@flying-mail/domain/entities/user";
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
import {
  type ApiKeyId,
  createApiKeyId,
  createApiKeyScopeId,
  createUserId,
  createUserMailPermissionId,
  createUserTemplatePermissionId,
  type DomainId,
  type UserId,
} from "@flying-mail/domain/value-objects/ids";
import type { TemplateCapability } from "@flying-mail/domain/entities/api-key";
import {
  createUserTemplatePermission,
  type UserTemplatePermission,
} from "@flying-mail/domain/entities/user-template-permission";
import type { Viewer } from "../policies/viewer";

const DEFAULT_PERMISSION_CREATED_AT = "2026-08-23T00:00:00.000Z";

export function adminViewer(
  userId = "usr-admin",
  permissions: readonly UserMailPermission[] = [],
  templatePermissions: readonly UserTemplatePermission[] = [],
): Viewer {
  return {
    kind: "USER",
    userId: createUserId(userId),
    role: UserRole.Admin,
    permissions,
    templatePermissions,
  };
}

export function memberViewer(
  userId = "usr-member",
  permissions: readonly UserMailPermission[] = [],
  templatePermissions: readonly UserTemplatePermission[] = [],
): Viewer {
  return {
    kind: "USER",
    userId: createUserId(userId),
    role: UserRole.Member,
    permissions,
    templatePermissions,
  };
}

export function viewerViewer(
  userId = "usr-viewer",
  permissions: readonly UserMailPermission[] = [],
  templatePermissions: readonly UserTemplatePermission[] = [],
): Viewer {
  return {
    kind: "USER",
    userId: createUserId(userId),
    role: UserRole.Viewer,
    permissions,
    templatePermissions,
  };
}

export interface MailPermissionSpec {
  readonly effect: "ALLOW" | "DENY";
  readonly domainId?: DomainId | null;
  readonly addressPattern?: string;
  readonly createdByUserId?: UserId;
}

/** Builds a `UserMailPermission[]` list with generated ids, so tests declare
 * only the `(effect, domainId, addressPattern)` triple they care about. */
export function buildMailPermissions(
  userId: UserId,
  specs: readonly MailPermissionSpec[],
): readonly UserMailPermission[] {
  return specs.map((spec, index) =>
    createUserMailPermission({
      id: createUserMailPermissionId(`ump-${index + 1}`),
      userId,
      effect:
        spec.effect === "ALLOW"
          ? UserPermissionEffect.Allow
          : UserPermissionEffect.Deny,
      domainId: spec.domainId ?? null,
      addressPattern: toPattern(spec.addressPattern),
      createdByUserId: spec.createdByUserId ?? userId,
      createdAt: DEFAULT_PERMISSION_CREATED_AT,
    }),
  );
}

export interface ScopeSpec {
  readonly capability: Capability;
  readonly domainId?: DomainId | null;
  readonly addressPattern?: string;
}

/** Builds a scope list with generated ids, so tests declare only what they
 * care about. */
export function buildScopes(
  apiKeyId: ApiKeyId,
  specs: readonly ScopeSpec[],
): readonly ApiKeyScope[] {
  return specs.map((spec, index) =>
    createApiKeyScope({
      id: createApiKeyScopeId(`scope-${index + 1}`),
      apiKeyId,
      capability: spec.capability,
      domainId: spec.domainId ?? null,
      addressPattern: toPattern(spec.addressPattern),
    }),
  );
}

function toPattern(value: string | undefined): AddressPattern {
  return value === undefined || value === "*"
    ? MATCH_ALL_ADDRESSES
    : createAddressPattern(value);
}

export function apiKeyViewer(
  specs: readonly ScopeSpec[],
  apiKeyIdValue = "key-1",
): Viewer {
  const apiKeyId = createApiKeyId(apiKeyIdValue);
  return { kind: "API_KEY", apiKeyId, scopes: buildScopes(apiKeyId, specs) };
}

/** A key scoped to exactly one mailbox, with the four per-address
 * capabilities -- the support-desk agent from the design doc. */
export function mailboxAgentViewer(
  domainId: DomainId,
  address: string,
  apiKeyIdValue = "key-agent",
): Viewer {
  return apiKeyViewer(
    [
      { capability: Capability.MailRead, domainId, addressPattern: address },
      { capability: Capability.MailSend, domainId, addressPattern: address },
      { capability: Capability.MailManage, domainId, addressPattern: address },
      { capability: Capability.FileLink, domainId, addressPattern: address },
    ],
    apiKeyIdValue,
  );
}

/** Builds a `UserTemplatePermission[]` list with generated ids, so a test
 * declares only the `(capability, effect)` pairs it cares about. */
export function buildTemplatePermissions(
  userId: UserId,
  specs: readonly {
    readonly capability: TemplateCapability;
    readonly effect: UserPermissionEffect;
  }[],
): readonly UserTemplatePermission[] {
  return specs.map((spec) =>
    createUserTemplatePermission({
      id: createUserTemplatePermissionId(
        `utp-${spec.capability}-${spec.effect}`,
      ),
      userId,
      capability: spec.capability,
      effect: spec.effect,
      createdByUserId: createUserId("usr-admin"),
      createdAt: DEFAULT_PERMISSION_CREATED_AT,
    }),
  );
}
