import type { AppDependencies } from "@flying-mail/application/dependencies";
import { normalizeClientIpForRateLimit } from "@flying-mail/infrastructure/composition/config";
import type { InProcessHost } from "@flying-mail/infrastructure/realtime/in-process-host";
import type { RealtimeHub } from "@flying-mail/infrastructure/realtime/hub";
import type {
  HubConnection,
  UpgradeInfo,
} from "@flying-mail/infrastructure/realtime/host";
import { checkRealtimeUpgrade } from "@flying-mail/infrastructure/realtime/upgrade";

export interface BunRealtimeServer {
  requestIP(request: Request): { readonly address: string } | null;
  upgrade(
    request: Request,
    options: {
      readonly data: { readonly info: UpgradeInfo };
      readonly headers: {
        readonly "Sec-WebSocket-Protocol": "graphql-transport-ws";
      };
    },
  ): boolean;
}

export interface BunRealtimeSocketData {
  readonly info: UpgradeInfo;
  conn?: HubConnection;
}

export interface BunRealtimeSocket {
  readonly data: BunRealtimeSocketData;
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface BunRealtimeHandlers {
  readonly upgrade: (
    request: Request,
    server: BunRealtimeServer,
  ) => Promise<Response | undefined>;
  readonly websocket: {
    readonly open: (socket: BunRealtimeSocket) => Promise<void>;
    readonly message: (
      socket: BunRealtimeSocket,
      message: string | ArrayBuffer | ArrayBufferView,
    ) => Promise<void>;
    readonly close: (socket: BunRealtimeSocket) => Promise<void>;
    readonly maxPayloadLength: number;
    readonly idleTimeout: number;
  };
}

function upgradeRejection(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function connectionFor(socket: BunRealtimeSocket): HubConnection | null {
  return socket.data.conn ?? null;
}

function toArrayBuffer(message: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (message instanceof ArrayBuffer) return message;
  return new Uint8Array(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  ).slice().buffer;
}

function closeAfterHandlerFailure(socket: BunRealtimeSocket): void {
  console.error("Realtime WebSocket handler failed");
  try {
    socket.close(1011, "Internal error");
  } catch {
    console.error("Failed to close realtime WebSocket");
  }
}

export function createBunRealtimeHandlers(options: {
  readonly hub: RealtimeHub;
  readonly host: InProcessHost;
  readonly deps: AppDependencies;
}): BunRealtimeHandlers {
  return {
    async upgrade(request, server) {
      const ip = normalizeClientIpForRateLimit(
        server.requestIP(request)?.address ?? null,
      );
      const checked = await checkRealtimeUpgrade(request, {
        publicOrigin: options.deps.instanceConfig.publicOrigin,
        clientIp: ip,
        rateLimiter: options.deps.rateLimiter,
        tokenHasher: options.deps.tokenHasher,
      });
      if (!checked.ok) return checked.response;

      const admission = options.hub.admit(ip);
      if (admission === "IP_LIMIT") {
        return upgradeRejection(429, "Too many WebSocket connections");
      }
      if (admission === "GLOBAL_LIMIT") {
        return upgradeRejection(503, "WebSocket connection capacity reached");
      }

      if (
        !server.upgrade(request, {
          data: { info: checked.info },
          headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" },
        })
      ) {
        return upgradeRejection(400, "WebSocket upgrade failed");
      }
      return undefined;
    },
    websocket: {
      async open(socket) {
        try {
          const conn = options.host.attach({
            send: (text) => socket.send(text),
            close: (code, reason) => socket.close(code, reason),
          });
          socket.data.conn = conn;
          await options.hub.open(conn, socket.data.info);
        } catch {
          closeAfterHandlerFailure(socket);
          const conn = connectionFor(socket);
          if (conn !== null) {
            try {
              await options.hub.closed(conn);
            } catch {
              console.error("Failed to clean up realtime WebSocket");
            } finally {
              options.host.detach(conn);
              delete socket.data.conn;
            }
          }
        }
      },
      async message(socket, message) {
        try {
          const conn = connectionFor(socket);
          if (conn === null) return;
          const data =
            typeof message === "string" ? message : toArrayBuffer(message);
          await options.hub.message(conn, data);
        } catch {
          closeAfterHandlerFailure(socket);
        }
      },
      async close(socket) {
        const conn = connectionFor(socket);
        if (conn === null) return;
        try {
          await options.hub.closed(conn);
        } catch {
          console.error("Realtime WebSocket close handling failed");
          closeAfterHandlerFailure(socket);
        } finally {
          options.host.detach(conn);
          delete socket.data.conn;
        }
      },
      maxPayloadLength: 65_536,
      // Bun documents this value in seconds. Keep its server timeout long;
      // the hub wake loop is authoritative for its own idle close policy.
      idleTimeout: 960,
    },
  };
}
