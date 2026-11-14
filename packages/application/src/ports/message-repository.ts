import type {
  Attachment,
  AttachmentKind,
} from "@mailcal/domain/entities/attachment";
import type { MessageFetchState } from "@mailcal/domain/entities/fetch-state";
import { FetchStatus } from "@mailcal/domain/entities/fetch-state";
import type {
  MailStatus,
  Message,
  MessageDirection,
  MessageRecipient,
} from "@mailcal/domain/entities/message";
import type { SpamMark } from "@mailcal/domain/entities/spam-mark";
import type { AddressPattern } from "@mailcal/domain/value-objects/address-pattern";
import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import type {
  ApiKeyId,
  AttachmentId,
  DomainId,
  MessageId,
  TagId,
  ThreadId,
} from "@mailcal/domain/value-objects/ids";
import type { MailPermissionFilter } from "../policies/authorization";

export { FetchStatus };

/** Everything a listing query can be narrowed by. Every field except
 * `allowedPatterns` comes from the caller; `allowedPatterns` is derived
 * from the viewer's scopes by the authorization policy and is intersected
 * with whatever the caller asked for, so a scoped key's pagination is
 * consistent and it never learns that other messages exist. */
export interface MessageListFilter {
  readonly domainIds?: readonly DomainId[];
  readonly direction?: MessageDirection;
  /** Matches the sender or any recipient. */
  readonly address?: EmailAddress;
  /** Matches an `ENVELOPE` or `TO` recipient -- the "without cc" recipient
   * filter. */
  readonly toAddress?: EmailAddress;
  /** Matches a recipient of any kind, `CC` and `BCC` included -- the
   * "with cc" recipient filter. */
  readonly recipientAddress?: EmailAddress;
  readonly fromAddress?: EmailAddress;
  readonly threadId?: ThreadId;
  readonly tagIds?: readonly TagId[];
  readonly excludeTagIds?: readonly TagId[];
  readonly unreadOnly?: boolean;
  /** `true` keeps only spam-marked messages, `false` only unmarked ones;
   * absent applies no spam restriction. */
  readonly spam?: boolean;
  /** Keeps messages whose lifecycle status is any of the listed values. */
  readonly statuses?: readonly MailStatus[];
  /** `true` keeps only mailing-list messages, `false` only the rest. */
  readonly mailingList?: boolean;
  /** Exact match on the stored `List-Id`. */
  readonly listId?: string;
  /** Case-insensitive substring match over subject, snippet and the stored
   * text body. */
  readonly search?: string;
  /** `true` keeps only messages with at least one attachment; `false`
   * keeps only messages with none. */
  readonly hasAttachment?: boolean;
  /** Keeps messages carrying at least one attachment of any listed kind. */
  readonly attachmentKinds?: readonly AttachmentKind[];
  readonly since?: string;
  readonly until?: string;
  /** Scope-derived allowlist matched against each message's addresses.
   * `null` means unrestricted (a user viewer). An empty array means the
   * viewer can see nothing, and must yield an empty page rather than
   * everything. */
  readonly allowedPatterns: readonly AddressPattern[] | null;
  /** Interactive-user mailbox-rule scoping (ADMIN/MEMBER/VIEWER). `null`
   * for an API-key viewer or a capability without per-address rules --
   * that credential's visibility is governed entirely by `allowedPatterns`
   * above instead. The two mechanisms are deliberately independent and
   * both apply when both are non-restrictive. */
  readonly mailPermissionFilter: MailPermissionFilter | null;
  /** Restricts to rows whose fetch state *for this key* has the given
   * status. A `NOT_FETCHED` filter must also match messages with no state
   * row at all, since an absent row means not yet fetched. */
  readonly fetchStatus?: {
    readonly apiKeyId: ApiKeyId;
    readonly status: FetchStatus;
  };
}

export interface MessagePage {
  readonly nodes: readonly Message[];
  /** `null` once the result set is exhausted. */
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

/** Everything written atomically when a message is stored. */
export interface InsertMessageInput {
  readonly message: Message;
  readonly recipients: readonly MessageRecipient[];
  readonly attachments: readonly Attachment[];
  readonly tagIds: readonly TagId[];
  readonly taggedAt: string;
  /** Spam verdict written in the same atomic batch as the message. */
  readonly spam?: SpamMark;
}

export interface MessageRepository {
  findById(id: MessageId): Promise<Message | null>;
  findByIds(ids: readonly MessageId[]): Promise<readonly Message[]>;
  /** Backs duplicate suppression on the ingest path. */
  findByRfcMessageId(rfcMessageId: string): Promise<Message | null>;
  /** Resolves an existing thread from a `References` chain, newest match
   * first. */
  findThreadIdByReferences(
    references: readonly string[],
  ): Promise<ThreadId | null>;
  list(
    filter: MessageListFilter,
    limit: number,
    cursor: string | null,
  ): Promise<MessagePage>;
  listByThread(threadId: ThreadId): Promise<readonly Message[]>;
  /** Single-`batch()` insert of the message plus its recipients,
   * attachments and tag rows. */
  insertWithRelations(input: InsertMessageInput): Promise<void>;
  save(message: Message): Promise<void>;
  delete(ids: readonly MessageId[]): Promise<number>;
  setRead(
    ids: readonly MessageId[],
    readAt: string | null,
    updatedAt: string,
  ): Promise<void>;

  /** Batch lookups keyed by message id, so GraphQL field resolvers never
   * issue N+1 queries. Keys are the raw id strings. */
  listRecipients(
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, readonly MessageRecipient[]>>;
  listAttachments(
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, readonly Attachment[]>>;
  listTagIds(
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, readonly TagId[]>>;

  findAttachmentById(id: AttachmentId): Promise<Attachment | null>;
  saveAttachment(attachment: Attachment): Promise<void>;
  /** Staged attachments (no message yet) created before `cutoff`, so the
   * sweep can reclaim uploads that were never bound to a send. Returned
   * rather than deleted here because their blobs must be removed too. */
  listStaleStagedAttachments(cutoff: string): Promise<readonly Attachment[]>;
  /** Removes attachment rows by id; the caller owns blob deletion. */
  deleteAttachments(ids: readonly AttachmentId[]): Promise<void>;

  addTags(
    messageIds: readonly MessageId[],
    tagIds: readonly TagId[],
    taggedAt: string,
  ): Promise<void>;
  removeTags(
    messageIds: readonly MessageId[],
    tagIds: readonly TagId[],
  ): Promise<void>;

  /** Upserts spam verdicts; the newest mark wins for a marked message. */
  setSpamMarks(marks: readonly SpamMark[]): Promise<void>;
  clearSpamMarks(ids: readonly MessageId[]): Promise<void>;
  listSpamMarks(
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, SpamMark>>;

  /** Replaces a draft's recipient rows; used by draft updates, where the
   * recipient set is part of the editable content. */
  replaceRecipients(
    messageId: MessageId,
    recipients: readonly MessageRecipient[],
  ): Promise<void>;

  findFetchStates(
    apiKeyId: ApiKeyId,
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, MessageFetchState>>;
  saveFetchStates(states: readonly MessageFetchState[]): Promise<void>;
}
