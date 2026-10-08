export const MAX_FRAME_BYTES = 16_384;
export const MAX_SUBSCRIPTIONS = 4;
export const INIT_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 75_000;
export const SAFETY_DRAIN_MS = 60_000;
export const REPLAY_PAGE = 200;
export const MAX_CONN_PER_IP = 20;
export const MAX_CONN_PER_PRINCIPAL = 10;
export const MAX_CONN_TOTAL = 1_000;

export const SUBPROTOCOL = "graphql-transport-ws";

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  TooBig: 1009,
  BadRequest: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  InitTimeout: 4408,
  DuplicateSubscription: 4409,
  TooManyInitializations: 4429,
  RateLimited: 1013,
  Idle: 4000,
  InternalError: 4500,
} as const;

export interface ClientMessage {
  readonly type: string;
  readonly id?: string;
  readonly payload?: unknown;
}

export type ParsedClientMessage =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly error: "TOO_BIG" | "BAD_REQUEST" };

export interface InitPayload {
  readonly valid: boolean;
  readonly authorization: string | null;
}

export interface SubscribePayload {
  readonly query: string;
  readonly operationName: string | null;
  readonly variables: Record<string, unknown> | null;
}

export function parseClientMessage(
  data: string | ArrayBuffer,
): ParsedClientMessage {
  if (typeof data !== "string") {
    return { ok: false, error: "BAD_REQUEST" };
  }
  if (data.length > MAX_FRAME_BYTES) {
    return { ok: false, error: "TOO_BIG" };
  }
  if (new TextEncoder().encode(data).byteLength > MAX_FRAME_BYTES) {
    return { ok: false, error: "TOO_BIG" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, error: "BAD_REQUEST" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["type"] !== "string"
  ) {
    return { ok: false, error: "BAD_REQUEST" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["id"] !== undefined && typeof record["id"] !== "string") {
    return { ok: false, error: "BAD_REQUEST" };
  }
  return {
    ok: true,
    message: {
      type: record["type"] as string,
      ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
      ...(record["payload"] === undefined
        ? {}
        : { payload: record["payload"] }),
    },
  };
}

export function parseInitPayload(payload: unknown): InitPayload {
  if (payload === undefined) return { valid: true, authorization: null };
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return { valid: false, authorization: null };
  }
  const authorization = (payload as Record<string, unknown>)["authorization"];
  if (authorization === undefined) return { valid: true, authorization: null };
  return typeof authorization === "string"
    ? { valid: true, authorization }
    : { valid: false, authorization: null };
}

export function parseSubscribePayload(
  payload: unknown,
): SubscribePayload | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = payload as Record<string, unknown>;
  const query = value["query"];
  const operationName = value["operationName"];
  const variables = value["variables"];
  if (typeof query !== "string") return null;
  if (
    operationName !== undefined &&
    operationName !== null &&
    typeof operationName !== "string"
  ) {
    return null;
  }
  if (
    variables !== undefined &&
    variables !== null &&
    (typeof variables !== "object" || Array.isArray(variables))
  ) {
    return null;
  }
  return {
    query,
    operationName: typeof operationName === "string" ? operationName : null,
    variables:
      variables !== undefined && variables !== null
        ? (variables as Record<string, unknown>)
        : null,
  };
}
