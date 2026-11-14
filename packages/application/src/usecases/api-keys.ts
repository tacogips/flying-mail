import {
  type ApiKey,
  type ApiKeyScope,
  Capability,
  createApiKey,
  createApiKeyScope,
  isGlobalCapability,
  revokeApiKey,
  scopesAuthorizeGlobal,
} from "@mailcal/domain/entities/api-key";
import {
  type AddressPattern,
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
  matchAddressPattern,
} from "@mailcal/domain/value-objects/address-pattern";
import { parseEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  type ApiKeyId,
  type ApiKeyScopeId,
  createApiKeyId,
  createApiKeyScopeId,
  type DomainId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import { requireGlobalCapability } from "../policies/authorization";
import { isAdminViewer, type Viewer } from "../policies/viewer";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** `ybm_<prefix>_<secret>`. The prefix is stored in clear text so a key can
 * be identified and revoked without retaining the secret; the whole
 * presented string is what gets hashed. */
export const API_KEY_NAMESPACE = "ybm";
const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface GeneratedApiKey {
  /** Returned to the caller exactly once and never stored. */
  readonly secret: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
}

export async function generateApiKeySecret(
  deps: AppDependencies,
): Promise<GeneratedApiKey> {
  const keyPrefix = `${API_KEY_NAMESPACE}_${toHex(deps.random.tokenBytes(PREFIX_BYTES))}`;
  const secret = `${keyPrefix}_${toBase64Url(deps.random.tokenBytes(SECRET_BYTES))}`;
  return {
    secret,
    keyPrefix,
    keyHash: await deps.tokenHasher.hash(secret),
  };
}

export interface ApiKeyScopeInput {
  readonly capability: Capability;
  readonly domainId: DomainId | null;
  readonly addressPattern: string;
}

export interface CreateApiKeyUseCaseInput {
  readonly name: string;
  readonly scopes: readonly ApiKeyScopeInput[];
  readonly expiresAt: string | null;
}

export interface ApiKeyWithSecret {
  readonly apiKey: ApiKey;
  readonly scopes: readonly ApiKeyScope[];
  readonly secret: string;
}

async function assertDomainExists(
  deps: AppDependencies,
  domainId: DomainId | null,
): Promise<void> {
  if (domainId === null) {
    return;
  }
  const domain = await deps.mailDomainRepository.findById(domainId);
  if (domain === null) {
    throw new NotFoundError("Domain", domainId);
  }
}

function parsePattern(value: string): AddressPattern {
  return value === "*"
    ? MATCH_ALL_ADDRESSES
    : createAddressPattern(value, "scope.addressPattern");
}

/** True when `candidate` grants no more than `held` does.
 *
 * A pattern is narrower when it is identical, or when the holder's pattern
 * is a domain-wide/global wildcard that already covers the candidate's
 * concrete address. Anything less obvious is treated as *not* narrower --
 * failing closed, because the cost of a wrong "yes" here is privilege
 * escalation. */
function scopeIsWithin(
  candidate: {
    capability: Capability;
    domainId: DomainId | null;
    addressPattern: AddressPattern;
  },
  held: ApiKeyScope,
): boolean {
  if (held.capability !== candidate.capability) {
    return false;
  }
  if (held.domainId !== null && held.domainId !== candidate.domainId) {
    return false;
  }
  if (held.addressPattern === MATCH_ALL_ADDRESSES) {
    return true;
  }
  if (held.addressPattern === candidate.addressPattern) {
    return true;
  }
  const concrete = parseEmailAddress(candidate.addressPattern);
  return (
    concrete !== null && matchAddressPattern(held.addressPattern, concrete)
  );
}

/** Stops `KEY_ADMIN` from being an escalation path: a key issuing another
 * key may only grant scopes it already holds. An `ADMIN` user is
 * unrestricted -- it is already the top of the authority chain. */
function assertGrantable(
  viewer: Viewer,
  scope: {
    capability: Capability;
    domainId: DomainId | null;
    addressPattern: AddressPattern;
  },
): void {
  if (viewer.kind === "USER") {
    if (isAdminViewer(viewer)) {
      return;
    }
    throw new ForbiddenError("Only an admin user may issue API keys");
  }
  const permitted = isGlobalCapability(scope.capability)
    ? scopesAuthorizeGlobal(viewer.scopes, scope.capability)
    : viewer.scopes.some((held) => scopeIsWithin(scope, held));
  if (!permitted) {
    throw new ForbiddenError(
      `This credential cannot grant ${scope.capability} on ${scope.addressPattern}`,
    );
  }
}

export function createCreateApiKeyUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: CreateApiKeyUseCaseInput,
) => Promise<ApiKeyWithSecret> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.KeyAdmin);
      if (input.scopes.length === 0) {
        // An unscoped key grants nothing; issuing one would leave a
        // credential that looks usable and silently is not.
        throw new BadUserInputError(
          "An API key must be issued with at least one scope",
          "scopes",
        );
      }

      const generated = await generateApiKeySecret(deps);
      const now = deps.clock.now().toISOString();
      const apiKeyId = createApiKeyId(deps.random.uuid());

      const scopes: ApiKeyScope[] = [];
      for (const scopeInput of input.scopes) {
        await assertDomainExists(deps, scopeInput.domainId);
        const addressPattern = parsePattern(scopeInput.addressPattern);
        assertGrantable(viewer, {
          capability: scopeInput.capability,
          domainId: scopeInput.domainId,
          addressPattern,
        });
        scopes.push(
          createApiKeyScope({
            id: createApiKeyScopeId(deps.random.uuid()),
            apiKeyId,
            capability: scopeInput.capability,
            domainId: scopeInput.domainId,
            addressPattern,
          }),
        );
      }

      const apiKey = createApiKey({
        id: apiKeyId,
        name: input.name,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        createdByUserId: viewer.kind === "USER" ? viewer.userId : null,
        expiresAt: input.expiresAt,
        createdAt: now,
      });

      await deps.apiKeyRepository.save(apiKey);
      for (const scope of scopes) {
        await deps.apiKeyRepository.saveScope(scope);
      }

      return { apiKey, scopes, secret: generated.secret };
    });
}

