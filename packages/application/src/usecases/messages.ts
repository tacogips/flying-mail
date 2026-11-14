import { Capability } from "@mailcal/domain/entities/api-key";
import type { AttachmentKind } from "@mailcal/domain/entities/attachment";
import type { MailStatus } from "@mailcal/domain/entities/message";
import {
  markMessageRead,
  type Message,
  type MessageDirection,
} from "@mailcal/domain/entities/message";
import { SystemTagSlug } from "@mailcal/domain/entities/tag";
import {
  createEmailAddress,
  type EmailAddress,
} from "@mailcal/domain/value-objects/email-address";
import type {
  DomainId,
  MessageId,
  TagId,
  ThreadId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError } from "../errors";
import {
  authorizesAnyAddress,
  mailPermissionListFilter,
  readableAddressPatterns,
  scopedDomainIds,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type {
  MessageListFilter,
  MessagePage,
} from "../ports/message-repository";

/** Page-size bounds. The upper bound exists because this endpoint is
 * exposed to untrusted agents and a single unbounded page is an easy way to
 * make the server do unbounded work. */
export const MIN_PAGE_SIZE = 1;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export interface MessageFilterInput {
  readonly domainId?: DomainId;
  readonly direction?: MessageDirection;
  readonly address?: string;
  /** Recipient without cc: matches `ENVELOPE`/`TO` only. */
  readonly toAddress?: string;
  /** Recipient with cc: matches any recipient kind, `CC`/`BCC` included. */
  readonly recipientAddress?: string;
  readonly fromAddress?: string;
  readonly threadId?: ThreadId;
  readonly tagIds?: readonly TagId[];
  readonly systemSlugs?: readonly SystemTagSlug[];
  /** Spam is excluded unless the caller opts in or filters on it. */
  readonly includeSpam?: boolean;
  /** Trashed mail is hidden everywhere except the Trash view unless this
   * is set. */
  readonly includeTrashed?: boolean;
  /** Restrict to spam only -- the Spam folder view. Wins over includeSpam. */
  readonly spamOnly?: boolean;
  readonly statuses?: readonly MailStatus[];
  /** True keeps only mailing-list messages, false only the rest. */
  readonly mailingList?: boolean;
  readonly listId?: string;
  readonly fetchStatus?: "NOT_FETCHED" | "FETCHED";
  readonly unreadOnly?: boolean;
  /** Case-insensitive full-text over subject, snippet and text body. */
  readonly search?: string;
  readonly hasAttachment?: boolean;
  readonly attachmentKinds?: readonly AttachmentKind[];
  readonly since?: string;
  readonly until?: string;
}

export interface ListMessagesInput {
  readonly filter?: MessageFilterInput;
  readonly first?: number;
  readonly after?: string | null;
}

export interface ThreadView {
  readonly id: ThreadId;
  readonly subject: string;
  readonly messages: readonly Message[];
  readonly lastMessageAt: string;
}

function clampPageSize(first: number | undefined): number {
  if (first === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!Number.isFinite(first)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.trunc(first), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

function optionalAddress(
  value: string | undefined,
  field: string,
): EmailAddress | undefined {
  return value === undefined ? undefined : createEmailAddress(value, field);
}

/** Every address a message can be authorized against: its sender plus every
 * recipient. `requireAddressCapability`-style checks pass when any one of
 * them matches, so a key scoped to a single mailbox can read a message that
 * merely Cc'd it. */
async function messageAddresses(
  deps: AppDependencies,
  message: Message,
): Promise<readonly EmailAddress[]> {
  const byMessage = await deps.messageRepository.listRecipients([message.id]);
  const recipients = byMessage.get(message.id) ?? [];
  return [message.fromAddress, ...recipients.map((entry) => entry.address)];
}

/** Resolves a message the viewer is allowed to see, or `null`.
 *
 * Deliberately returns `null` rather than throwing `ForbiddenError`: callers
 * surface that as `NOT_FOUND`, so a scoped key cannot distinguish "this
 * message exists but is not yours" from "no such message" and therefore
 * cannot probe for addresses outside its scope. */
export async function loadReadableMessage(
  deps: AppDependencies,
  viewer: Viewer,
  id: MessageId,
  capability: Capability = Capability.MailRead,
): Promise<Message | null> {
  const message = await deps.messageRepository.findById(id);
  if (message === null) {
    return null;
  }
  const addresses = await messageAddresses(deps, message);
  return authorizesAnyAddress(viewer, capability, message.domainId, addresses)
    ? message
    : null;
}

/** Same as {@link loadReadableMessage} over many ids, preserving order and
 * dropping anything the viewer may not see. */
export async function loadReadableMessages(
  deps: AppDependencies,
  viewer: Viewer,
  ids: readonly MessageId[],
  capability: Capability = Capability.MailRead,
): Promise<readonly Message[]> {
  const messages = await deps.messageRepository.findByIds(ids);
  if (messages.length === 0) {
    return [];
  }
  const recipientsByMessage = await deps.messageRepository.listRecipients(
    messages.map((message) => message.id),
  );
  return messages.filter((message) => {
    const recipients = recipientsByMessage.get(message.id) ?? [];
    const addresses = [
      message.fromAddress,
      ...recipients.map((entry) => entry.address),
    ];
    return authorizesAnyAddress(
      viewer,
      capability,
      message.domainId,
      addresses,
    );
  });
}

async function resolveSystemTagIds(
  deps: AppDependencies,
  slugs: readonly SystemTagSlug[],
): Promise<readonly TagId[]> {
  const ids: TagId[] = [];
  for (const slug of slugs) {
    const tag = await deps.tagRepository.findBySystemSlug(slug);
    if (tag !== null) {
      ids.push(tag.id);
    }
  }
  return ids;
}

/** Translates the caller's filter into a repository filter, intersected
 * with what the viewer's scopes allow. Exported for direct testing, since
 * this intersection is the whole of listing-side authorization. */
export async function buildMessageListFilter(
  deps: AppDependencies,
  viewer: Viewer,
  input: MessageFilterInput | undefined,
): Promise<MessageListFilter> {
  const filter = input ?? {};
  const scopeDomainIds = scopedDomainIds(viewer, Capability.MailRead);

  const requestedDomainIds =
    filter.domainId === undefined ? undefined : [filter.domainId];
  const domainIds =
    scopeDomainIds === null
      ? requestedDomainIds
      : requestedDomainIds === undefined
        ? scopeDomainIds
        : requestedDomainIds.filter((id) => scopeDomainIds.includes(id));

  const explicitTagIds = [
    ...(filter.tagIds ?? []),
    ...(await resolveSystemTagIds(deps, filter.systemSlugs ?? [])),
  ];

  // Spam now lives in its own table. The default view excludes it, the
  // Spam folder restricts to it, and includeSpam lifts the restriction.
  const spam =
    filter.spamOnly === true
      ? true
      : filter.includeSpam === true
        ? undefined
        : false;

  // Trashed mail is likewise hidden from every view except the Trash
  // folder itself (or an explicit includeTrashed) -- otherwise "delete"
  // would leave the message sitting in the Inbox.
  const excludeTagIds: TagId[] = [];
  const trashRequested =
    filter.includeTrashed === true ||
    (filter.systemSlugs ?? []).includes(SystemTagSlug.Trash);
  if (!trashRequested) {
    const trashTag = await deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    if (trashTag !== null) {
      excludeTagIds.push(trashTag.id);
    }
  }

  const apiKeyId = viewer.kind === "API_KEY" ? viewer.apiKeyId : null;

  return {
    ...(domainIds === undefined ? {} : { domainIds }),
    ...(filter.direction === undefined ? {} : { direction: filter.direction }),
    ...(filter.threadId === undefined ? {} : { threadId: filter.threadId }),
    ...(filter.unreadOnly === undefined
      ? {}
      : { unreadOnly: filter.unreadOnly }),
    ...(filter.search === undefined ? {} : { search: filter.search }),
    ...(filter.since === undefined ? {} : { since: filter.since }),
    ...(filter.until === undefined ? {} : { until: filter.until }),
    ...(() => {
      const address = optionalAddress(filter.address, "address");
      return address === undefined ? {} : { address };
    })(),
    ...(() => {
      const toAddress = optionalAddress(filter.toAddress, "toAddress");
      return toAddress === undefined ? {} : { toAddress };
    })(),
    ...(() => {
      const recipientAddress = optionalAddress(
        filter.recipientAddress,
        "recipientAddress",
      );
      return recipientAddress === undefined ? {} : { recipientAddress };
    })(),
    ...(filter.hasAttachment === undefined
      ? {}
      : { hasAttachment: filter.hasAttachment }),
    ...(filter.attachmentKinds === undefined ||
    filter.attachmentKinds.length === 0
      ? {}
      : { attachmentKinds: filter.attachmentKinds }),
    ...(() => {
      const fromAddress = optionalAddress(filter.fromAddress, "fromAddress");
      return fromAddress === undefined ? {} : { fromAddress };
    })(),
    ...(explicitTagIds.length === 0 ? {} : { tagIds: explicitTagIds }),
    ...(spam === undefined ? {} : { spam }),
    ...(excludeTagIds.length === 0 ? {} : { excludeTagIds }),
    ...(filter.statuses === undefined || filter.statuses.length === 0
      ? {}
      : { statuses: filter.statuses }),
    ...(filter.mailingList === undefined
      ? {}
      : { mailingList: filter.mailingList }),
    ...(filter.listId === undefined ? {} : { listId: filter.listId }),
    allowedPatterns: readableAddressPatterns(viewer, Capability.MailRead),
    mailPermissionFilter: mailPermissionListFilter(viewer, Capability.MailRead),
    ...(filter.fetchStatus === undefined || apiKeyId === null
      ? {}
      : {
          fetchStatus: {
            apiKeyId,
            status: filter.fetchStatus as never,
          },
        }),
  };
}

export function createListMessagesUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: ListMessagesInput) => Promise<MessagePage> {
  return async (viewer, input) => {
    if (input.filter?.fetchStatus !== undefined && viewer.kind === "USER") {
      throw new BadUserInputError(
        "fetchStatus filtering is only meaningful for an API key credential",
        "filter.fetchStatus",
      );
    }
    const filter = await buildMessageListFilter(deps, viewer, input.filter);
    return deps.messageRepository.list(
      filter,
      clampPageSize(input.first),
      input.after ?? null,
    );
  };
}

export function createGetMessageUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MessageId) => Promise<Message | null> {
  return (viewer, id) => loadReadableMessage(deps, viewer, id);
}

export function createGetThreadUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ThreadId) => Promise<ThreadView | null> {
  return async (viewer, id) => {
    const all = await deps.messageRepository.listByThread(id);
    if (all.length === 0) {
      return null;
    }
    const visible = await loadReadableMessages(
      deps,
      viewer,
      all.map((message) => message.id),
    );
    if (visible.length === 0) {
      return null;
    }
    const last = visible[visible.length - 1];
    const first = visible[0];
    return {
      id,
      subject: first?.subject ?? "",
      messages: visible,
      lastMessageAt: last?.occurredAt ?? first?.occurredAt ?? "",
    };
  };
}

