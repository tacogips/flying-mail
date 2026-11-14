import { InvalidStateTransitionError, ValidationError } from "../errors";
import type { EmailAddress } from "../value-objects/email-address";
import type { DomainId, MessageId, ThreadId } from "../value-objects/ids";

export {
  buildSnippet,
  htmlToPlainText,
  SNIPPET_LENGTH,
} from "./message-snippet";
import { buildSnippet } from "./message-snippet";

export enum MessageDirection {
  Inbound = "INBOUND",
  Outbound = "OUTBOUND",
}

/** `RECEIVED` is terminal for inbound mail. Outbound mail starts `QUEUED`
 * -- the row is written before the provider call, so an eviction mid-send
 * leaves a visible, retryable message rather than a silent loss -- and
 * moves exactly once to `SENT` or `FAILED`. */
/** Coarse mail lifecycle, the axis a mailbox UI files by. `DRAFT` exists
 * only for outbound mail that has not been dispatched; everything else is
 * `SENT` or `RECEIVED` by direction. Transport detail (queued, failed)
 * stays in {@link DeliveryStatus}, which is only meaningful once a message
 * leaves `DRAFT`. */
export enum MailStatus {
  Draft = "DRAFT",
  Sent = "SENT",
  Received = "RECEIVED",
}

export enum DeliveryStatus {
  Received = "RECEIVED",
  Queued = "QUEUED",
  Sent = "SENT",
  Failed = "FAILED",
}

/** `ENVELOPE` is the SMTP RCPT TO: the address that actually caused
 * delivery, and therefore the one API key scopes are matched against.
 * `TO`/`CC` come from headers and legitimately may not contain it (aliases,
 * BCC, mailing lists). */
export enum RecipientKind {
  To = "TO",
  Cc = "CC",
  Bcc = "BCC",
  Envelope = "ENVELOPE",
}

export interface MessageRecipient {
  readonly kind: RecipientKind;
  readonly address: EmailAddress;
  readonly name: string | null;
  readonly position: number;
}

