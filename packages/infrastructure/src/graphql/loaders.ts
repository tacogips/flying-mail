import type { AppDependencies } from "@mailcal/application/dependencies";
import type { Viewer } from "@mailcal/application/policies";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import type { MessageFetchState } from "@mailcal/domain/entities/fetch-state";
import type { MailDomain } from "@mailcal/domain/entities/mail-domain";
import type { MessageRecipient } from "@mailcal/domain/entities/message";
import type { MessageEvent } from "@mailcal/domain/entities/message-event";
import type { SpamMark } from "@mailcal/domain/entities/spam-mark";
import type { Tag } from "@mailcal/domain/entities/tag";
import type { ApiKeyScope } from "@mailcal/domain/entities/api-key";
import type { UserMailPermission } from "@mailcal/domain/entities/user-mail-permission";
import type { UserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import type { UserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import {
  type ApiKeyId,
  createTagId,
  type DomainId,
  type MessageId,
  type TagId,
  type UserId,
} from "@mailcal/domain/value-objects/ids";

/** Batches keys requested within one microtask turn into a single call.
 *
 * Deliberately per-request only, with no cross-request cache: a resolver's
 * view of authorization data must never be served from a cache populated for
 * a different credential. */
export interface BatchLoader<TKey extends string, TValue> {
  load(key: TKey): Promise<TValue>;
  loadMany(keys: readonly TKey[]): Promise<readonly TValue[]>;
}

export function createBatchLoader<TKey extends string, TValue>(
  batchFn: (keys: readonly TKey[]) => Promise<ReadonlyMap<string, TValue>>,
  fallback: (key: TKey) => TValue,
): BatchLoader<TKey, TValue> {
  const cache = new Map<string, Promise<TValue>>();
  let pending: TKey[] = [];
  let scheduled: Promise<ReadonlyMap<string, TValue>> | null = null;

  function schedule(): Promise<ReadonlyMap<string, TValue>> {
    if (scheduled === null) {
      scheduled = Promise.resolve().then(async () => {
        const keys = pending;
        pending = [];
        scheduled = null;
        return keys.length === 0 ? new Map<string, TValue>() : batchFn(keys);
      });
    }
    return scheduled;
  }

  function load(key: TKey): Promise<TValue> {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    pending.push(key);
    const promise = schedule().then((results) => {
      const value = results.get(key);
      return value === undefined ? fallback(key) : value;
    });
    cache.set(key, promise);
    return promise;
  }

  return {
    load,
    loadMany(keys) {
      return Promise.all(keys.map(load));
    },
  };
}

export interface RequestLoaders {
  readonly recipientsByMessage: BatchLoader<
    MessageId,
    readonly MessageRecipient[]
  >;
  readonly attachmentsByMessage: BatchLoader<MessageId, readonly Attachment[]>;
  readonly tagsByMessage: BatchLoader<MessageId, readonly Tag[]>;
  readonly fetchStateByMessage: BatchLoader<
    MessageId,
    MessageFetchState | null
  >;
  readonly spamMarkByMessage: BatchLoader<MessageId, SpamMark | null>;
  readonly eventsByMessage: BatchLoader<MessageId, readonly MessageEvent[]>;
  readonly domainById: BatchLoader<DomainId, MailDomain | null>;
  readonly scopesByApiKey: BatchLoader<ApiKeyId, readonly ApiKeyScope[]>;
  readonly messageCountByTag: BatchLoader<TagId, number>;
  readonly permissionsByUser: BatchLoader<
    UserId,
    readonly UserMailPermission[]
  >;
  readonly templatePermissionsByUser: BatchLoader<
    UserId,
    readonly UserTemplatePermission[]
  >;
  readonly calendarPermissionsByUser: BatchLoader<
    UserId,
    readonly UserCalendarPermission[]
  >;
}

const EMPTY_ARRAY: readonly never[] = [];

/** Builds a fresh set of loaders for one request. Field resolvers use these
 * exclusively -- a resolver that reached for a repository directly would
 * turn `messages { attachments { ... } }` into an N+1 query. */
export function createRequestLoaders(
  deps: AppDependencies,
  viewer: Viewer | null,
): RequestLoaders {
  const apiKeyId = viewer?.kind === "API_KEY" ? viewer.apiKeyId : null;

  const tagCache = new Map<string, Tag>();

  return {
    recipientsByMessage: createBatchLoader<
      MessageId,
      readonly MessageRecipient[]
    >(
      (ids) => deps.messageRepository.listRecipients(ids),
      () => EMPTY_ARRAY,
    ),

    attachmentsByMessage: createBatchLoader<MessageId, readonly Attachment[]>(
      (ids) => deps.messageRepository.listAttachments(ids),
      () => EMPTY_ARRAY,
    ),

    spamMarkByMessage: createBatchLoader<MessageId, SpamMark | null>(
      (ids) => deps.messageRepository.listSpamMarks(ids),
      () => null,
    ),

    eventsByMessage: createBatchLoader<MessageId, readonly MessageEvent[]>(
      (ids) => deps.messageEventRepository.listByMessages(ids),
      () => EMPTY_ARRAY,
    ),

    tagsByMessage: createBatchLoader<MessageId, readonly Tag[]>(
      async (ids) => {
        const tagIdsByMessage = await deps.messageRepository.listTagIds(ids);
        const wanted = new Set<string>();
        for (const tagIds of tagIdsByMessage.values()) {
          for (const tagId of tagIds) {
            wanted.add(tagId);
          }
        }
        const missing = [...wanted]
          .filter((id) => !tagCache.has(id))
          .map((id) => createTagId(id));
        if (missing.length > 0) {
          for (const tag of await deps.tagRepository.findByIds(missing)) {
            tagCache.set(tag.id, tag);
          }
        }
        const result = new Map<string, readonly Tag[]>();
        for (const [messageId, tagIds] of tagIdsByMessage) {
          result.set(
            messageId,
            tagIds
              .map((tagId) => tagCache.get(tagId))
              .filter((tag): tag is Tag => tag !== undefined),
          );
        }
        return result;
      },
      () => EMPTY_ARRAY,
    ),

    fetchStateByMessage: createBatchLoader<MessageId, MessageFetchState | null>(
      async (ids) =>
        apiKeyId === null
          ? new Map()
          : deps.messageRepository.findFetchStates(apiKeyId, ids),
      () => null,
    ),

    domainById: createBatchLoader<DomainId, MailDomain | null>(
      async (ids) => {
        const found = new Map<string, MailDomain>();
        // The domain table is tiny (one row per managed domain), so one
        // listing is cheaper than N point lookups and needs no `IN` query.
        for (const domain of await deps.mailDomainRepository.list()) {
          found.set(domain.id, domain);
        }
        const filtered = new Map<string, MailDomain>();
        for (const id of ids) {
          const domain = found.get(id);
          if (domain !== undefined) {
            filtered.set(id, domain);
          }
        }
        return filtered;
      },
      () => null,
    ),

    scopesByApiKey: createBatchLoader<ApiKeyId, readonly ApiKeyScope[]>(
      (ids) => deps.apiKeyRepository.listScopes(ids),
      () => EMPTY_ARRAY,
    ),

    messageCountByTag: createBatchLoader<TagId, number>(
      (ids) => deps.tagRepository.countMessages(ids),
      () => 0,
    ),

    // These two ports offer a batch method, so one round trip covers every
    // user in the page.
    templatePermissionsByUser: createBatchLoader<
      UserId,
      readonly UserTemplatePermission[]
    >(
      async (ids) => deps.userTemplatePermissionRepository.listByUserIds(ids),
      () => EMPTY_ARRAY,
    ),

    calendarPermissionsByUser: createBatchLoader<
      UserId,
      readonly UserCalendarPermission[]
    >(
      async (ids) => deps.userCalendarPermissionRepository.listByUserIds(ids),
      () => EMPTY_ARRAY,
    ),

    // No batch method on this port (admin-only, low-cardinality data), so
    // it issues one point lookup per key -- still coalesced into the
    // request's microtask batch by `createBatchLoader`.
    permissionsByUser: createBatchLoader<UserId, readonly UserMailPermission[]>(
      async (ids) => {
        const entries = await Promise.all(
          ids.map(
            async (id) =>
              [
                id,
                await deps.userMailPermissionRepository.listByUserId(id),
              ] as const,
          ),
        );
        return new Map(entries);
      },
      () => EMPTY_ARRAY,
    ),
  };
}
