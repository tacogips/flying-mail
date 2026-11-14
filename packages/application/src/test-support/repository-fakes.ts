import type { ApiKey, ApiKeyScope } from "@mailcal/domain/entities/api-key";
import type { EmailAuthChallenge } from "@mailcal/domain/entities/email-auth-challenge";
import type { FileLink } from "@mailcal/domain/entities/file-link";
import type { MailAddress } from "@mailcal/domain/entities/mail-address";
import type { MailDomain } from "@mailcal/domain/entities/mail-domain";
import type { Session } from "@mailcal/domain/entities/session";
import {
  createSystemTag,
  SYSTEM_TAG_DEFAULTS,
  type SystemTagSlug,
  type Tag,
} from "@mailcal/domain/entities/tag";
import type { User } from "@mailcal/domain/entities/user";
import type { UserMailPermission } from "@mailcal/domain/entities/user-mail-permission";
import { createTagId } from "@mailcal/domain/value-objects/ids";
import type { ApiKeyRepository } from "../ports/api-key-repository";
import type {
  EmailAuthChallengeRepository,
  SessionRepository,
  UserRepository,
} from "../ports/auth-repository";
import type { FileLinkRepository } from "../ports/file-link-repository";
import type { MailAddressRepository } from "../ports/mail-address-repository";
import type { MailDomainRepository } from "../ports/mail-domain-repository";
import type { TagRepository } from "../ports/tag-repository";
import type { UserMailPermissionRepository } from "../ports/user-mail-permission-repository";

/** Backing stores exposed so tests can seed and assert directly rather than
 * driving every setup through use cases. */
export interface FakeStores {
  readonly domains: Map<string, MailDomain>;
  readonly mailAddresses: Map<string, MailAddress>;
  readonly tags: Map<string, Tag>;
  readonly apiKeys: Map<string, ApiKey>;
  readonly apiKeyScopes: Map<string, ApiKeyScope>;
  readonly fileLinks: Map<string, FileLink>;
  readonly users: Map<string, User>;
  readonly userMailPermissions: Map<string, UserMailPermission>;
  readonly sessions: Map<string, Session>;
  readonly challenges: Map<string, EmailAuthChallenge>;
  /** Message counts per domain, consulted by `countMessages`. */
  readonly domainMessageCounts: Map<string, number>;
  /** Addresses treated as known local parts by `hasKnownLocalPart`. */
  readonly knownAddresses: Set<string>;
}

export function createFakeStores(): FakeStores {
  return {
    domains: new Map(),
    mailAddresses: new Map(),
    tags: new Map(),
    apiKeys: new Map(),
    apiKeyScopes: new Map(),
    fileLinks: new Map(),
    users: new Map(),
    userMailPermissions: new Map(),
    sessions: new Map(),
    challenges: new Map(),
    domainMessageCounts: new Map(),
    knownAddresses: new Set(),
  };
}

/** Seeds the four system tags with stable ids (`tag-spam`, ...), matching
 * what the initial migration does in a real deployment. */
export function seedSystemTags(
  stores: FakeStores,
  createdAt = "2026-08-23T00:00:00.000Z",
): void {
  for (const [slug, defaults] of SYSTEM_TAG_DEFAULTS) {
    const id = createTagId(`tag-${slug.toLowerCase()}`);
    stores.tags.set(
      id,
      createSystemTag({
        id,
        slug,
        name: defaults.name,
        color: defaults.color,
        createdAt,
      }),
    );
  }
}

