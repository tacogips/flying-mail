/**
 * Small `fetch`-based GraphQL client. No Apollo or urql: the app makes a
 * handful of operation shapes and the whole transport fits in one readable
 * file, which is worth more here than a cache layer nobody tunes.
 *
 * The session credential is an `HttpOnly` cookie the server sets on
 * `verifyEmailAuthToken`, so this module never holds a token. Browsers
 * attach it automatically to same-origin requests; explicitly public
 * operations opt out with `credentials: "omit"` so an existing session can
 * neither authenticate nor influence them.
 */

import { createSignal } from "solid-js";

export type GraphQLErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_USER_INPUT"
  | "CONFLICT"
  | "SERVICE_UNAVAILABLE"
  | "UNKNOWN";

export interface GraphQLClientError {
  readonly message: string;
  readonly code: GraphQLErrorCode;
  readonly path?: readonly (string | number)[];
}

export type GraphQLResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errors: readonly GraphQLClientError[] };

export interface GraphQLRequestOptions {
  readonly signal?: AbortSignal;
}

interface RequestBehavior {
  readonly attachSession: boolean;
  readonly clearSessionOnUnauthenticated: boolean;
}

/**
 * In-memory "is a session established" flag.
 *
 * There is no token to persist: the `HttpOnly` cookie is the actual
 * credential and is invisible to this code. This exists only so the rest of
 * the app can react to session establishment and loss without every call
 * site knowing that the source of truth is "did the last `viewer` query
 * succeed". Cleared on reload; re-derived by `rehydrateSession`.
 */
export interface SessionStore {
  isEstablished(): boolean;
  markEstablished(): void;
  clear(): void;
}

const GRAPHQL_ENDPOINT = "/graphql";

const GRAPHQL_ERROR_CODES: readonly GraphQLErrorCode[] = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "BAD_USER_INPUT",
  "CONFLICT",
  "SERVICE_UNAVAILABLE",
  "UNKNOWN",
];

