import type { ConnectionState, HubConnection, RealtimeHost } from "./host";
import { createFrameRateLimiter } from "./frame-rate-limiter";
import {
  ACTIVITY_PERSIST_INTERVAL_MS,
  CloseCode,
  MAX_SUBSCRIPTIONS,
  parseClientMessage,
} from "./protocol";
import type { SubscriptionHandlerOptions } from "./host";

export interface MessageReservation {
  readonly duplicateInit: boolean;
}

export interface HubMessageProcessorOptions {
  readonly host: RealtimeHost;
  readonly getState: (conn: HubConnection) => ConnectionState | null;
  readonly save: (conn: HubConnection, state: ConnectionState) => Promise<void>;
  readonly closeWith: SubscriptionHandlerOptions["closeWith"];
  readonly init: (
    conn: HubConnection,
    state: ConnectionState,
    payload: unknown,
    alreadyStarted: boolean,
  ) => Promise<void>;
  readonly subscribe: (
    conn: HubConnection,
    state: ConnectionState,
    id: string | undefined,
    payload: unknown,
  ) => Promise<void>;
  readonly forget: (connId: string, subscriptionId?: string) => void;
  /**
   * Returns the lastMessageAt value last written to storage for the state, or
   * negative infinity when it has never been persisted by this hub instance.
   */
  readonly persistedActivityAt: (state: ConnectionState) => number;
}

export function createHubMessageProcessor(
  options: HubMessageProcessorOptions,
): (
  conn: HubConnection,
  data: string | ArrayBuffer,
  reservation: MessageReservation,
) => Promise<void> {
  const frames = createFrameRateLimiter();

  // Frames that change persisted state (connection_init, subscribe, complete)
  // are saved by their own handlers, so lastMessageAt rides along with those
  // writes. Other frames (ping, pong) only update memory, plus one write per
  // ACTIVITY_PERSIST_INTERVAL_MS so a rehydrated hub does not see stale
  // activity and idle-close a connection that is still talking.
  async function persistActivityIfDue(
    conn: HubConnection,
    state: ConnectionState,
    now: number,
  ): Promise<void> {
    if (now - options.persistedActivityAt(state) < ACTIVITY_PERSIST_INTERVAL_MS)
      return;
    await options.save(conn, state);
  }

  return async (conn, data, reservation) => {
    const state = options.getState(conn);
    if (state === null) return;
    const now = options.host.now();
    state.lastMessageAt = now;
    if (!frames.consume(state, now)) {
      await options.closeWith(
        conn,
        state,
        CloseCode.RateLimited,
        "Too many messages",
      );
      return;
    }
    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      await options.closeWith(
        conn,
        state,
        parsed.error === "TOO_BIG" ? CloseCode.TooBig : CloseCode.BadRequest,
        parsed.error === "TOO_BIG" ? "Message too big" : "Invalid message",
      );
      return;
    }
    if (options.getState(conn) !== state) return;
    switch (parsed.message.type) {
      case "connection_init":
        await options.init(
          conn,
          state,
          parsed.message.payload,
          reservation.duplicateInit,
        );
        return;
      case "subscribe":
        if (!state.acked) {
          await options.closeWith(
            conn,
            state,
            CloseCode.Unauthorized,
            "connection_init required",
          );
        } else if (
          parsed.message.id !== undefined &&
          state.subscriptions.some((sub) => sub.id === parsed.message.id)
        ) {
          await options.closeWith(
            conn,
            state,
            CloseCode.DuplicateSubscription,
            "Subscriber already exists",
          );
        } else if (state.subscriptions.length >= MAX_SUBSCRIPTIONS) {
          try {
            options.host.send(
              conn,
              JSON.stringify({
                id: parsed.message.id,
                type: "error",
                payload: [
                  {
                    message: "Maximum subscriptions per connection reached",
                    extensions: { code: "RATE_LIMITED" },
                  },
                ],
              }),
            );
          } catch {
            // A concurrent socket close is harmless.
          }
        } else {
          await options.subscribe(
            conn,
            state,
            parsed.message.id,
            parsed.message.payload,
          );
        }
        return;
      case "complete":
        if (parsed.message.id !== undefined) {
          state.subscriptions = state.subscriptions.filter(
            (sub) => sub.id !== parsed.message.id,
          );
          options.forget(state.connId, parsed.message.id);
          await options.save(conn, state);
        }
        return;
      case "ping":
        try {
          options.host.send(
            conn,
            JSON.stringify({
              type: "pong",
              ...(parsed.message.payload === undefined
                ? {}
                : { payload: parsed.message.payload }),
            }),
          );
        } catch {
          // A concurrent socket close is harmless.
        }
        await persistActivityIfDue(conn, state, now);
        return;
      case "pong":
        await persistActivityIfDue(conn, state, now);
        return;
      default:
        await options.closeWith(
          conn,
          state,
          CloseCode.BadRequest,
          "Unknown message type",
        );
    }
  };
}
