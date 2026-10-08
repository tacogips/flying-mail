export type ConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

export interface WebSocketLike {
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  onclose:
    | ((ev: { readonly code: number; readonly reason: string }) => void)
    | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface MailEventStreamOptions {
  readonly url: string;
  readonly query: string;
  readonly scope?: {
    readonly domainId?: string;
    readonly address?: string;
    readonly types?: readonly string[];
  } | null;
  readonly initialCursor?: string | null;
  readonly connectionParams?: () =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
  readonly onEvent: (event: Record<string, unknown>) => void;
  readonly onCursor?: (cursor: string | null) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  readonly onResync?: () => void;
  readonly onAuthFailure?: () => void;
  readonly onFatal?: (info: {
    readonly code: number;
    readonly reason: string;
  }) => void;
  readonly webSocketFactory?: (url: string, protocol: string) => WebSocketLike;
  readonly timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly random?: () => number;
}

export interface MailEventStream {
  start(): void;
  stop(): void;
}

export const MAIL_EVENT_CLOSE_CODES = {
  NORMAL: 1000,
  MESSAGE_TOO_BIG: 1009,
  TRY_AGAIN_LATER: 1013,
  HEARTBEAT_TIMEOUT: 4000,
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  INIT_TIMEOUT: 4408,
  SUBSCRIBER_ALREADY_EXISTS: 4409,
  TOO_MANY_INIT_REQUESTS: 4429,
  INTERNAL_ERROR: 4500,
} as const;
