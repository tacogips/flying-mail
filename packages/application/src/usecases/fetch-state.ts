import { Capability } from "@mailcal/domain/entities/api-key";
import {
  FetchStatus,
  markFetched,
  markNotFetched,
  type MessageFetchState,
} from "@mailcal/domain/entities/fetch-state";
import type { Message } from "@mailcal/domain/entities/message";
import type { MessageId } from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { loadReadableMessages } from "./messages";

/** Fetch state is per API key, so two agents polling the same mailbox each
 * see every message exactly once. A user viewer has no consumer identity of
 * its own; asking it to acknowledge is a client bug, and silently no-oping
 * would hide it. */
function requireApiKeyViewer(
  viewer: Viewer,
): Extract<Viewer, { kind: "API_KEY" }> {
  if (viewer.kind !== "API_KEY") {
    throw new BadUserInputError(
      "Fetch state is tracked per API key; a user session has none",
      "viewer",
    );
  }
  return viewer;
}

async function updateFetchStates(
  deps: AppDependencies,
  viewer: Viewer,
  ids: readonly MessageId[],
  status: FetchStatus,
): Promise<readonly Message[]> {
  const keyViewer = requireApiKeyViewer(viewer);
  const messages = await loadReadableMessages(
    deps,
    viewer,
    ids,
    Capability.MailManage,
  );
  if (messages.length === 0) {
    return [];
  }
  const messageIds = messages.map((message) => message.id);
  const existing = await deps.messageRepository.findFetchStates(
    keyViewer.apiKeyId,
    messageIds,
  );
  const now = deps.clock.now().toISOString();
  const next: MessageFetchState[] = messageIds.map((messageId) =>
    status === FetchStatus.Fetched
      ? markFetched(
          existing.get(messageId) ?? null,
          messageId,
          keyViewer.apiKeyId,
          now,
        )
      : markNotFetched(messageId, keyViewer.apiKeyId, now),
  );
  await deps.messageRepository.saveFetchStates(next);
  return messages;
}

/** Idempotent acknowledgment: re-acknowledging keeps the original
 * `fetchedAt`, so a client retrying after a network failure does not
 * rewrite when it first consumed the message. */
export function createMarkMessagesFetchedUseCase(
  deps: AppDependencies,
): (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]> {
  return (viewer, ids) =>
    updateFetchStates(deps, viewer, ids, FetchStatus.Fetched);
}

/** Explicit un-acknowledgment, so a consumer can replay a message whose
 * processing failed after it had already acknowledged. */
export function createMarkMessagesNotFetchedUseCase(
  deps: AppDependencies,
): (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]> {
  return (viewer, ids) =>
    updateFetchStates(deps, viewer, ids, FetchStatus.NotFetched);
}

/** Resolves the fetch state for a batch of messages. A user viewer always
 * reads `FETCHED` -- it has no per-key state, and reporting `NOT_FETCHED`
 * to the browser client would make an agent's queue look permanently
 * unconsumed in the UI. */
export function createResolveFetchStatesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  ids: readonly MessageId[],
) => Promise<ReadonlyMap<string, MessageFetchState>> {
  return async (viewer, ids) => {
    if (viewer.kind !== "API_KEY") {
      return new Map();
    }
    return deps.messageRepository.findFetchStates(viewer.apiKeyId, ids);
  };
}

/** The status a client should see for one message. Kept beside the use
 * cases so GraphQL and the CLI cannot diverge on the user-viewer rule. */
export function resolveFetchStatusForViewer(
  viewer: Viewer,
  state: MessageFetchState | null | undefined,
): FetchStatus {
  if (viewer.kind === "USER") {
    return FetchStatus.Fetched;
  }
  return state?.status ?? FetchStatus.NotFetched;
}