export function fakeMailAddressRepository(
  stores: FakeStores,
  messageCounts: ReadonlyMap<string, number> = new Map(),
): MailAddressRepository {
  return {
    async findById(id) {
      return stores.mailAddresses.get(id) ?? null;
    },
    async findByAddress(address) {
      return (
        [...stores.mailAddresses.values()].find(
          (entry) => entry.address === address,
        ) ?? null
      );
    },
    async listByDomain(domainId) {
      return [...stores.mailAddresses.values()]
        .filter((entry) => entry.domainId === domainId)
        .sort((a, b) => a.localPart.localeCompare(b.localPart));
    },
    async list() {
      return [...stores.mailAddresses.values()].sort((a, b) =>
        a.address.localeCompare(b.address),
      );
    },
    async save(address) {
      stores.mailAddresses.set(address.id, address);
    },
    async delete(id) {
      stores.mailAddresses.delete(id);
    },
    async countMessages(id) {
      return messageCounts.get(id) ?? 0;
    },
  };
}

export function fakeMailDomainRepository(
  stores: FakeStores,
): MailDomainRepository {
  return {
    async findById(id) {
      return stores.domains.get(id) ?? null;
    },
    async findByName(name) {
      for (const domain of stores.domains.values()) {
        if (domain.name === name) {
          return domain;
        }
      }
      return null;
    },
    async list() {
      return [...stores.domains.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    },
    async save(domain) {
      stores.domains.set(domain.id, domain);
    },
    async delete(id) {
      stores.domains.delete(id);
    },
    async countMessages(id) {
      return stores.domainMessageCounts.get(id) ?? 0;
    },
    async hasKnownLocalPart(_id, address) {
      return stores.knownAddresses.has(address);
    },
  };
}

export function fakeTagRepository(stores: FakeStores): TagRepository {
  return {
    async findById(id) {
      return stores.tags.get(id) ?? null;
    },
    async findByIds(ids) {
      const found: Tag[] = [];
      for (const id of ids) {
        const tag = stores.tags.get(id);
        if (tag !== undefined) {
          found.push(tag);
        }
      }
      return found;
    },
    async findByName(name) {
      const target = name.trim().toLowerCase();
      for (const tag of stores.tags.values()) {
        if (tag.name.toLowerCase() === target) {
          return tag;
        }
      }
      return null;
    },
    async findBySystemSlug(slug: SystemTagSlug) {
      for (const tag of stores.tags.values()) {
        if (tag.systemSlug === slug) {
          return tag;
        }
      }
      return null;
    },
    async list() {
      return [...stores.tags.values()];
    },
    async countMessages(ids) {
      return new Map(ids.map((id) => [id as string, 0]));
    },
    async save(tag) {
      stores.tags.set(tag.id, tag);
    },
    async delete(id) {
      stores.tags.delete(id);
    },
  };
}

export function fakeApiKeyRepository(stores: FakeStores): ApiKeyRepository {
  return {
    async findByKeyHash(keyHash) {
      for (const key of stores.apiKeys.values()) {
        if (key.keyHash === keyHash) {
          return key;
        }
      }
      return null;
    },
    async findById(id) {
      return stores.apiKeys.get(id) ?? null;
    },
    async list() {
      return [...stores.apiKeys.values()];
    },
    async save(key) {
      stores.apiKeys.set(key.id, key);
    },
    async listScopes(ids) {
      const wanted = new Set<string>(ids);
      const grouped = new Map<string, ApiKeyScope[]>();
      for (const id of wanted) {
        grouped.set(id, []);
      }
      for (const scope of stores.apiKeyScopes.values()) {
        if (wanted.has(scope.apiKeyId)) {
          grouped.get(scope.apiKeyId)?.push(scope);
        }
      }
      return grouped;
    },
    async findScopeById(id) {
      return stores.apiKeyScopes.get(id) ?? null;
    },
    async saveScope(scope) {
      stores.apiKeyScopes.set(scope.id, scope);
    },
    async deleteScope(id) {
      stores.apiKeyScopes.delete(id);
    },
  };
}

export function fakeFileLinkRepository(stores: FakeStores): FileLinkRepository {
  return {
    async findById(id) {
      return stores.fileLinks.get(id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      for (const link of stores.fileLinks.values()) {
        if (link.tokenHash === tokenHash) {
          return link;
        }
      }
      return null;
    },
    async consumeByTokenHash(tokenHash, now) {
      for (const [id, link] of stores.fileLinks) {
        if (link.tokenHash !== tokenHash) {
          continue;
        }
        const usable =
          link.revokedAt === null &&
          link.expiresAt > now &&
          (link.maxDownloads === null ||
            link.downloadCount < link.maxDownloads);
        if (!usable) {
          return null;
        }
        const consumed = { ...link, downloadCount: link.downloadCount + 1 };
        stores.fileLinks.set(id, consumed);
        return consumed;
      }
      return null;
    },
    async listByMessage(messageId) {
      return [...stores.fileLinks.values()].filter(
        (link) => link.messageId === messageId,
      );
    },
    async save(link) {
      stores.fileLinks.set(link.id, link);
    },
    async deleteExpired(now) {
      let removed = 0;
      for (const [id, link] of stores.fileLinks) {
        if (link.expiresAt <= now) {
          stores.fileLinks.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export function fakeUserRepository(stores: FakeStores): UserRepository {
  return {
    async findById(id) {
      return stores.users.get(id) ?? null;
    },
    async findByEmail(email) {
      for (const user of stores.users.values()) {
        if (user.email === email) {
          return user;
        }
      }
      return null;
    },
    async list() {
      return [...stores.users.values()];
    },
    async count() {
      return stores.users.size;
    },
    async save(user) {
      stores.users.set(user.id, user);
    },
    async createFirstUser(user) {
      if (stores.users.size > 0) {
        return false;
      }
      stores.users.set(user.id, user);
      return true;
    },
  };
}

export function fakeUserMailPermissionRepository(
  stores: FakeStores,
): UserMailPermissionRepository {
  return {
    async findById(id) {
      return stores.userMailPermissions.get(id) ?? null;
    },
    async listByUserId(userId) {
      return [...stores.userMailPermissions.values()]
        .filter((permission) => permission.userId === userId)
        .sort((a, b) =>
          a.createdAt < b.createdAt
            ? -1
            : a.createdAt > b.createdAt
              ? 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0,
        );
    },
    async save(permission) {
      stores.userMailPermissions.set(permission.id, permission);
    },
    async delete(id) {
      stores.userMailPermissions.delete(id);
    },
  };
}

export function fakeSessionRepository(stores: FakeStores): SessionRepository {
  return {
    async findByTokenHash(tokenHash) {
      for (const session of stores.sessions.values()) {
        if (session.tokenHash === tokenHash) {
          return session;
        }
      }
      return null;
    },
    async save(session) {
      stores.sessions.set(session.id, session);
    },
    async delete(id) {
      stores.sessions.delete(id);
    },
    async deleteByTokenHash(tokenHash) {
      for (const [id, session] of stores.sessions) {
        if (session.tokenHash === tokenHash) {
          stores.sessions.delete(id);
        }
      }
    },
    async deleteExpired(now) {
      let removed = 0;
      for (const [id, session] of stores.sessions) {
        if (session.expiresAt <= now) {
          stores.sessions.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export function fakeEmailAuthChallengeRepository(
  stores: FakeStores,
): EmailAuthChallengeRepository {
  return {
    async findById(id) {
      return stores.challenges.get(id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      for (const challenge of stores.challenges.values()) {
        if (challenge.tokenHash === tokenHash) {
          return challenge;
        }
      }
      return null;
    },
    async countRecentByEmail(email, since) {
      let count = 0;
      for (const challenge of stores.challenges.values()) {
        if (challenge.email === email && challenge.createdAt >= since) {
          count += 1;
        }
      }
      return count;
    },
    async save(challenge) {
      stores.challenges.set(challenge.id, challenge);
    },
    async deleteExpired(now) {
      let removed = 0;
      for (const [id, challenge] of stores.challenges) {
        if (challenge.expiresAt <= now) {
          stores.challenges.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
