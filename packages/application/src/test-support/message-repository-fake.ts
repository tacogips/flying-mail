import type { Attachment } from "@flying-mail/domain/entities/attachment";
import {
  FetchStatus,
  type MessageFetchState,
} from "@flying-mail/domain/entities/fetch-state";
import {
  MailStatus,
  type Message,
  type MessageRecipient,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { DuplicateMessageError } from "../ports/message-repository";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import type { SpamMark } from "@flying-mail/domain/entities/spam-mark";
import { matchAddressPattern } from "@flying-mail/domain/value-objects/address-pattern";
import type { EmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createTagId,
  type TagId,
  type ThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { mailPermissionFilterAuthorizesAnyAddress } from "../policies/authorization";
import type {
  InsertMessageInput,
  MessageListFilter,
  MessagePage,
  MessageRepository,
} from "../ports/message-repository";
import type { SqlStatement } from "../ports/sql-database";

export interface FakeMessageStores {
  readonly messages: Map<string, Message>;
  readonly recipients: Map<string, MessageRecipient[]>;
  readonly attachments: Map<string, Attachment>;
  readonly messageTags: Map<string, Set<string>>;
  /** Keyed by `${apiKeyId} ${messageId}`. */
  readonly fetchStates: Map<string, MessageFetchState>;
  /** Keyed by message id. Presence of a mark is the spam verdict. */
  readonly spamMarks: Map<string, SpamMark>;
  /** Every `insertWithRelations` call, in order -- so a test can assert what
   * `extraStatements` rode a given `STORED` insert rather than inferring it
   * indirectly. */
  readonly insertCalls: InsertMessageInput[];
}

export function createFakeMessageStores(): FakeMessageStores {
  return {
    messages: new Map(),
    recipients: new Map(),
    attachments: new Map(),
    messageTags: new Map(),
    fetchStates: new Map(),
    spamMarks: new Map(),
    insertCalls: [],
  };
}

/** A fake's `insertWithRelations` has no real `db.batch()` to run
 * `extraStatements` through. A statement built by a fake port's own
 * `buildSaveStatement` (the external-mail ledger, so far) carries this
 * `apply` callback, which reproduces -- for tests only -- what executing the
 * statement inside this same batch would do. A real adapter's plain
 * `{ sql, params }` statement has no such property and is silently skipped
 * here, exactly as every other SQL string is. */
interface BatchableFakeStatement extends SqlStatement {
  readonly apply?: () => void;
}

function applyBatchedFakeStatements(
  statements: readonly SqlStatement[] | undefined,
): void {
  for (const statement of statements ?? []) {
    const apply = (statement as BatchableFakeStatement).apply;
    if (typeof apply === "function") {
      apply();
    }
  }
}

function fetchStateKey(apiKeyId: string, messageId: string): string {
  return `${apiKeyId} ${messageId}`;
}

function encodeCursor(message: Message): string {
  return btoa(`${message.occurredAt} ${message.id}`);
}

function decodeCursor(
  cursor: string,
): { readonly occurredAt: string; readonly id: string } | null {
  try {
    const parts = atob(cursor).split(" ");
    const occurredAt = parts[0];
    const id = parts[1];
    if (occurredAt === undefined || id === undefined) {
      return null;
    }
    return { occurredAt, id };
  } catch {
    return null;
  }
}

/** Newest first, ties broken by id descending -- the same total order the
 * SQL repository's keyset pagination uses. */
function compareDescending(a: Message, b: Message): number {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt < b.occurredAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function addressesOf(
  stores: FakeMessageStores,
  message: Message,
): readonly EmailAddress[] {
  const recipients = stores.recipients.get(message.id) ?? [];
  return [message.fromAddress, ...recipients.map((entry) => entry.address)];
}

function matchesAllowedPatterns(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  const patterns = filter.allowedPatterns;
  if (patterns === null) {
    return true;
  }
  // An empty allowlist means the viewer holds no scope for this capability
  // and must therefore see nothing -- never everything.
  if (patterns.length === 0) {
    return false;
  }
  const addresses = addressesOf(stores, message);
  return patterns.some((pattern) =>
    addresses.some((address) => matchAddressPattern(pattern, address)),
  );
}

/** Mirrors `buildMailPermissionFilterCondition`'s SQL semantics: `null`
 * imposes no restriction, otherwise a candidate address must dodge every
 * matching DENY and then be covered by the admin baseline or a matching
 * ALLOW. Independent of `matchesAllowedPatterns` above -- both apply when
 * both are present. */
function matchesMailPermissionFilter(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  if (filter.mailPermissionFilter === null) {
    return true;
  }
  return mailPermissionFilterAuthorizesAnyAddress(
    filter.mailPermissionFilter,
    message.domainId,
    addressesOf(stores, message),
  );
}

function matchesFetchStatus(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  if (filter.fetchStatus === undefined) {
    return true;
  }
  const state = stores.fetchStates.get(
    fetchStateKey(filter.fetchStatus.apiKeyId, message.id),
  );
  // An absent row means NOT_FETCHED, and a NOT_FETCHED filter must match it.
  const status = state?.status ?? FetchStatus.NotFetched;
  return status === filter.fetchStatus.status;
}

function matchesTagFilters(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  const tags = stores.messageTags.get(message.id) ?? new Set<string>();
  if (filter.tagIds !== undefined && filter.tagIds.length > 0) {
    if (!filter.tagIds.some((tagId) => tags.has(tagId))) {
      return false;
    }
  }
  if (filter.excludeTagIds !== undefined) {
    if (filter.excludeTagIds.some((tagId) => tags.has(tagId))) {
      return false;
    }
  }
  return true;
}

function matchesAddressFilters(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  if (
    filter.fromAddress !== undefined &&
    message.fromAddress !== filter.fromAddress
  ) {
    return false;
  }
  if (
    filter.address !== undefined &&
    !addressesOf(stores, message).includes(filter.address)
  ) {
    return false;
  }
  if (filter.toAddress !== undefined) {
    const recipients = stores.recipients.get(message.id) ?? [];
    const matched = recipients.some(
      (entry) =>
        entry.address === filter.toAddress &&
        (entry.kind === RecipientKind.To ||
          entry.kind === RecipientKind.Envelope),
    );
    if (!matched) {
      return false;
    }
  }
  if (filter.recipientAddress !== undefined) {
    const recipients = stores.recipients.get(message.id) ?? [];
    if (
      !recipients.some((entry) => entry.address === filter.recipientAddress)
    ) {
      return false;
    }
  }
  return true;
}

function messageAttachments(
  stores: FakeMessageStores,
  messageId: string,
): readonly Attachment[] {
  return [...stores.attachments.values()].filter(
    (attachment) => attachment.messageId === messageId,
  );
}

function matchesAttachmentFilters(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  if (filter.hasAttachment !== undefined) {
    const has = messageAttachments(stores, message.id).length > 0;
    if (has !== filter.hasAttachment) {
      return false;
    }
  }
  if (
    filter.attachmentKinds !== undefined &&
    filter.attachmentKinds.length > 0
  ) {
    const kinds = new Set(
      messageAttachments(stores, message.id).map(
        (attachment) => attachment.kind,
      ),
    );
    if (!filter.attachmentKinds.some((kind) => kinds.has(kind))) {
      return false;
    }
  }
  return true;
}

function matchesScalarFilters(
  message: Message,
  filter: MessageListFilter,
): boolean {
  if (
    filter.domainIds !== undefined &&
    !filter.domainIds.includes(message.domainId)
  ) {
    return false;
  }
  if (
    filter.direction !== undefined &&
    message.direction !== filter.direction
  ) {
    return false;
  }
  if (filter.threadId !== undefined && message.threadId !== filter.threadId) {
    return false;
  }
  if (filter.unreadOnly === true && message.readAt !== null) {
    return false;
  }
  if (filter.since !== undefined && message.occurredAt < filter.since) {
    return false;
  }
  if (filter.until !== undefined && message.occurredAt > filter.until) {
    return false;
  }
  if (
    filter.statuses !== undefined &&
    filter.statuses.length > 0 &&
    !filter.statuses.includes(message.status)
  ) {
    return false;
  }
  if (
    filter.mailingList !== undefined &&
    message.isMailingList !== filter.mailingList
  ) {
    return false;
  }
  if (filter.listId !== undefined && message.listId !== filter.listId) {
    return false;
  }
  if (filter.search !== undefined) {
    const needle = filter.search.toLowerCase();
    const haystack =
      `${message.subject} ${message.snippet} ${message.textBody ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }
  return true;
}

function matchesFilter(
  stores: FakeMessageStores,
  message: Message,
  filter: MessageListFilter,
): boolean {
  return (
    matchesScalarFilters(message, filter) &&
    matchesAddressFilters(stores, message, filter) &&
    matchesAttachmentFilters(stores, message, filter) &&
    matchesTagFilters(stores, message, filter) &&
    (filter.spam === undefined ||
      stores.spamMarks.has(message.id) === filter.spam) &&
    matchesAllowedPatterns(stores, message, filter) &&
    matchesMailPermissionFilter(stores, message, filter) &&
    matchesFetchStatus(stores, message, filter)
  );
}

/** In-memory `MessageRepository` implementing the same filtering, ordering
 * and keyset pagination semantics as the SQL repository, so use case tests
 * exercise real behavior rather than a stub that always returns everything. */
export function fakeMessageRepository(
  stores: FakeMessageStores,
): MessageRepository {
  return {
    async listAddressActivity(addresses) {
      return addresses
        .map(({ address, domainId }) => {
          const activity: string[] = [];
          let unreadCount = 0;
          for (const message of stores.messages.values()) {
            const recipients = stores.recipients.get(message.id) ?? [];
            if (
              message.domainId === domainId &&
              message.direction === "OUTBOUND" &&
              message.status !== MailStatus.Draft &&
              message.fromAddress === address
            ) {
              activity.push(message.occurredAt);
            }
            const envelopeDelivered = recipients.some(
              (recipient) =>
                recipient.kind === RecipientKind.Envelope &&
                recipient.address === address,
            );
            if (
              message.domainId === domainId &&
              message.direction === "INBOUND" &&
              envelopeDelivered
            ) {
              activity.push(message.occurredAt);
              if (
                message.readAt === null &&
                !stores.spamMarks.has(message.id) &&
                !stores.messageTags.get(message.id)?.has("tag-trash")
              ) {
                unreadCount += 1;
              }
            }
          }
          return {
            address,
            domainId,
            lastActivityAt:
              activity.toSorted((left, right) =>
                right.localeCompare(left),
              )[0] ?? null,
            unreadCount,
          };
        })
        .toSorted((left, right) => {
          if (left.lastActivityAt === null && right.lastActivityAt !== null) {
            return 1;
          }
          if (left.lastActivityAt !== null && right.lastActivityAt === null) {
            return -1;
          }
          if (left.lastActivityAt !== right.lastActivityAt) {
            return (right.lastActivityAt ?? "").localeCompare(
              left.lastActivityAt ?? "",
            );
          }
          return String(left.address).localeCompare(String(right.address));
        });
    },

    async findById(id) {
      return stores.messages.get(id) ?? null;
    },

    async findByIds(ids) {
      const found: Message[] = [];
      for (const id of ids) {
        const message = stores.messages.get(id);
        if (message !== undefined) {
          found.push(message);
        }
      }
      return found;
    },

    async findByRfcMessageId(rfcMessageId) {
      const matches = [...stores.messages.values()]
        .filter((message) => message.rfcMessageId === rfcMessageId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return matches[0] ?? null;
    },

    async findInboundByRfcMessageId(rfcMessageId, domainId) {
      return (
        [...stores.messages.values()].find(
          (message) =>
            message.direction === "INBOUND" &&
            message.domainId === domainId &&
            message.rfcMessageId === rfcMessageId,
        ) ?? null
      );
    },

    async addEnvelopeRecipient(messageId, address) {
      const recipients = stores.recipients.get(messageId) ?? [];
      if (
        recipients.some(
          (recipient) =>
            recipient.kind === RecipientKind.Envelope &&
            recipient.address === address,
        )
      ) {
        return;
      }
      const position =
        recipients
          .filter((recipient) => recipient.kind === RecipientKind.Envelope)
          .reduce(
            (highest, recipient) => Math.max(highest, recipient.position),
            -1,
          ) + 1;
      stores.recipients.set(messageId, [
        ...recipients,
        {
          kind: RecipientKind.Envelope,
          address: createEmailAddress(address),
          name: null,
          position,
        },
      ]);
    },

    async saveIfDraft(message) {
      const existing = stores.messages.get(message.id);
      if (existing?.status !== MailStatus.Draft) {
        return false;
      }
      stores.messages.set(message.id, message);
      return true;
    },

    async deleteDraftIfDraft(id) {
      const existing = stores.messages.get(id);
      if (existing?.status !== MailStatus.Draft) {
        return false;
      }
      stores.messages.delete(id);
      stores.recipients.delete(id);
      stores.messageTags.delete(id);
      stores.spamMarks.delete(id);
      for (const [key, state] of stores.fetchStates) {
        if (state.messageId === id) {
          stores.fetchStates.delete(key);
        }
      }
      for (const [attachmentId, attachment] of stores.attachments) {
        if (attachment.messageId === id) {
          stores.attachments.delete(attachmentId);
        }
      }
      return true;
    },

    async countAttachmentsByBlobKeys(blobKeys) {
      const counts = new Map<string, number>(blobKeys.map((key) => [key, 0]));
      for (const attachment of stores.attachments.values()) {
        if (counts.has(attachment.blobKey)) {
          counts.set(
            attachment.blobKey,
            (counts.get(attachment.blobKey) ?? 0) + 1,
          );
        }
      }
      return counts;
    },

    async findThreadIdByReferences(references) {
      const candidates = [...stores.messages.values()]
        .filter(
          (message) =>
            message.rfcMessageId !== null &&
            references.includes(message.rfcMessageId),
        )
        .sort(compareDescending);
      return candidates[0]?.threadId ?? null;
    },

    async list(filter, limit, cursor): Promise<MessagePage> {
      const matching = [...stores.messages.values()]
        .filter((message) => matchesFilter(stores, message, filter))
        .sort(compareDescending);

      let startIndex = 0;
      if (cursor !== null) {
        const decoded = decodeCursor(cursor);
        if (decoded !== null) {
          const found = matching.findIndex(
            (message) =>
              message.occurredAt < decoded.occurredAt ||
              (message.occurredAt === decoded.occurredAt &&
                message.id < decoded.id),
          );
          startIndex = found === -1 ? matching.length : found;
        }
      }

      const nodes = matching.slice(startIndex, startIndex + limit);
      const last = nodes[nodes.length - 1];
      const hasMore = startIndex + nodes.length < matching.length;
      return {
        nodes,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
        totalCount: matching.length,
      };
    },

    async listByThread(threadId: ThreadId) {
      return [...stores.messages.values()]
        .filter((message) => message.threadId === threadId)
        .sort((a, b) => -compareDescending(a, b));
    },

    async insertWithRelations(input) {
      const duplicate = [...stores.messages.values()].some(
        (message) =>
          input.message.rfcMessageId !== null &&
          message.rfcMessageId === input.message.rfcMessageId &&
          message.direction === input.message.direction &&
          message.domainId === input.message.domainId,
      );
      if (duplicate) {
        throw new DuplicateMessageError(
          `Duplicate Message-ID ${input.message.rfcMessageId} for direction and domain`,
        );
      }
      stores.messages.set(input.message.id, input.message);
      stores.recipients.set(input.message.id, [...input.recipients]);
      for (const attachment of input.attachments) {
        stores.attachments.set(attachment.id, attachment);
      }
      stores.messageTags.set(
        input.message.id,
        new Set<string>(input.tagIds as readonly string[]),
      );
      if (input.spam !== undefined) {
        stores.spamMarks.set(input.message.id, input.spam);
      }
      stores.insertCalls.push(input);
      applyBatchedFakeStatements(input.extraStatements);
    },

    async setSpamMarks(marks) {
      for (const mark of marks) {
        stores.spamMarks.set(mark.messageId, mark);
      }
    },

    async clearSpamMarks(ids) {
      for (const id of ids) {
        stores.spamMarks.delete(id);
      }
    },

    async listSpamMarks(ids) {
      const map = new Map<string, SpamMark>();
      for (const id of ids) {
        const mark = stores.spamMarks.get(id);
        if (mark !== undefined) {
          map.set(id, mark);
        }
      }
      return map;
    },

    async replaceRecipients(messageId, recipients) {
      stores.recipients.set(messageId, [...recipients]);
    },

    async save(message) {
      stores.messages.set(message.id, message);
    },

    async delete(ids) {
      let removed = 0;
      for (const id of ids) {
        if (stores.messages.delete(id)) {
          removed += 1;
        }
        stores.recipients.delete(id);
        stores.messageTags.delete(id);
        stores.spamMarks.delete(id);
        for (const [key, state] of stores.fetchStates) {
          if (state.messageId === id) {
            stores.fetchStates.delete(key);
          }
        }
        for (const [attachmentId, attachment] of stores.attachments) {
          if (attachment.messageId === id) {
            stores.attachments.delete(attachmentId);
          }
        }
      }
      return removed;
    },

    async setRead(ids, readAt, updatedAt) {
      for (const id of ids) {
        const message = stores.messages.get(id);
        if (message !== undefined) {
          stores.messages.set(id, { ...message, readAt, updatedAt });
        }
      }
    },

    async listRecipients(ids) {
      const grouped = new Map<string, readonly MessageRecipient[]>();
      for (const id of ids) {
        grouped.set(id, stores.recipients.get(id) ?? []);
      }
      return grouped;
    },

    async listAttachments(ids) {
      const wanted = new Set<string>(ids);
      const grouped = new Map<string, Attachment[]>();
      for (const id of wanted) {
        grouped.set(id, []);
      }
      for (const attachment of stores.attachments.values()) {
        // A staged upload has no message yet, so it belongs to no group.
        const messageId = attachment.messageId;
        if (messageId !== null && wanted.has(messageId)) {
          grouped.get(messageId)?.push(attachment);
        }
      }
      return grouped;
    },

    async listTagIds(ids) {
      const grouped = new Map<string, readonly TagId[]>();
      for (const id of ids) {
        const tags = stores.messageTags.get(id) ?? new Set<string>();
        grouped.set(
          id,
          [...tags].map((tagId) => createTagId(tagId)),
        );
      }
      return grouped;
    },

    async listStaleStagedAttachments(cutoff) {
      return [...stores.attachments.values()].filter(
        (attachment) =>
          attachment.messageId === null && attachment.createdAt < cutoff,
      );
    },

    async deleteAttachments(ids) {
      for (const id of ids) {
        stores.attachments.delete(id);
      }
    },

    async findAttachmentById(id) {
      return stores.attachments.get(id) ?? null;
    },

    async saveAttachment(attachment) {
      stores.attachments.set(attachment.id, attachment);
    },

    async addTags(messageIds, tagIds, _taggedAt) {
      for (const messageId of messageIds) {
        const existing = stores.messageTags.get(messageId) ?? new Set<string>();
        for (const tagId of tagIds) {
          existing.add(tagId);
        }
        stores.messageTags.set(messageId, existing);
      }
    },

    async removeTags(messageIds, tagIds) {
      for (const messageId of messageIds) {
        const existing = stores.messageTags.get(messageId);
        if (existing === undefined) {
          continue;
        }
        for (const tagId of tagIds) {
          existing.delete(tagId);
        }
      }
    },

    async findFetchStates(apiKeyId, ids) {
      const found = new Map<string, MessageFetchState>();
      for (const id of ids) {
        const state = stores.fetchStates.get(fetchStateKey(apiKeyId, id));
        if (state !== undefined) {
          found.set(id, state);
        }
      }
      return found;
    },

    async saveFetchStates(states) {
      for (const state of states) {
        stores.fetchStates.set(
          fetchStateKey(state.apiKeyId, state.messageId),
          state,
        );
      }
    },
  };
}