export interface Message {
  readonly id: MessageId;
  readonly domainId: DomainId;
  readonly direction: MessageDirection;
  readonly threadId: ThreadId;
  /** RFC 5322 `Message-ID`, angle brackets stripped. */
  readonly rfcMessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly fromAddress: EmailAddress;
  readonly fromName: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  /** True when a body exceeded the stored-length cap. The untouched original
   * remains reachable through the raw `.eml` file link. */
  readonly bodyTruncated: boolean;
  readonly snippet: string;
  readonly rawKey: string | null;
  readonly rawSize: number;
  readonly spamScore: number | null;
  readonly status: MailStatus;
  readonly deliveryStatus: DeliveryStatus;
  /** RFC 2919 `List-Id` (angle-bracket form stripped), when the message
   * came through a mailing list that declares one. */
  readonly listId: string | null;
  /** True when list headers (`List-Id`, `List-Unsubscribe`, `List-Post`,
   * `Precedence: list|bulk`) or a classification rule say this message is
   * mailing-list traffic. A field rather than a tag: it is an intrinsic,
   * deterministically-detected property that must survive tag renames. */
  readonly isMailingList: boolean;
  readonly deliveryError: string | null;
  readonly readAt: string | null;
  /** Received-at for inbound mail, sent-at (or queued-at) for outbound. */
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CommonMessageInput {
  readonly id: MessageId;
  readonly domainId: DomainId;
  readonly threadId: ThreadId;
  readonly rfcMessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly fromAddress: EmailAddress;
  readonly fromName: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly bodyTruncated?: boolean;
  readonly rawKey: string | null;
  readonly rawSize: number;
  readonly occurredAt: string;
  readonly createdAt: string;
}

export interface CreateInboundMessageInput extends CommonMessageInput {
  readonly spamScore: number | null;
  readonly listId?: string | null;
  readonly isMailingList?: boolean;
}

export type CreateOutboundMessageInput = CommonMessageInput;

function assertSpamScore(score: number | null): void {
  if (score === null) {
    return;
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new ValidationError("spamScore must be between 0 and 1", "spamScore");
  }
}

function assertRawSize(rawSize: number): void {
  if (!Number.isFinite(rawSize) || rawSize < 0) {
    throw new ValidationError(
      "rawSize must be a non-negative finite number",
      "rawSize",
    );
  }
}

function baseMessage(
  input: CommonMessageInput,
  direction: MessageDirection,
  status: MailStatus,
  deliveryStatus: DeliveryStatus,
  spamScore: number | null,
): Message {
  assertRawSize(input.rawSize);
  assertSpamScore(spamScore);
  return {
    id: input.id,
    domainId: input.domainId,
    direction,
    threadId: input.threadId,
    rfcMessageId: input.rfcMessageId,
    inReplyTo: input.inReplyTo,
    references: [...input.references],
    subject: input.subject,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    textBody: input.textBody,
    htmlBody: input.htmlBody,
    bodyTruncated: input.bodyTruncated ?? false,
    snippet: buildSnippet(input.textBody, input.htmlBody),
    rawKey: input.rawKey,
    rawSize: input.rawSize,
    spamScore,
    status,
    deliveryStatus,
    listId: null,
    isMailingList: false,
    deliveryError: null,
    readAt: null,
    occurredAt: input.occurredAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Inbound mail is `RECEIVED` the moment it exists; there is no input that
 * can construct it in any other delivery state. */
export function createInboundMessage(
  input: CreateInboundMessageInput,
): Message {
  const base = baseMessage(
    input,
    MessageDirection.Inbound,
    MailStatus.Received,
    DeliveryStatus.Received,
    input.spamScore,
  );
  return {
    ...base,
    listId: input.listId ?? null,
    isMailingList: input.isMailingList ?? input.listId != null,
  };
}

/** Outbound mail is always born `QUEUED`; see {@link DeliveryStatus}. */
export function createOutboundMessage(
  input: CreateOutboundMessageInput,
): Message {
  return baseMessage(
    input,
    MessageDirection.Outbound,
    MailStatus.Sent,
    DeliveryStatus.Queued,
    null,
  );
}

/** A draft: outbound mail that has not entered the send pipeline. Its
 * `deliveryStatus` is `QUEUED` only as the value it will hold at dispatch;
 * readers should treat delivery detail as meaningless while `DRAFT`. */
export function createDraftMessage(input: CreateOutboundMessageInput): Message {
  return baseMessage(
    input,
    MessageDirection.Outbound,
    MailStatus.Draft,
    DeliveryStatus.Queued,
    null,
  );
}

export interface DraftContentPatch {
  readonly subject?: string;
  readonly fromAddress?: EmailAddress;
  readonly fromName?: string | null;
  readonly textBody?: string | null;
  readonly htmlBody?: string | null;
}

function assertDraft(message: Message): void {
  if (message.status !== MailStatus.Draft) {
    throw new InvalidStateTransitionError(
      `Message ${message.id} is not a draft`,
      message.status,
      MailStatus.Draft,
    );
  }
}

export function updateDraftMessage(
  message: Message,
  patch: DraftContentPatch,
  at: string,
): Message {
  assertDraft(message);
  const textBody =
    patch.textBody === undefined ? message.textBody : patch.textBody;
  const htmlBody =
    patch.htmlBody === undefined ? message.htmlBody : patch.htmlBody;
  return {
    ...message,
    subject: patch.subject ?? message.subject,
    fromAddress: patch.fromAddress ?? message.fromAddress,
    fromName: patch.fromName === undefined ? message.fromName : patch.fromName,
    textBody,
    htmlBody,
    snippet: buildSnippet(textBody, htmlBody),
    occurredAt: at,
    updatedAt: at,
  };
}

/** Hands a draft to the send pipeline: `DRAFT` -> `SENT` lifecycle-wise,
 * transport still `QUEUED` until the provider answers. One-way. */
export function submitDraft(message: Message, at: string): Message {
  assertDraft(message);
  return {
    ...message,
    status: MailStatus.Sent,
    deliveryStatus: DeliveryStatus.Queued,
    occurredAt: at,
    updatedAt: at,
  };
}

function assertQueued(message: Message, to: DeliveryStatus): void {
  if (message.deliveryStatus !== DeliveryStatus.Queued) {
    throw new InvalidStateTransitionError(
      `Message ${message.id} is not queued for delivery`,
      message.deliveryStatus,
      to,
    );
  }
}

export function markMessageSent(message: Message, sentAt: string): Message {
  assertQueued(message, DeliveryStatus.Sent);
  return {
    ...message,
    deliveryStatus: DeliveryStatus.Sent,
    deliveryError: null,
    occurredAt: sentAt,
    updatedAt: sentAt,
  };
}

export function markMessageFailed(
  message: Message,
  error: string,
  failedAt: string,
): Message {
  assertQueued(message, DeliveryStatus.Failed);
  return {
    ...message,
    deliveryStatus: DeliveryStatus.Failed,
    deliveryError: error,
    updatedAt: failedAt,
  };
}

/** Puts a `FAILED` outbound message back in the queue so it can be retried.
 * Rejected for any other state: re-queuing a `SENT` message would send it
 * twice. */
export function requeueMessage(message: Message, at: string): Message {
  if (message.deliveryStatus !== DeliveryStatus.Failed) {
    throw new InvalidStateTransitionError(
      `Only a failed message can be re-queued`,
      message.deliveryStatus,
      DeliveryStatus.Queued,
    );
  }
  return {
    ...message,
    deliveryStatus: DeliveryStatus.Queued,
    deliveryError: null,
    updatedAt: at,
  };
}

export function markMessageRead(
  message: Message,
  readAt: string | null,
  updatedAt: string,
): Message {
  return { ...message, readAt, updatedAt };
}

export function isMessageRead(message: Message): boolean {
  return message.readAt !== null;
}
