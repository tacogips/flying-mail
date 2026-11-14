import { ValidationError } from "../errors";
import type { ExternalAccountId, MessageId } from "../value-objects/ids";

/** Why a remote message was recorded without being ingested. */
export enum ExternalMessageSkipReason {
  /** Larger than the fetch size cap; never downloaded. */
  TooLarge = "TOO_LARGE",
}

/** One row per remote message the fetch has dealt with -- the dedupe ledger.
 * A fetched message is recorded in the same batch as the ingested message so
 * a crash between the two cannot double-ingest. A message that was
 * deliberately skipped is recorded too (with no local message) so it is not
 * listed and skipped again on every run.
 *
 * `remoteId` is the provider's own identifier for the message (a JMAP
 * `Email` id, or a POP3 `UIDL`), scoped to one account: the same string from
 * two different accounts is not the same message.
 *
 * Exactly one of `messageId` and `skipReason` is set. */
export interface ExternalMessageState {
  readonly accountId: ExternalAccountId;
  readonly remoteId: string;
  readonly messageId: MessageId | null;
  readonly fetchedAt: string;
  readonly skipReason: ExternalMessageSkipReason | null;
}

export interface CreateExternalMessageStateInput {
  readonly accountId: ExternalAccountId;
  readonly remoteId: string;
  readonly messageId: MessageId;
  readonly fetchedAt: string;
}

export interface CreateSkippedExternalMessageStateInput {
  readonly accountId: ExternalAccountId;
  readonly remoteId: string;
  readonly skipReason: ExternalMessageSkipReason;
  readonly fetchedAt: string;
}

function normalizeRemoteId(remoteId: string): string {
  const trimmed = remoteId.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("remoteId must not be empty", "remoteId");
  }
  return trimmed;
}

export function createExternalMessageState(
  input: CreateExternalMessageStateInput,
): ExternalMessageState {
  return {
    accountId: input.accountId,
    remoteId: normalizeRemoteId(input.remoteId),
    messageId: input.messageId,
    fetchedAt: input.fetchedAt,
    skipReason: null,
  };
}

/** A ledger row for a remote message that was seen but not ingested. */
export function createSkippedExternalMessageState(
  input: CreateSkippedExternalMessageStateInput,
): ExternalMessageState {
  return {
    accountId: input.accountId,
    remoteId: normalizeRemoteId(input.remoteId),
    messageId: null,
    fetchedAt: input.fetchedAt,
    skipReason: input.skipReason,
  };
}
