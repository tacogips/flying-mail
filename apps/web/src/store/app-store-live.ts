import { createSignal } from "solid-js";
import {
  createMailEventStream,
  type ConnectionStatus,
  type MailEventStream,
  type MailEventStreamOptions,
} from "@flying-mail/realtime-client";
import type { MessageView } from "../api/schema-types";
import { MAIL_EVENTS_SUBSCRIPTION } from "../api/realtime-documents";
import type { AppStore } from "./app-store";

const REFRESH_DEBOUNCE_MS = 750;

type LiveEvent = Record<string, unknown>;
type StreamFactory = typeof createMailEventStream;

export interface LiveUpdatesOptions {
  readonly streamFactory?: StreamFactory;
  readonly location?: Location;
}

export interface LiveUpdates {
  readonly status: () => ConnectionStatus;
  start(): void;
  stop(): void;
}

function messageFromEvent(event: LiveEvent): MessageView | null {
  const message = event["message"];
  if (
    typeof message !== "object" ||
    message === null ||
    typeof (message as Record<string, unknown>)["id"] !== "string"
  ) {
    return null;
  }
  return message as MessageView;
}

export function createLiveUpdates(
  store: AppStore,
  options: LiveUpdatesOptions = {},
): LiveUpdates {
  const [status, setStatus] = createSignal<ConnectionStatus>("offline");
  const streamFactory = options.streamFactory ?? createMailEventStream;
  let stream: MailEventStream | null = null;
  let started = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let authRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveAuthFailures = 0;
  let authRecoveryPending = false;

  const clearTimer = (
    timer: ReturnType<typeof setTimeout> | undefined,
  ): void => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const clearAuthRetry = (): void => {
    clearTimer(authRetryTimer);
    authRetryTimer = undefined;
  };

  const refreshSafely = (): void => {
    void store.refreshVisible().catch(() => undefined);
  };

  const catchUp = (): void => {
    refreshSafely();
    void store.reloadTags().catch(() => undefined);
  };

  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshSafely();
    }, REFRESH_DEBOUNCE_MS);
  };

  const onEvent = (event: LiveEvent): void => {
    const type = event["type"];
    if (type === "LIVE") {
      consecutiveAuthFailures = 0;
      clearAuthRetry();
      catchUp();
      return;
    }

    if (
      type === "MESSAGE_UPDATED" ||
      type === "MESSAGE_SENT" ||
      type === "DRAFT_SAVED"
    ) {
      const message = messageFromEvent(event);
      if (message !== null) {
        store.patchMessage(message);
        store.publishLiveMessageEvent({ type: "MESSAGE_UPDATED", message });
      }
    } else if (type === "MESSAGE_DELETED" || type === "DRAFT_DELETED") {
      const messageId = event["messageId"];
      if (typeof messageId === "string") {
        store.removeMessage(messageId);
        if (type === "MESSAGE_DELETED") {
          store.publishLiveMessageEvent({ type: "MESSAGE_DELETED", messageId });
        }
      }
    }
    scheduleRefresh();
  };

  const resolveLocation = (): Location | undefined => {
    if (options.location !== undefined) return options.location;
    return typeof globalThis.location === "undefined"
      ? undefined
      : globalThis.location;
  };

  const makeStreamOptions = (
    currentLocation: Location,
  ): MailEventStreamOptions => ({
    url: `${currentLocation.protocol === "https:" ? "wss" : "ws"}://${currentLocation.host}/graphql`,
    query: MAIL_EVENTS_SUBSCRIPTION,
    scope: null,
    onEvent,
    onStatus: (next) => {
      setStatus(next);
      store.setLiveStatus(next);
    },
    onAuthFailure: () => {
      if (authRecoveryPending) return;
      authRecoveryPending = true;
      void (async () => {
        try {
          await store.rehydrateSession();
          if (store.viewer() === null) {
            stop();
            return;
          }
          consecutiveAuthFailures += 1;
          if (consecutiveAuthFailures >= 3) {
            stop();
            return;
          }
          const backoff = Math.min(
            30_000,
            1_000 * 2 ** (consecutiveAuthFailures - 1),
          );
          const delay = Math.random() * backoff;
          started = false;
          clearAuthRetry();
          authRetryTimer = setTimeout(() => {
            authRetryTimer = undefined;
            authRecoveryPending = false;
            start();
          }, delay);
        } finally {
          authRecoveryPending = false;
        }
      })();
    },
    onFatal: () => {
      clearAuthRetry();
      clearTimer(refreshTimer);
      refreshTimer = undefined;
      setStatus("offline");
      store.setLiveStatus("offline");
      started = false;
    },
  });

  const getStream = (): MailEventStream | null => {
    if (stream !== null) return stream;
    const currentLocation = resolveLocation();
    if (currentLocation === undefined) return null;
    stream = streamFactory(makeStreamOptions(currentLocation));
    return stream;
  };

  function start(): void {
    if (started) return;
    if (typeof WebSocket === "undefined") {
      setStatus("offline");
      store.setLiveStatus("offline");
      return;
    }
    const current = getStream();
    if (current === null) {
      setStatus("offline");
      store.setLiveStatus("offline");
      return;
    }
    started = true;
    current.start();
  }

  function stop(): void {
    started = false;
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    clearAuthRetry();
    authRecoveryPending = false;
    stream?.stop();
    setStatus("offline");
    store.setLiveStatus("offline");
  }

  return { status, start, stop };
}
