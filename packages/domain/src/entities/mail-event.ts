import type { DomainId, MessageId } from "../value-objects/ids";

/** Persisted mail event kinds. Transport control messages are not stored here. */
export enum MailEventType {
  MessageReceived = "MESSAGE_RECEIVED",
  MessageSent = "MESSAGE_SENT",
  MessageUpdated = "MESSAGE_UPDATED",
  MessageDeleted = "MESSAGE_DELETED",
  DraftSaved = "DRAFT_SAVED",
  DraftDeleted = "DRAFT_DELETED",
}

export interface NewMailEvent {
  readonly type: MailEventType;
  readonly messageId: MessageId;
  readonly domainId: DomainId;
  readonly addresses: readonly string[];
}

export interface MailEventRecord extends NewMailEvent {
  readonly seq: number;
  readonly occurredAt: string;
}

export interface MailEventScope {
  readonly domainId: DomainId | null;
  readonly address: string | null;
  /** Filter only; never a grant. LIVE is never listed here. */
  readonly types?: readonly MailEventType[] | null;
}

/** Normalize event addresses into a stable, deduplicated persistence order. */
export function normalizeEventAddresses(
  addresses: readonly string[],
): readonly string[] {
  return [...new Set(addresses.map((address) => address.trim().toLowerCase()))]
    .filter((address) => address.length > 0)
    .sort();
}
