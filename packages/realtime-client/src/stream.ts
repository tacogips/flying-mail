import { compareCursors } from "./cursor";
import { reconnectDelay } from "./backoff";
import { MAIL_EVENT_CLOSE_CODES } from "./protocol";
import type {
  ConnectionStatus,
  MailEventStream,
  MailEventStreamOptions,
  WebSocketLike,
} from "./protocol";

const PROTOCOL = "graphql-transport-ws";
const ACK_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultTimers(): TimerPort {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function defaultSocket(url: string, protocol: string): WebSocketLike {
  return new globalThis.WebSocket(url, protocol) as unknown as WebSocketLike;
}

function isResyncError(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry: unknown) => {
    if (!isRecord(entry)) return false;
    const extensions = entry["extensions"];
    return isRecord(extensions) && extensions["code"] === "RESYNC_REQUIRED";
  });
}

function errorReason(value: unknown): string {
  if (Array.isArray(value) && isRecord(value[0])) {
    const message = value[0]["message"];
    if (typeof message === "string") return message;
  }
  return "Subscription failed";
}

export function createMailEventStream(
  options: MailEventStreamOptions,
): MailEventStream {
  const timers = options.timers ?? defaultTimers();
  const random = options.random ?? Math.random;
  const socketFactory = options.webSocketFactory ?? defaultSocket;
  let stopped = true;
  let attempt = 0;
  let lastCursor = options.initialCursor ?? null;
  let socket: WebSocketLike | null = null;
  let subscriptionId: string | null = null;
  let nextSubscriptionId = 0;
  let reconnectTimer: unknown;
  let ackTimer: unknown;
  let pingTimer: unknown;
  let pongTimer: unknown;
  let status: ConnectionStatus | null = null;

  const setStatus = (next: ConnectionStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearTimer = (handle: unknown): void => {
    if (handle !== undefined) timers.clearTimeout(handle);
  };

  const clearSocketTimers = (): void => {
    clearTimer(ackTimer);
    clearTimer(pingTimer);
    clearTimer(pongTimer);
    ackTimer = undefined;
    pingTimer = undefined;
    pongTimer = undefined;
  };

  const terminate = (): void => {
    stopped = true;
    clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    clearSocketTimers();
    const current = socket;
    socket = null;
    subscriptionId = null;
    if (current !== null)
      current.close(MAIL_EVENT_CLOSE_CODES.NORMAL, "Client stopped");
  };

  const fatal = (code: number, reason: string): void => {
    setStatus("offline");
    options.onFatal?.({ code, reason });
    terminate();
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    setStatus("reconnecting");
    const delay = reconnectDelay(attempt, random);
    attempt += 1;
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const subscribe = (current: WebSocketLike): void => {
    if (stopped || socket !== current) return;
    nextSubscriptionId += 1;
    subscriptionId = String(nextSubscriptionId);
    current.send(
      JSON.stringify({
        id: subscriptionId,
        type: "subscribe",
        payload: {
          query: options.query,
          variables: { scope: options.scope ?? null, after: lastCursor },
        },
      }),
    );
  };

  const startHeartbeat = (current: WebSocketLike): void => {
    const sendPing = (): void => {
      if (stopped || socket !== current) return;
      current.send('{"type":"ping"}');
      pongTimer = timers.setTimeout(() => {
        pongTimer = undefined;
        if (socket === current && !stopped) {
          current.close(
            MAIL_EVENT_CLOSE_CODES.HEARTBEAT_TIMEOUT,
            "Pong timeout",
          );
        }
      }, PONG_TIMEOUT_MS);
      pingTimer = timers.setTimeout(sendPing, PING_INTERVAL_MS);
    };
    pingTimer = timers.setTimeout(sendPing, PING_INTERVAL_MS);
  };

  const onMessage = (current: WebSocketLike, raw: unknown): void => {
    if (stopped || socket !== current) return;
    clearTimer(pongTimer);
    pongTimer = undefined;

    let message: unknown;
    try {
      const data = isRecord(raw) && "data" in raw ? raw["data"] : raw;
      if (typeof data !== "string")
        throw new TypeError("Expected a text frame");
      message = JSON.parse(data) as unknown;
    } catch {
      fatal(MAIL_EVENT_CLOSE_CODES.BAD_REQUEST, "Invalid server frame");
      current.close(MAIL_EVENT_CLOSE_CODES.BAD_REQUEST, "Invalid server frame");
      return;
    }

    if (!isRecord(message) || typeof message["type"] !== "string") {
      fatal(MAIL_EVENT_CLOSE_CODES.BAD_REQUEST, "Invalid server message");
      current.close(
        MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
        "Invalid server message",
      );
      return;
    }

    switch (message["type"]) {
      case "connection_ack":
        clearTimer(ackTimer);
        ackTimer = undefined;
        subscribe(current);
        startHeartbeat(current);
        return;
      case "ping":
        current.send('{"type":"pong"}');
        return;
      case "pong":
        return;
      case "next": {
        if (message["id"] !== subscriptionId || !isRecord(message["payload"]))
          return;
        const data = message["payload"]["data"];
        const event = isRecord(data) ? data["mailEvents"] : undefined;
        if (
          !isRecord(event) ||
          typeof event["cursor"] !== "string" ||
          typeof event["type"] !== "string"
        ) {
          fatal(
            MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
            "Subscription event is missing cursor or type",
          );
          current.close(
            MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
            "Invalid subscription event",
          );
          return;
        }
        const cursor = event["cursor"];
        const isLive = event["type"] === "LIVE";
        if (lastCursor !== null) {
          const comparison = compareCursors(cursor, lastCursor);
          if (comparison === "older" || (comparison === "same" && !isLive)) {
            return;
          }
        }
        lastCursor = cursor;
        options.onCursor?.(cursor);
        options.onEvent(event);
        if (isLive) {
          attempt = 0;
          setStatus("live");
        }
        return;
      }
      case "error":
        if (message["id"] !== subscriptionId) return;
        if (isResyncError(message["payload"])) {
          lastCursor = null;
          options.onCursor?.(null);
          options.onResync?.();
          subscribe(current);
          return;
        }
        fatal(
          MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
          errorReason(message["payload"]),
        );
        current.close(
          MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
          "Subscription failed",
        );
        return;
      case "complete":
        if (message["id"] === subscriptionId)
          current.close(MAIL_EVENT_CLOSE_CODES.NORMAL, "Subscription complete");
        return;
      default:
        fatal(
          MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
          "Unknown server message type",
        );
        current.close(
          MAIL_EVENT_CLOSE_CODES.BAD_REQUEST,
          "Unknown message type",
        );
    }
  };

  function connect(): void {
    if (stopped) return;
    setStatus(attempt === 0 && status === null ? "connecting" : "reconnecting");
    let paramsPromise: Promise<Record<string, unknown> | undefined>;
    try {
      paramsPromise = Promise.resolve(options.connectionParams?.());
    } catch (error) {
      paramsPromise = Promise.reject(error);
    }

    let current: WebSocketLike;
    try {
      current = socketFactory(options.url, PROTOCOL);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = current;
    subscriptionId = null;

    current.onopen = () => {
      if (stopped || socket !== current) return;
      ackTimer = timers.setTimeout(() => {
        ackTimer = undefined;
        current.close(
          MAIL_EVENT_CLOSE_CODES.INIT_TIMEOUT,
          "Connection acknowledgement timeout",
        );
      }, ACK_TIMEOUT_MS);
      void paramsPromise.then(
        (params) => {
          if (!stopped && socket === current) {
            current.send(
              JSON.stringify({
                type: "connection_init",
                payload: params ?? {},
              }),
            );
          }
        },
        () => {
          if (!stopped && socket === current)
            current.close(
              MAIL_EVENT_CLOSE_CODES.INTERNAL_ERROR,
              "Connection parameters failed",
            );
        },
      );
    };
    current.onmessage = (event) => onMessage(current, event);
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      subscriptionId = null;
      clearSocketTimers();
      if (stopped) return;
      const info = { code: event.code, reason: event.reason };
      if (event.code === MAIL_EVENT_CLOSE_CODES.UNAUTHORIZED) {
        setStatus("offline");
        options.onAuthFailure?.();
        terminate();
        return;
      }
      if (
        event.code === MAIL_EVENT_CLOSE_CODES.FORBIDDEN ||
        event.code === MAIL_EVENT_CLOSE_CODES.BAD_REQUEST ||
        event.code === MAIL_EVENT_CLOSE_CODES.SUBSCRIBER_ALREADY_EXISTS ||
        event.code === MAIL_EVENT_CLOSE_CODES.TOO_MANY_INIT_REQUESTS ||
        event.code === MAIL_EVENT_CLOSE_CODES.MESSAGE_TOO_BIG
      ) {
        setStatus("offline");
        options.onFatal?.(info);
        terminate();
        return;
      }
      scheduleReconnect();
    };
    current.onerror = () => {
      if (!stopped && socket === current) current.close();
    };
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      status = null;
      attempt = 0;
      connect();
    },
    stop(): void {
      if (stopped) return;
      setStatus("offline");
      terminate();
    },
  };
}
