import type { MailEventScope } from "@flying-mail/domain/entities/mail-event";
import { hasAnyMailRead } from "@flying-mail/application/policies/authorization";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { UseCases } from "@flying-mail/application/usecases";
import type { Viewer } from "@flying-mail/application/policies";
import { parseMailEventCursor } from "@flying-mail/domain/value-objects/mail-event-cursor";
import type { PrepareResult, SubscriptionExecutor } from "./executor";
import {
  CloseCode,
  MAX_SUBSCRIPTIONS,
  parseSubscribePayload,
} from "./protocol";

export {
  createHubMessageProcessor,
  type MessageReservation,
} from "./hub-message-processor";

export interface HubConnection {
  readonly id: string;
}

export interface UpgradeInfo {
  readonly clientIp: string | null;
  readonly cookieTokenHash: string | null;
}

export interface SubscriptionState {
  readonly id: string;
  readonly query: string;
  readonly operationName: string | null;
  readonly variables: Record<string, unknown> | null;
  readonly scope: MailEventScope;
  lastSeq: number;
  live: boolean;
}

export interface ConnectionState {
  readonly v: 1;
  readonly connId: string;
  readonly clientIp: string | null;
  readonly cookieTokenHash: string | null;
  readonly openedAt: number;
  readonly initDeadline: number;
  acked: boolean;
  principal: {
    readonly tokenHash: string;
    readonly kind: "USER" | "API_KEY";
    readonly id: string;
  } | null;
  lastMessageAt: number;
  subscriptions: SubscriptionState[];
}

export interface RealtimeHost {
  listConnections(): readonly HubConnection[];
  loadState(conn: HubConnection): Promise<ConnectionState | null>;
  saveState(conn: HubConnection, state: ConnectionState): Promise<void>;
  deleteState(conn: HubConnection): Promise<void>;
  send(conn: HubConnection, text: string): void;
  close(conn: HubConnection, code: number, reason: string): void;
  lastAutoResponseAt(conn: HubConnection): number | null;
  scheduleWake(atMs: number | null): void;
  now(): number;
}

export function sendRealtimeMessage(
  host: RealtimeHost,
  conn: HubConnection,
  value: unknown,
): void {
  try {
    host.send(conn, JSON.stringify(value));
  } catch {
    // A concurrent socket close is harmless.
  }
}

export function closeRealtimeConnection(
  host: RealtimeHost,
  conn: HubConnection,
  code: number,
  reason: string,
): void {
  try {
    host.close(conn, code, reason);
  } catch {
    // Closing an already closed socket is harmless.
  }
}

export interface SubscriptionHandlerOptions {
  readonly host: RealtimeHost;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly executor: SubscriptionExecutor;
  readonly save: (conn: HubConnection, state: ConnectionState) => Promise<void>;
  readonly closeWith: (
    conn: HubConnection,
    state: ConnectionState,
    code: number,
    reason: string,
  ) => Promise<void>;
  readonly requestDrain: () => Promise<void>;
}

function sendError(
  options: SubscriptionHandlerOptions,
  conn: HubConnection,
  id: string,
  code: string,
  message: string,
): void {
  try {
    options.host.send(
      conn,
      JSON.stringify({
        id,
        type: "error",
        payload: [{ message, extensions: { code } }],
      }),
    );
  } catch {
    // The socket can close concurrently with subscription validation.
  }
}

export function createSubscriptionHandler(
  options: SubscriptionHandlerOptions,
): (
  conn: HubConnection,
  state: ConnectionState,
  id: string | undefined,
  payload: unknown,
) => Promise<void> {
  return async (conn, state, id, payload) => {
    if (!state.acked) {
      await options.closeWith(
        conn,
        state,
        CloseCode.Unauthorized,
        "connection_init required",
      );
      return;
    }
    if (id === undefined) {
      await options.closeWith(
        conn,
        state,
        CloseCode.BadRequest,
        "Subscription id required",
      );
      return;
    }
    if (state.subscriptions.length >= MAX_SUBSCRIPTIONS) {
      sendError(
        options,
        conn,
        id,
        "RATE_LIMITED",
        "Maximum subscriptions per connection reached",
      );
      return;
    }
    const request = parseSubscribePayload(payload);
    if (request === null || state.principal === null) {
      sendError(
        options,
        conn,
        id,
        "BAD_USER_INPUT",
        "Invalid subscription payload",
      );
      return;
    }
    let viewer: Viewer | null;
    try {
      viewer = await options.usecases.resolveViewerFromTokenHash(
        state.principal.tokenHash,
        { recordUsage: false },
      );
    } catch {
      await options.closeWith(
        conn,
        state,
        CloseCode.Unauthorized,
        "Authentication expired",
      );
      return;
    }
    if (viewer === null) {
      await options.closeWith(
        conn,
        state,
        CloseCode.Unauthorized,
        "Authentication expired",
      );
      return;
    }
    if (!hasAnyMailRead(viewer)) {
      await options.closeWith(
        conn,
        state,
        CloseCode.Forbidden,
        "MAIL_READ was revoked",
      );
      return;
    }
    let preparedResult: PrepareResult;
    try {
      preparedResult = options.executor.prepare(request, viewer);
    } catch {
      sendError(options, conn, id, "BAD_USER_INPUT", "Invalid subscription");
      return;
    }
    if (!preparedResult.ok) {
      try {
        options.host.send(
          conn,
          JSON.stringify({ id, type: "error", payload: preparedResult.errors }),
        );
      } catch {
        // A concurrent socket close is harmless.
      }
      return;
    }
    const prepared = preparedResult.prepared;
    const logState = await options.deps.mailEventLog.state();
    let lastSeq = logState.headSeq;
    if (prepared.after !== null) {
      const cursor = parseMailEventCursor(prepared.after);
      if (cursor === null) {
        sendError(
          options,
          conn,
          id,
          "BAD_USER_INPUT",
          "Invalid mail event cursor",
        );
        return;
      }
      if (
        cursor.epoch !== logState.epoch ||
        cursor.seq < logState.prunedThroughSeq ||
        cursor.seq > logState.headSeq
      ) {
        sendError(
          options,
          conn,
          id,
          "RESYNC_REQUIRED",
          "Cursor is outside the event retention window; resynchronize",
        );
        return;
      }
      lastSeq = cursor.seq;
    }
    state.subscriptions.push({
      id,
      query: request.query,
      operationName: request.operationName,
      variables: request.variables,
      scope: prepared.scope,
      lastSeq,
      live: false,
    });
    await options.save(conn, state);
    void options.requestDrain().catch(() => {
      console.error("Realtime drain request failed");
    });
  };
}
