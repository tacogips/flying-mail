import {
  ExternalMailAuthError,
  ExternalMailTransportError,
  type JmapClient,
  type JmapCredentials,
  type JmapFetchedMessage,
  type JmapFetchResult,
} from "@flying-mail/application/ports/external-mail";

/** RFC 8620/8621 JMAP client using an injectable `fetchImpl` for
 * canned-fixture tests with no real network. Flow: GET the session resource
 * -> `Mailbox/get` for the inbox
 * (`role: "inbox"`) -> `Email/query` sorted by `receivedAt` ascending,
 * bounded to one page of `max` -> `Email/get` + raw blob download for ids
 * not already in `knownRemoteIds`. `state`/`queryState` are read but not
 * persisted -- the design doc's "re-query is idempotent" simplification --
 * so there is no `Email/queryChanges` here. */

const JMAP_MAIL_ACCOUNT_URN = "urn:ietf:params:jmap:mail";
const JMAP_USING = ["urn:ietf:params:jmap:core", JMAP_MAIL_ACCOUNT_URN];
const RAW_BLOB_TYPE = "message/rfc822";
const RAW_BLOB_NAME = "raw.eml";

export interface JmapClientOptions {
  readonly fetchImpl?: typeof fetch;
}

function basicAuth(credentials: JmapCredentials): string {
  // `btoa` is Latin-1 only; a JMAP username/password is not guaranteed
  // ASCII, so this goes through UTF-8 bytes first.
  const raw = `${credentials.username}:${credentials.password}`;
  let binary = "";
  for (const byte of new TextEncoder().encode(raw)) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExternalMailTransportError(
      `JMAP ${context} was not a JSON object`,
    );
  }
  // Validated above: a non-null, non-array `object` narrows structurally to
  // a string-keyed bag. Every field read off it below still goes through
  // `asString`/`asArray`/`asRecord` rather than being trusted as-is.
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ExternalMailTransportError(
      `JMAP ${context} was not a JSON array`,
    );
  }
  return value;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new ExternalMailTransportError(`JMAP ${context} was not a string`);
  }
  return value;
}

interface JmapMethodResponse {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function parseMethodResponseEntry(
  entry: unknown,
  index: number,
): JmapMethodResponse {
  const tuple = asArray(entry, `methodResponses[${index}]`);
  return {
    name: asString(tuple[0], `methodResponses[${index}][0]`),
    args: asRecord(tuple[1], `methodResponses[${index}][1]`),
  };
}

async function parseJsonResponse(
  response: Response,
  context: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ExternalMailTransportError(
      `${context} response was not valid JSON`,
      error,
    );
  }
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new ExternalMailTransportError(
      `${context} request to ${url} failed`,
      error,
    );
  }
  if (response.status === 401) {
    throw new ExternalMailAuthError(
      `${context} server rejected the credentials (401)`,
    );
  }
  if (!response.ok) {
    throw new ExternalMailTransportError(
      `${context} request to ${url} returned ${response.status}`,
    );
  }
  return parseJsonResponse(response, context);
}

interface JmapSession {
  readonly accountId: string;
  readonly apiUrl: string;
  readonly downloadUrl: string;
}

async function fetchSession(
  fetchImpl: typeof fetch,
  credentials: JmapCredentials,
): Promise<JmapSession> {
  const body = await fetchJson(
    fetchImpl,
    credentials.sessionUrl,
    {
      headers: {
        Authorization: basicAuth(credentials),
        Accept: "application/json",
      },
    },
    "JMAP session",
  );
  const record = asRecord(body, "session");
  const primaryAccounts = asRecord(
    record["primaryAccounts"],
    "session.primaryAccounts",
  );
  const accountId = asString(
    primaryAccounts[JMAP_MAIL_ACCOUNT_URN],
    `session.primaryAccounts[${JMAP_MAIL_ACCOUNT_URN}]`,
  );
  return {
    accountId,
    apiUrl: asString(record["apiUrl"], "session.apiUrl"),
    downloadUrl: asString(record["downloadUrl"], "session.downloadUrl"),
  };
}

/** Issues one JMAP method call and returns its `args`, mapping a
 * method-level `error` response the same way an HTTP-level failure is
 * mapped. */
