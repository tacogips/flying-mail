import { hasAnyMailRead } from "@flying-mail/application/policies/authorization";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { UseCases } from "@flying-mail/application/usecases";
import type { Viewer } from "@flying-mail/application/policies";
import type { SubscriptionExecutor } from "./executor";
import type {
  ConnectionState,
  HubConnection,
  RealtimeHost,
  UpgradeInfo,
} from "./host";
import { createDrain } from "./drain";
import {
  closeRealtimeConnection,
  createHubMessageProcessor,
  sendRealtimeMessage,
  createSubscriptionHandler,
} from "./host";
import {
  CloseCode,
  IDLE_TIMEOUT_MS,
  INIT_TIMEOUT_MS,
  MAX_CONN_PER_IP,
  MAX_CONN_PER_PRINCIPAL,
  MAX_CONN_TOTAL,
  SAFETY_DRAIN_MS,
  parseClientMessage,
  parseInitPayload,
} from "./protocol";

export type AdmitResult = "OK" | "IP_LIMIT" | "GLOBAL_LIMIT";

export interface RealtimeHub {
  rehydrate(): Promise<void>;
  admit(clientIp: string | null): AdmitResult;
  open(conn: HubConnection, info: UpgradeInfo): Promise<void>;
  message(conn: HubConnection, data: string | ArrayBuffer): Promise<void>;
  closed(conn: HubConnection): Promise<void>;
  requestDrain(): Promise<void>;
  wake(): Promise<void>;
}

interface HubOptions {
  readonly host: RealtimeHost;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly executor: SubscriptionExecutor;
}

function principalFor(
  viewer: Viewer,
  tokenHash: string,
): NonNullable<ConnectionState["principal"]> {
  return viewer.kind === "USER"
    ? { tokenHash, kind: viewer.kind, id: viewer.userId }
    : { tokenHash, kind: viewer.kind, id: viewer.apiKeyId };
}

