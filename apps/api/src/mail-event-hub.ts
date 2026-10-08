import { buildDependencies } from "@flying-mail/infrastructure/composition/build-dependencies";
import { buildGraphQLSchema } from "@flying-mail/infrastructure/graphql/schema";
import {
  createRealtimeHub,
  type RealtimeHub,
} from "@flying-mail/infrastructure/realtime/hub";
import type { SubscriptionExecutor } from "@flying-mail/infrastructure/realtime/executor";
import { createSubscriptionExecutor } from "@flying-mail/infrastructure/realtime/executor";
import type {
  ConnectionState,
  HubConnection,
  RealtimeHost,
} from "@flying-mail/infrastructure/realtime/host";
import { createUseCases } from "@flying-mail/application/usecases";
import { buildWorkerConfig } from "./worker-config";
import type { Env } from "./env";
import type {
  DurableObjectStateLike,
  HibernatableWebSocketLike,
} from "./durable-object-types";

export interface HubRuntime {
  createAutoResponsePair(request: string, response: string): unknown;
  createSocketPair(): {
    readonly client: HibernatableWebSocketLike;
    readonly server: HibernatableWebSocketLike;
  };
  createUpgradeResponse(client: HibernatableWebSocketLike): Response;
}

interface HubTestHooks {
  readonly executor?: SubscriptionExecutor;
}

interface WorkerGlobals {
  WebSocketRequestResponsePair: new (
    request: string,
    response: string,
  ) => unknown;
  WebSocketPair: new () => Record<string, HibernatableWebSocketLike>;
}

const workerGlobals = globalThis as unknown as WorkerGlobals;

const defaultRuntime: HubRuntime = {
  createAutoResponsePair(request, response) {
    return new workerGlobals.WebSocketRequestResponsePair(request, response);
  },
  createSocketPair() {
    const [client, server] = Object.values(new workerGlobals.WebSocketPair());
    if (client === undefined || server === undefined) {
      throw new Error("Workers WebSocketPair did not expose both sockets");
    }
    return { client, server };
  },
  createUpgradeResponse(client) {
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" },
    } as ResponseInit);
  },
};

function connectionFor(
  socket: HibernatableWebSocketLike,
): HubConnection | null {
  const attachment: unknown = socket.deserializeAttachment();
  if (
    typeof attachment !== "object" ||
    attachment === null ||
    typeof (attachment as Record<string, unknown>)["connId"] !== "string"
  ) {
    return null;
  }
  return { id: (attachment as { readonly connId: string }).connId };
}

export class MailEventHub {
  private readonly ready: Promise<void>;
  private hub: RealtimeHub | null = null;