async function callSingle(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  methodName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = await fetchJson(
    fetchImpl,
    session.apiUrl,
    {
      method: "POST",
      headers: {
        Authorization: basicAuth(credentials),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        using: JMAP_USING,
        methodCalls: [[methodName, args, "call"]],
      }),
    },
    "JMAP",
  );
  const record = asRecord(body, "JMAP response");
  const methodResponses = asArray(record["methodResponses"], "methodResponses");
  const first = methodResponses[0];
  if (first === undefined) {
    throw new ExternalMailTransportError(
      `JMAP ${methodName} returned no method response`,
    );
  }
  const parsed = parseMethodResponseEntry(first, 0);
  if (parsed.name === "error") {
    const type = parsed.args["type"];
    const typeText = typeof type === "string" ? type : "unknown";
    if (typeText === "unauthorized") {
      throw new ExternalMailAuthError(`JMAP ${methodName} was unauthorized`);
    }
    throw new ExternalMailTransportError(
      `JMAP ${methodName} failed: ${typeText}`,
    );
  }
  return parsed.args;
}

async function findInboxId(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
): Promise<string> {
  const args = await callSingle(
    fetchImpl,
    session,
    credentials,
    "Mailbox/get",
    {
      accountId: session.accountId,
      ids: null,
      properties: ["id", "role"],
    },
  );
  const list = asArray(args["list"], "Mailbox/get.list");
  for (const entry of list) {
    const mailbox = asRecord(entry, "Mailbox/get.list[]");
    if (mailbox["role"] === "inbox") {
      return asString(mailbox["id"], "Mailbox/get.list[].id");
    }
  }
  throw new ExternalMailTransportError("JMAP account has no inbox mailbox");
}

async function queryInboxEmailIds(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  inboxId: string,
  max: number,
): Promise<{ readonly ids: readonly string[]; readonly hasMore: boolean }> {
  const args = await callSingle(
    fetchImpl,
    session,
    credentials,
    "Email/query",
    {
      accountId: session.accountId,
      filter: { inMailbox: inboxId },
      sort: [{ property: "receivedAt", isAscending: true }],
      position: 0,
      limit: max,
      calculateTotal: true,
    },
  );
  const ids = asArray(args["ids"], "Email/query.ids").map((id, index) =>
    asString(id, `Email/query.ids[${index}]`),
  );
  const total = args["total"];
  const hasMore =
    typeof total === "number" ? ids.length < total : ids.length >= max;
  return { ids, hasMore };
}

function expandDownloadUrl(
  template: string,
  session: JmapSession,
  blobId: string,
): string {
  return template
    .replace("{accountId}", encodeURIComponent(session.accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{type}", encodeURIComponent(RAW_BLOB_TYPE))
    .replace("{name}", encodeURIComponent(RAW_BLOB_NAME));
}

async function downloadBlob(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  blobId: string,
): Promise<Uint8Array> {
  const url = expandDownloadUrl(session.downloadUrl, session, blobId);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: basicAuth(credentials) },
    });
  } catch (error) {
    throw new ExternalMailTransportError(
      `JMAP blob download from ${url} failed`,
      error,
    );
  }
  if (response.status === 401) {
    throw new ExternalMailAuthError(
      "JMAP server rejected the credentials (401)",
    );
  }
  if (!response.ok) {
    throw new ExternalMailTransportError(
      `JMAP blob download returned ${response.status}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchRawMessages(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  ids: readonly string[],
): Promise<readonly JmapFetchedMessage[]> {
  if (ids.length === 0) {
    return [];
  }
  const args = await callSingle(fetchImpl, session, credentials, "Email/get", {
    accountId: session.accountId,
    ids,
    properties: ["id", "blobId"],
  });
  const list = asArray(args["list"], "Email/get.list");
  const messages: JmapFetchedMessage[] = [];
  for (const entry of list) {
    const email = asRecord(entry, "Email/get.list[]");
    const remoteId = asString(email["id"], "Email/get.list[].id");
    const blobId = asString(email["blobId"], "Email/get.list[].blobId");
    const raw = await downloadBlob(fetchImpl, session, credentials, blobId);
    messages.push({ remoteId, raw });
  }
  return messages;
}

export function createJmapClient(options: JmapClientOptions = {}): JmapClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async testConnection(credentials) {
      // Session GET only, and nothing past it -- no Email/query -- so a
      // misconfigured/unreachable account fails fast without a fetch.
      await fetchSession(fetchImpl, credentials);
    },

    async fetchSince(
      credentials,
      knownRemoteIds,
      max,
    ): Promise<JmapFetchResult> {
      const session = await fetchSession(fetchImpl, credentials);
      const inboxId = await findInboxId(fetchImpl, session, credentials);
      const { ids, hasMore } = await queryInboxEmailIds(
        fetchImpl,
        session,
        credentials,
        inboxId,
        max,
      );
      // Filtered out before Email/get + blob download, not fetched then
      // discarded: an id flying-mail has already ingested costs one query
      // result, never a second round trip.
      const newIds = ids.filter((id) => !knownRemoteIds.has(id));
      const messages = await fetchRawMessages(
        fetchImpl,
        session,
        credentials,
        newIds,
      );
      return { messages, hasMore };
    },
  };
}