export function createRealtimeHub(options: HubOptions): RealtimeHub {
  const states = new Map<
    string,
    { readonly connection: HubConnection; state: ConnectionState }
  >();
  const messageQueues = new Map<string, Promise<void>>();
  const initStarted = new Set<string>();
  const drain = createDrain({
    ...options,
    listStates: () => [...states.values()],
    dropConnection: async (conn, state, code) => {
      await closeWith(
        conn,
        state,
        code,
        "Authentication expired or unauthorized",
      );
    },
  });
  const stateFor = (conn: HubConnection): ConnectionState | null =>
    states.get(conn.id)?.state ?? null;
  const save = async (
    conn: HubConnection,
    state: ConnectionState,
  ): Promise<void> => {
    if (states.get(conn.id)?.state !== state) return;
    await options.host.saveState(conn, state);
    if (states.get(conn.id)?.state !== state) {
      await options.host.deleteState(conn);
      return;
    }
    states.set(conn.id, { connection: conn, state });
  };

  async function reschedule(): Promise<void> {
    const values = [...states.values()];
    const pending = values
      .map(({ state }) => (state.acked ? null : state.initDeadline))
      .filter((deadline): deadline is number => deadline !== null);
    if (pending.length > 0) options.host.scheduleWake(Math.min(...pending));
    else
      options.host.scheduleWake(
        values.length > 0 ? options.host.now() + SAFETY_DRAIN_MS : null,
      );
  }

  async function closeWith(
    conn: HubConnection,
    state: ConnectionState,
    code: number,
    reason: string,
  ): Promise<void> {
    closeRealtimeConnection(options.host, conn, code, reason);
    states.delete(state.connId);
    initStarted.delete(conn.id);
    drain.forget(state.connId);
    await options.host.deleteState(conn);
  }

  async function init(
    conn: HubConnection,
    state: ConnectionState,
    payload: unknown,
    alreadyStarted: boolean,
  ): Promise<void> {
    if (alreadyStarted || state.acked) {
      await closeWith(
        conn,
        state,
        CloseCode.TooManyInitializations,
        "Too many connection_init requests",
      );
      return;
    }
    const parsed = parseInitPayload(payload);
    if (!parsed.valid) {
      await closeWith(
        conn,
        state,
        CloseCode.BadRequest,
        "Invalid connection_init payload",
      );
      return;
    }
    let viewer: Viewer | null = null;
    let tokenHash: string | null = null;
    if (parsed.authorization !== null) {
      if (!parsed.authorization.startsWith("Bearer ")) {
        await closeWith(
          conn,
          state,
          CloseCode.Unauthorized,
          "Invalid authorization",
        );
        return;
      }
      const token = parsed.authorization.slice("Bearer ".length);
      try {
        viewer = await options.usecases.resolveViewerFromToken(token);
        if (viewer !== null)
          tokenHash = await options.deps.tokenHasher.hash(token);
      } catch {
        await closeWith(
          conn,
          state,
          CloseCode.Unauthorized,
          "Invalid authorization",
        );
        return;
      }
    } else if (state.cookieTokenHash !== null) {
      tokenHash = state.cookieTokenHash;
      try {
        viewer = await options.usecases.resolveViewerFromTokenHash(tokenHash, {
          recordUsage: false,
        });
      } catch {
        await closeWith(
          conn,
          state,
          CloseCode.Unauthorized,
          "Invalid authorization",
        );
        return;
      }
    }
    if (states.get(conn.id)?.state !== state) return;
    if (viewer === null || tokenHash === null) {
      await closeWith(
        conn,
        state,
        CloseCode.Unauthorized,
        "Authentication required",
      );
      return;
    }
    if (!hasAnyMailRead(viewer)) {
      await closeWith(
        conn,
        state,
        CloseCode.Forbidden,
        "MAIL_READ is required",
      );
      return;
    }
    const principal = principalFor(viewer, tokenHash);
    try {
      if (
        options.deps.rateLimiter !== null &&
        !(await options.deps.rateLimiter.limit(
          `ws:init:${principal.kind}:${principal.id}`,
        ))
      ) {
        await closeWith(
          conn,
          state,
          CloseCode.RateLimited,
          "Too many connection attempts",
        );
        return;
      }
    } catch {
      // Limiter outages should not prevent a valid connection from opening.
    }
    if (states.get(conn.id)?.state !== state) return;
    const count = [...states.values()].filter(
      ({ state: other }) =>
        other.acked &&
        other.principal?.kind === principal.kind &&
        other.principal.id === principal.id,
    ).length;
    if (count >= MAX_CONN_PER_PRINCIPAL) {
      await closeWith(
        conn,
        state,
        CloseCode.RateLimited,
        "Too many connections",
      );
      return;
    }
    if (states.get(conn.id)?.state !== state) return;
    state.acked = true;
    state.principal = principal;
    await save(conn, state);
    sendRealtimeMessage(options.host, conn, { type: "connection_ack" });
    await reschedule();
  }

  const subscribe = createSubscriptionHandler({
    host: options.host,
    deps: options.deps,
    usecases: options.usecases,
    executor: options.executor,
    save,
    closeWith,
    requestDrain: () => drain.requestDrain(),
  });

  const hubProcessMessage = createHubMessageProcessor({
    host: options.host,
    getState: stateFor,
    save,
    closeWith,
    init,
    subscribe,
    forget: drain.forget,
  });

  return {
    async rehydrate() {
      states.clear();
      for (const conn of options.host.listConnections()) {
        const state = await options.host.loadState(conn);
        if (state !== null) states.set(conn.id, { connection: conn, state });
      }
      await reschedule();
    },
    admit(clientIp) {
      const values = [...states.values()];
      if (values.length >= MAX_CONN_TOTAL) return "GLOBAL_LIMIT";
      if (
        values.filter(({ state }) => state.clientIp === clientIp).length >=
        MAX_CONN_PER_IP
      )
        return "IP_LIMIT";
      return "OK";
    },
    async open(conn, info) {
      const openedAt = options.host.now();
      const state: ConnectionState = {
        v: 1,
        connId: conn.id,
        clientIp: info.clientIp,
        cookieTokenHash: info.cookieTokenHash,
        openedAt,
        initDeadline: openedAt + INIT_TIMEOUT_MS,
        acked: false,
        principal: null,
        lastMessageAt: openedAt,
        subscriptions: [],
      };
      states.set(conn.id, { connection: conn, state });
      const connectionCount = states.size;
      const ipCount = [...states.values()].filter(
        ({ state: current }) => current.clientIp === info.clientIp,
      ).length;
      if (connectionCount > MAX_CONN_TOTAL || ipCount > MAX_CONN_PER_IP) {
        await closeWith(
          conn,
          state,
          CloseCode.RateLimited,
          "Too many connections",
        );
        await reschedule();
        return;
      }
      await options.host.saveState(conn, state);
      await reschedule();
    },
    async message(conn, data) {
      const parsed = parseClientMessage(data);
      const isInit = parsed.ok && parsed.message.type === "connection_init";
      const duplicateInit = isInit && initStarted.has(conn.id);
      if (isInit) initStarted.add(conn.id);
      const previous = messageQueues.get(conn.id) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => hubProcessMessage(conn, data, { duplicateInit }));
      messageQueues.set(conn.id, current);
      try {
        await current;
      } catch {
        console.error("Realtime message processing failed");
        const state = stateFor(conn);
        if (state !== null) {
          try {
            await closeWith(
              conn,
              state,
              CloseCode.InternalError,
              "Internal error",
            );
          } catch {
            console.error("Realtime connection cleanup failed");
          }
        }
      } finally {
        if (messageQueues.get(conn.id) === current)
          messageQueues.delete(conn.id);
      }
    },
    async closed(conn) {
      const state = stateFor(conn);
      if (state !== null) drain.forget(state.connId);
      states.delete(conn.id);
      initStarted.delete(conn.id);
      await options.host.deleteState(conn);
      await reschedule();
    },
    requestDrain: () => drain.requestDrain(),
    async wake() {
      const now = options.host.now();
      for (const { connection, state } of [...states.values()]) {
        if (!state.acked && state.initDeadline <= now) {
          await closeWith(
            connection,
            state,
            CloseCode.InitTimeout,
            "Connection initialization timed out",
          );
          continue;
        }
        const lastActivity = Math.max(
          state.lastMessageAt,
          options.host.lastAutoResponseAt(connection) ??
            Number.NEGATIVE_INFINITY,
        );
        if (lastActivity + IDLE_TIMEOUT_MS < now)
          await closeWith(
            connection,
            state,
            CloseCode.Idle,
            "Connection idle timeout",
          );
      }
      await drain.requestDrain();
      await reschedule();
    },
  };
}
