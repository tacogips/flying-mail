import type { ApiKey, ApiKeyScope } from "@mailcal/domain/entities/api-key";
import type {
  ApiKeyId,
  ApiKeyScopeId,
} from "@mailcal/domain/value-objects/ids";

export interface ApiKeyRepository {
  /** Returns revoked and expired keys too; the caller checks
   * `isApiKeyUsable`, so that "revoked" and "unknown" stay distinguishable
   * for auditing without the repository encoding policy. */
  findByKeyHash(keyHash: string): Promise<ApiKey | null>;
  findById(id: ApiKeyId): Promise<ApiKey | null>;
  list(): Promise<readonly ApiKey[]>;
  save(key: ApiKey): Promise<void>;
  /** Batch lookup keyed by API key id, so listing keys with their scopes is
   * two queries rather than N+1. */
  listScopes(
    ids: readonly ApiKeyId[],
  ): Promise<ReadonlyMap<string, readonly ApiKeyScope[]>>;
  findScopeById(id: ApiKeyScopeId): Promise<ApiKeyScope | null>;
  saveScope(scope: ApiKeyScope): Promise<void>;
  deleteScope(id: ApiKeyScopeId): Promise<void>;
}