  constructor(
    private readonly ctx: DurableObjectStateLike,
    env: Env,
    private readonly runtime: HubRuntime = defaultRuntime,
    testHooks: HubTestHooks = {},
  ) {
    ctx.setWebSocketAutoResponse(
      runtime.createAutoResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const deps = buildDependencies(buildWorkerConfig(env));
      const usecases = createUseCases(deps);
      const executor =
        testHooks.executor ??
        createSubscriptionExecutor({
          schema: buildGraphQLSchema(),
          deps,
          usecases,
          publicOrigin: deps.instanceConfig.publicOrigin,
        });
      const host = this.createHost();
      const hub = createRealtimeHub({ host, deps, usecases, executor });
      this.hub = hub;
      await hub.rehydrate();
      const stored = await ctx.storage.list<ConnectionState>({
        prefix: "conn:",
      });
      const liveIds = new Set(host.listConnections().map((conn) => conn.id));
      const storedIds = new Set(
        [...stored.keys()].map((key) => key.slice("conn:".length)),
      );
      await Promise.all(
        [...stored.keys()]
          .filter((key) => !liveIds.has(key.slice("conn:".length)))
          .map((key) => ctx.storage.delete(key)),
      );
      for (const conn of host.listConnections()) {
        if (!storedIds.has(conn.id)) host.close(conn, 1011, "Internal error");
      }
    });
  }

  private createHost(): RealtimeHost {
    const ctx = this.ctx;
    const connection = (
      conn: HubConnection,
    ): HibernatableWebSocketLike | null =>
      ctx.getWebSockets(`conn:${conn.id}`)[0] ?? null;
    return {
      listConnections: () =>
        ctx.getWebSockets().flatMap((socket) => {
          const conn = connectionFor(socket);
          return conn === null ? [] : [conn];
        }),
      async loadState(conn) {
        return (
          (await ctx.storage.get<ConnectionState>(`conn:${conn.id}`)) ?? null
        );
      },
      async saveState(conn, state) {
        await ctx.storage.put(`conn:${conn.id}`, state);
      },
      async deleteState(conn) {
        await ctx.storage.delete(`conn:${conn.id}`);
      },
      send: (conn, text) => connection(conn)?.send(text),
      close: (conn, code, reason) => connection(conn)?.close(code, reason),
      lastAutoResponseAt: (conn) => {
        const socket = connection(conn);
        return socket === null
          ? null
          : (ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null);
      },
      scheduleWake: (atMs) => {
        if (atMs === null) {
          void ctx.storage.deleteAlarm().catch(() => {
            console.error("Failed to delete realtime alarm");
          });
        } else {
          void ctx.storage.setAlarm(atMs).catch(() => {
            console.error("Failed to schedule realtime alarm");
          });
        }
      },
      now: () => Date.now(),
    };
  }

  private requireHub(): RealtimeHub {
    if (this.hub === null) throw new Error("MailEventHub is not initialized");
    return this.hub;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === "/notify" && request.method === "POST") {
      await this.requireHub().requestDrain();
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname !== "/connect" ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket"
    ) {
      return new Response("Not found", { status: 404 });
    }
    const clientIp = request.headers.get("x-flying-mail-client-ip");
    const admission = this.requireHub().admit(clientIp);
    if (admission === "IP_LIMIT") {
      return new Response("Too many connections", { status: 429 });
    }
    if (admission === "GLOBAL_LIMIT") {
      return new Response("Realtime capacity reached", { status: 503 });
    }
    const { client, server } = this.runtime.createSocketPair();
    const connId = crypto.randomUUID();
    try {
      this.ctx.acceptWebSocket(server, [
        `ip:${clientIp ?? "unknown"}`,
        `conn:${connId}`,
      ]);
      server.serializeAttachment({ connId });
      await this.requireHub().open(
        { id: connId },
        {
          clientIp,
          cookieTokenHash: request.headers.get(
            "x-flying-mail-session-token-hash",
          ),
        },
      );
      return this.runtime.createUpgradeResponse(client);
    } catch {
      console.error("Failed to accept realtime connection");
      try {
        server.close(1011, "Internal error");
      } catch {
        console.error("Failed to close realtime connection");
      }
      try {
        await this.requireHub().closed({ id: connId });
      } catch {
        console.error("Failed to clean up rejected realtime connection");
      }
      return new Response("Internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  async webSocketMessage(
    socket: HibernatableWebSocketLike,
    data: string | ArrayBuffer,
  ): Promise<void> {
    await this.ready;
    const conn = connectionFor(socket);
    if (conn !== null) await this.requireHub().message(conn, data);
  }

  async webSocketClose(socket: HibernatableWebSocketLike): Promise<void> {
    await this.socketClosed(socket);
  }

  async webSocketError(socket: HibernatableWebSocketLike): Promise<void> {
    await this.socketClosed(socket);
  }

  async alarm(): Promise<void> {
    await this.ready;
    await this.requireHub().wake();
  }

  private async socketClosed(socket: HibernatableWebSocketLike): Promise<void> {
    await this.ready;
    const conn = connectionFor(socket);
    if (conn !== null) await this.requireHub().closed(conn);
  }
}
