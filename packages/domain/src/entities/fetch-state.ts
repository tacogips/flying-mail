import type { ApiKeyId, MessageId } from "../value-objects/ids";

export enum FetchStatus {
  NotFetched = "NOT_FETCHED",
  Fetched = "FETCHED",
}

/** Per-consumer retrieval bookkeeping. The consumer is an API key, so two
 * agents polling the same mailbox each see every message exactly once
 * instead of racing over one shared flag.
 *
 * The absence of a row is equivalent to `NOT_FETCHED`; rows are only
 * written on acknowledgment, which keeps this table proportional to
 * acknowledged work rather than to `messages x keys`. */
export interface MessageFetchState {
  readonly messageId: MessageId;
  readonly apiKeyId: ApiKeyId;
  readonly status: FetchStatus;
  readonly fetchedAt: string | null;
  readonly updatedAt: string;
}

/** Idempotent: re-acknowledging an already-fetched message keeps the
 * original `fetchedAt`, so a client that retries an acknowledgment after a
 * network failure does not rewrite history. */
export function markFetched(
  state: MessageFetchState | null,
  messageId: MessageId,
  apiKeyId: ApiKeyId,
  at: string,
): MessageFetchState {
  if (state !== null && state.status === FetchStatus.Fetched) {
    return { ...state, updatedAt: at };
  }
  return {
    messageId,
    apiKeyId,
    status: FetchStatus.Fetched,
    fetchedAt: at,
    updatedAt: at,
  };
}

/** Explicit un-acknowledgment, so a consumer can replay a message it failed
 * to process after already acknowledging it. Clears `fetchedAt`. Takes no
 * prior state: the result does not depend on it. */
export function markNotFetched(
  messageId: MessageId,
  apiKeyId: ApiKeyId,
  at: string,
): MessageFetchState {
  return {
    messageId,
    apiKeyId,
    status: FetchStatus.NotFetched,
    fetchedAt: null,
    updatedAt: at,
  };
}

/** Resolves the effective status for a message, treating a missing row as
 * `NOT_FETCHED`. */
export function resolveFetchStatus(
  state: MessageFetchState | null | undefined,
): FetchStatus {
  return state?.status ?? FetchStatus.NotFetched;
}