export function createListApiKeysUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly ApiKey[]> {
  return async (viewer) => {
    requireGlobalCapability(viewer, Capability.KeyAdmin);
    return deps.apiKeyRepository.list();
  };
}

export function createRevokeApiKeyUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ApiKeyId) => Promise<ApiKey> {
  return async (viewer, id) => {
    requireGlobalCapability(viewer, Capability.KeyAdmin);
    const key = await deps.apiKeyRepository.findById(id);
    if (key === null) {
      throw new NotFoundError("ApiKey", id);
    }
    const revoked = revokeApiKey(key, deps.clock.now().toISOString());
    await deps.apiKeyRepository.save(revoked);
    return revoked;
  };
}

export function createAddApiKeyScopeUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  apiKeyId: ApiKeyId,
  scope: ApiKeyScopeInput,
) => Promise<readonly ApiKeyScope[]> {
  return async (viewer, apiKeyId, scopeInput) =>
    withAsyncDomainErrorTranslation(async () => {
      requireGlobalCapability(viewer, Capability.KeyAdmin);
      const key = await deps.apiKeyRepository.findById(apiKeyId);
      if (key === null) {
        throw new NotFoundError("ApiKey", apiKeyId);
      }
      await assertDomainExists(deps, scopeInput.domainId);
      const addressPattern = parsePattern(scopeInput.addressPattern);
      assertGrantable(viewer, {
        capability: scopeInput.capability,
        domainId: scopeInput.domainId,
        addressPattern,
      });
      const scope = createApiKeyScope({
        id: createApiKeyScopeId(deps.random.uuid()),
        apiKeyId,
        capability: scopeInput.capability,
        domainId: scopeInput.domainId,
        addressPattern,
      });
      await deps.apiKeyRepository.saveScope(scope);
      const byKey = await deps.apiKeyRepository.listScopes([apiKeyId]);
      return byKey.get(apiKeyId) ?? [];
    });
}

export function createRemoveApiKeyScopeUseCase(
  deps: AppDependencies,
): (viewer: Viewer, scopeId: ApiKeyScopeId) => Promise<boolean> {
  return async (viewer, scopeId) => {
    requireGlobalCapability(viewer, Capability.KeyAdmin);
    const scope = await deps.apiKeyRepository.findScopeById(scopeId);
    if (scope === null) {
      throw new NotFoundError("ApiKeyScope", scopeId);
    }
    await deps.apiKeyRepository.deleteScope(scopeId);
    return true;
  };
}

export function createListApiKeyScopesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  ids: readonly ApiKeyId[],
) => Promise<ReadonlyMap<string, readonly ApiKeyScope[]>> {
  return async (viewer, ids) => {
    requireGlobalCapability(viewer, Capability.KeyAdmin);
    return deps.apiKeyRepository.listScopes(ids);
  };
}
