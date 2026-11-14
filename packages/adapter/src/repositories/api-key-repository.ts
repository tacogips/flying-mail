import type { ApiKeyRepository } from "@mailcal/application/ports/api-key-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type ApiKey,
  type ApiKeyScope,
  Capability,
} from "@mailcal/domain/entities/api-key";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createDomainId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, buildInPlaceholders } from "./sql-helpers";

interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly key_hash: string;
  readonly key_prefix: string;
  readonly created_by_user_id: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

interface ApiKeyScopeRow {
  readonly id: string;
  readonly api_key_id: string;
  readonly capability: string;
  readonly domain_id: string | null;
  readonly address_pattern: string;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: createApiKeyId(row.id),
    name: row.name,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    createdByUserId:
      row.created_by_user_id === null
        ? null
        : createUserId(row.created_by_user_id),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function rowToScope(row: ApiKeyScopeRow): ApiKeyScope {
  return {
    id: createApiKeyScopeId(row.id),
    apiKeyId: createApiKeyId(row.api_key_id),
    capability: assertEnumValue(Capability, row.capability, "capability"),
    domainId: row.domain_id === null ? null : createDomainId(row.domain_id),
    addressPattern:
      row.address_pattern === "*"
        ? MATCH_ALL_ADDRESSES
        : createAddressPattern(row.address_pattern),
  };
}

const UPSERT_KEY_SQL = `INSERT INTO api_keys
  (id, name, key_hash, key_prefix, created_by_user_id, created_at, last_used_at, expires_at, revoked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    last_used_at = excluded.last_used_at,
    expires_at = excluded.expires_at,
    revoked_at = excluded.revoked_at`;

const UPSERT_SCOPE_SQL = `INSERT INTO api_key_scopes
  (id, api_key_id, capability, domain_id, address_pattern)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    capability = excluded.capability,
    domain_id = excluded.domain_id,
    address_pattern = excluded.address_pattern`;

/** No dedicated revoke/touch methods on the port: callers mutate the entity
 * and call `save()`. `findByKeyHash` deliberately returns revoked and
 * expired keys too -- the caller checks `isApiKeyUsable`, which keeps
 * "revoked" distinguishable from "unknown" for auditing without the
 * repository encoding policy. */
export function createApiKeyRepository(db: SqlDatabase): ApiKeyRepository {
  return {
    async findByKeyHash(keyHash) {
      const rows = await db.query<ApiKeyRow>(
        "SELECT * FROM api_keys WHERE key_hash = ?",
        [keyHash],
      );
      return rows[0] === undefined ? null : rowToApiKey(rows[0]);
    },

    async findById(id) {
      const rows = await db.query<ApiKeyRow>(
        "SELECT * FROM api_keys WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToApiKey(rows[0]);
    },

    async list() {
      const rows = await db.query<ApiKeyRow>(
        "SELECT * FROM api_keys ORDER BY created_at DESC",
      );
      return rows.map(rowToApiKey);
    },

    async save(key) {
      await db.execute(UPSERT_KEY_SQL, [
        key.id,
        key.name,
        key.keyHash,
        key.keyPrefix,
        key.createdByUserId,
        key.createdAt,
        key.lastUsedAt,
        key.expiresAt,
        key.revokedAt,
      ]);
    },

    async listScopes(ids) {
      const grouped = new Map<string, ApiKeyScope[]>(
        ids.map((id) => [id as string, []]),
      );
      if (ids.length === 0) {
        return grouped;
      }
      const rows = await db.query<ApiKeyScopeRow>(
        `SELECT * FROM api_key_scopes
         WHERE api_key_id IN (${buildInPlaceholders(ids.length)})
         ORDER BY capability ASC`,
        [...ids],
      );
      for (const row of rows) {
        grouped.get(row.api_key_id)?.push(rowToScope(row));
      }
      return grouped;
    },

    async findScopeById(id) {
      const rows = await db.query<ApiKeyScopeRow>(
        "SELECT * FROM api_key_scopes WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToScope(rows[0]);
    },

    async saveScope(scope) {
      await db.execute(UPSERT_SCOPE_SQL, [
        scope.id,
        scope.apiKeyId,
        scope.capability,
        scope.domainId,
        scope.addressPattern,
      ]);
    },

    async deleteScope(id) {
      await db.execute("DELETE FROM api_key_scopes WHERE id = ?", [id]);
    },
  };
}
