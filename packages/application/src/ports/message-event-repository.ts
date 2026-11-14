import type { MessageEvent } from "@mailcal/domain/entities/message-event";
import type { AddressPattern } from "@mailcal/domain/value-objects/address-pattern";
import type {
  MessageEventId,
  MessageId,
} from "@mailcal/domain/value-objects/ids";
import type { MailPermissionFilter } from "../policies/authorization";

export interface MessageEventListFilter {
  /** Due on or before this instant. Events with no dueAt never match a
   * due-bounded filter. */
  readonly dueBefore?: string;
  readonly dueAfter?: string;
  readonly includeCompleted?: boolean;
  /** Scope allowlist over the owning message's addresses, with the same
   * semantics as `MessageListFilter.allowedPatterns`. */
  readonly allowedPatterns: readonly AddressPattern[] | null;
  /** Interactive-user mailbox-rule scoping over the owning message, with
   * the same semantics as `MessageListFilter.mailPermissionFilter`. */
  readonly mailPermissionFilter: MailPermissionFilter | null;
}

export interface MessageEventRepository {
  findById(id: MessageEventId): Promise<MessageEvent | null>;
  save(event: MessageEvent): Promise<void>;
  delete(id: MessageEventId): Promise<void>;
  listByMessages(
    ids: readonly MessageId[],
  ): Promise<ReadonlyMap<string, readonly MessageEvent[]>>;
  /** Agenda listing across messages, soonest due first, undated last. */
  list(
    filter: MessageEventListFilter,
    limit: number,
  ): Promise<readonly MessageEvent[]>;
}