export function createMarkReadUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  ids: readonly MessageId[],
  read: boolean,
) => Promise<readonly Message[]> {
  return async (viewer, ids, read) => {
    const messages = await loadReadableMessages(
      deps,
      viewer,
      ids,
      Capability.MailManage,
    );
    if (messages.length === 0) {
      return [];
    }
    const now = deps.clock.now().toISOString();
    const readAt = read ? now : null;
    await deps.messageRepository.setRead(
      messages.map((message) => message.id),
      readAt,
      now,
    );
    return messages.map((message) => markMessageRead(message, readAt, now));
  };
}

/** Deletes rows first, then blob bodies. A blob failure after the rows are
 * gone leaves orphaned bytes -- cheap and reclaimable -- whereas the reverse
 * order would leave rows pointing at objects that no longer exist. */
/** Two-stage deletion, like every mail client: the first delete moves a
 * message to Trash (tags it), and only deleting an already-trashed
 * message removes it permanently. One misclick can no longer destroy
 * mail. Returns the number of messages affected in either stage. */
export function createDeleteMessagesUseCase(
  deps: AppDependencies,
): (viewer: Viewer, ids: readonly MessageId[]) => Promise<number> {
  return async (viewer, ids) => {
    const messages = await loadReadableMessages(
      deps,
      viewer,
      ids,
      Capability.MailManage,
    );
    if (messages.length === 0) {
      return 0;
    }
    const trashTag = await deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    const allIds = messages.map((message) => message.id);
    if (trashTag !== null) {
      const tagged = await deps.messageRepository.listTagIds(allIds);
      const toTrash = allIds.filter(
        (id) => !(tagged.get(id) ?? []).includes(trashTag.id),
      );
      const toPurge = allIds.filter((id) => !toTrash.includes(id));
      if (toTrash.length > 0) {
        await deps.messageRepository.addTags(
          toTrash,
          [trashTag.id],
          deps.clock.now().toISOString(),
        );
      }
      if (toPurge.length === 0) {
        return toTrash.length;
      }
      // Fall through to permanently delete only the already-trashed set.
      return (
        toTrash.length +
        (await hardDeleteMessages(
          deps,
          messages.filter((message) => toPurge.includes(message.id)),
        ))
      );
    }
    return hardDeleteMessages(deps, messages);
  };
}

async function hardDeleteMessages(
  deps: AppDependencies,
  messages: readonly Message[],
): Promise<number> {
  if (messages.length === 0) {
    return 0;
  }
  {
    const messageIds = messages.map((message) => message.id);
    const attachmentsByMessage =
      await deps.messageRepository.listAttachments(messageIds);

    const removed = await deps.messageRepository.delete(messageIds);

    const blobKeys: string[] = [];
    for (const message of messages) {
      if (message.rawKey !== null) {
        blobKeys.push(message.rawKey);
      }
      for (const attachment of attachmentsByMessage.get(message.id) ?? []) {
        blobKeys.push(attachment.blobKey);
      }
    }
    await Promise.all(
      blobKeys.map((key) =>
        deps.blobs.delete(key).catch(() => {
          // Best-effort: the rows are already gone, so a failed object
          // delete leaves reclaimable garbage rather than a broken read.
        }),
      ),
    );
    return removed;
  }
}
