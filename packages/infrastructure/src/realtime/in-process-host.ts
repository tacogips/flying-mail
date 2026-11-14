import type { MailEventNotifier } from "@flying-mail/application/ports/mail-event-notifier";
import type { ConnectionState, HubConnection, RealtimeHost } from "./host";

export interface InProcessHostOptions {
  readonly now?: () => number;
  readonly setTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface InProcessSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface InProcessHost extends RealtimeHost {
  attach(socket: InProcessSocket): HubConnection;
  detach(conn: HubConnection): void;
  setWakeHandler(handler: () => Promise<void>): void;
}

export function createInProcessHost(
  options: InProcessHostOptions = {},
): InProcessHost {
  const now = options.now ?? Date.now;
  const armTimer =
    options.setTimeout ??
    ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  const sockets = new Map<string, InProcessSocket>();
  const states = new Map<string, ConnectionState>();
  let nextId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeHandler: (() => Promise<void>) | null = null;

  const host: InProcessHost = {
    attach(socket) {
      const conn = { id: `in-process-${++nextId}` };
      sockets.set(conn.id, socket);
      return conn;
    },
    detach(conn) {
      sockets.delete(conn.id);
      states.delete(conn.id);
    },
    setWakeHandler(handler) {
      wakeHandler = handler;
    },
    listConnections() {
      return [...sockets.keys()].map((id) => ({ id }));
    },
    async loadState(conn) {
      return states.get(conn.id) ?? null;
    },
    async saveState(conn, state) {
      states.set(conn.id, state);
    },
    async deleteState(conn) {
      states.delete(conn.id);
    },
    send(conn, text) {
      sockets.get(conn.id)?.send(text);
    },
    close(conn, code, reason) {
      sockets.get(conn.id)?.close(code, reason);
    },
    lastAutoResponseAt() {
      return null;
    },
    scheduleWake(atMs) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (atMs === null) return;
      timer = armTimer(
        () => {
          timer = null;
          const handler = wakeHandler;
          if (handler === null) return;
          try {
            void handler().catch(() => console.error("Realtime wake failed"));
          } catch {
            console.error("Realtime wake failed");
          }
        },
        Math.max(0, atMs - now()),
      );
    },
    now,
  };
  return host;
}

export function createLateBoundMailEventNotifier(): MailEventNotifier & {
  bind(target: { requestDrain(): Promise<void> }): void;
} {
  let target: { requestDrain(): Promise<void> } | null = null;
  return {
    bind(value) {
      target = value;
    },
    notify() {
      if (target === null) return;
      try {
        void target
          .requestDrain()
          .catch(() => console.error("Realtime mail event drain failed"));
      } catch {
        console.error("Realtime mail event drain failed");
      }
    },
  };
}