function isGraphQLErrorCode(value: unknown): value is GraphQLErrorCode {
  return (
    typeof value === "string" &&
    (GRAPHQL_ERROR_CODES as readonly string[]).includes(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractCode(rawError: Record<string, unknown>): GraphQLErrorCode {
  const extensions = asRecord(rawError["extensions"]);
  if (extensions === undefined) {
    return "UNKNOWN";
  }
  const code = extensions["code"];
  return isGraphQLErrorCode(code) ? code : "UNKNOWN";
}

function extractPath(
  rawError: Record<string, unknown>,
): readonly (string | number)[] | undefined {
  const path = rawError["path"];
  if (!Array.isArray(path)) {
    return undefined;
  }
  const segments = path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );
  return segments.length > 0 ? segments : undefined;
}

export function mapGraphQLError(rawError: unknown): GraphQLClientError {
  const record = asRecord(rawError) ?? {};
  const message =
    typeof record["message"] === "string"
      ? record["message"]
      : "Unknown GraphQL error";
  const code = extractCode(record);
  const path = extractPath(record);
  return path === undefined ? { message, code } : { message, code, path };
}

function extractRawErrors(payload: unknown): readonly unknown[] {
  const errors = asRecord(payload)?.["errors"];
  return Array.isArray(errors) ? errors : [];
}

function extractData<TData>(payload: unknown): TData | undefined {
  const record = asRecord(payload);
  if (record === undefined || !("data" in record)) {
    return undefined;
  }
  const data = record["data"];
  return data === null || data === undefined ? undefined : (data as TData);
}

export function httpStatusToErrorCode(status: number): GraphQLErrorCode {
  if (status === 401) {
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 503) {
    return "SERVICE_UNAVAILABLE";
  }
  return "UNKNOWN";
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Network request failed";
}

/**
 * Centralizes UNAUTHENTICATED handling: any request anywhere in the app
 * that comes back unauthenticated -- an expired or revoked session --
 * clears the session store here, rather than every call site having to
 * notice. `AppStore` mirrors this into its `viewer` signal, so the auth
 * guard redirects on the next render.
 */
function clearSessionIfUnauthenticated(
  errors: readonly GraphQLClientError[],
): void {
  if (errors.some((error) => error.code === "UNAUTHENTICATED")) {
    sessionStore.clear();
  }
}

async function executeGraphQLRequest<
  TData,
  TVariables extends Record<string, unknown> = Record<string, never>,
>(
  query: string,
  variables: TVariables | undefined,
  options: GraphQLRequestOptions | undefined,
  behavior: RequestBehavior,
): Promise<GraphQLResult<TData>> {
  const body: { query: string; variables?: TVariables } =
    variables === undefined ? { query } : { query, variables };

  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // The default same-origin credentials already send the `HttpOnly`
    // session cookie. A public request explicitly opts out, so it can never
    // be authenticated by -- or influenced by -- a session the visitor
    // happens to be carrying.
    credentials: behavior.attachSession ? "same-origin" : "omit",
  };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }

  let response: Response;
  try {
    response = await fetch(GRAPHQL_ENDPOINT, init);
  } catch (error) {
    return {
      ok: false,
      errors: [{ message: networkErrorMessage(error), code: "UNKNOWN" }],
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    const errors: readonly GraphQLClientError[] = [
      {
        message: `Request failed with status ${response.status}`,
        code: httpStatusToErrorCode(response.status),
      },
    ];
    if (behavior.clearSessionOnUnauthenticated) {
      clearSessionIfUnauthenticated(errors);
    }
    return { ok: false, errors };
  }

  const rawErrors = extractRawErrors(payload);
  if (rawErrors.length > 0) {
    const errors = rawErrors.map(mapGraphQLError);
    if (behavior.clearSessionOnUnauthenticated) {
      clearSessionIfUnauthenticated(errors);
    }
    return { ok: false, errors };
  }

  const data = extractData<TData>(payload);
  if (data === undefined) {
    return {
      ok: false,
      errors: [{ message: "GraphQL response missing data", code: "UNKNOWN" }],
    };
  }
  return { ok: true, data };
}

/** Authenticated application request. */
export function graphqlRequest<
  TData,
  TVariables extends Record<string, unknown> = Record<string, never>,
>(
  query: string,
  variables?: TVariables,
  options?: GraphQLRequestOptions,
): Promise<GraphQLResult<TData>> {
  return executeGraphQLRequest<TData, TVariables>(query, variables, options, {
    attachSession: true,
    clearSessionOnUnauthenticated: true,
  });
}

/** Public request, isolated from any existing session. */
export function publicGraphqlRequest<
  TData,
  TVariables extends Record<string, unknown> = Record<string, never>,
>(
  query: string,
  variables?: TVariables,
  options?: GraphQLRequestOptions,
): Promise<GraphQLResult<TData>> {
  return executeGraphQLRequest<TData, TVariables>(query, variables, options, {
    attachSession: false,
    clearSessionOnUnauthenticated: false,
  });
}

const [sessionEstablished, setSessionEstablished] = createSignal(false);

export const sessionStore: SessionStore = {
  isEstablished: () => sessionEstablished(),
  markEstablished: () => setSessionEstablished(true),
  clear: () => setSessionEstablished(false),
};

/** Uploads a file for a later `sendMessage` to reference. Multipart, so it
 * cannot go through GraphQL. */
export async function uploadAttachment(
  file: File,
): Promise<GraphQLResult<{ readonly id: string; readonly fileName: string }>> {
  const form = new FormData();
  form.set("file", file);
  let response: Response;
  try {
    response = await fetch("/api/attachments", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
  } catch (error) {
    return {
      ok: false,
      errors: [{ message: networkErrorMessage(error), code: "UNKNOWN" }],
    };
  }
  if (!response.ok) {
    const errors: readonly GraphQLClientError[] = [
      {
        message: `Upload failed with status ${response.status}`,
        code: httpStatusToErrorCode(response.status),
      },
    ];
    clearSessionIfUnauthenticated(errors);
    return { ok: false, errors };
  }
  return {
    ok: true,
    data: (await response.json()) as {
      readonly id: string;
      readonly fileName: string;
    },
  };
}
