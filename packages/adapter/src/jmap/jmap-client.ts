import {
  ExternalMailAuthError,
  ExternalMailTransportError,
  type JmapClient,
  type JmapCredentials,
  type JmapFetchedMessage,
  type JmapFetchResult,
} from "@flying-mail/application/ports/external-mail";
import { MAX_FETCHED_RAW_BYTES } from "../mail/fetch-limits";

/** RFC 8620/8621 JMAP client using an injectable `fetchImpl` for
 * canned-fixture tests with no real network. Flow: GET the session resource
 * -> `Mailbox/get` for the inbox
 * (`role: "inbox"`) -> `Email/query` sorted by `receivedAt` ascending,
 * paged until `max` ids not already in `knownRemoteIds` are found (or the
 * inbox, or the per-call page budget, runs out) -> `Email/get` + raw blob
 * download for those ids. `state`/`queryState` are read but not persisted
 * -- the design doc's "re-query is idempotent" simplification -- so there
 * is no `Email/queryChanges` here.
 *
 * The session document is server-supplied, so its URLs are validated before
 * use, redirects are never followed, and every blob download is size
 * capped. */

const JMAP_MAIL_ACCOUNT_URN = "urn:ietf:params:jmap:mail";
const JMAP_USING = ["urn:ietf:params:jmap:core", JMAP_MAIL_ACCOUNT_URN];
const RAW_BLOB_TYPE = "message/rfc822";
const RAW_BLOB_NAME = "raw.eml";

/** Page size for `Email/query`. Id lists are cheap, so pages are larger than
 * a typical `max`: that is what lets one call get past a long run of
 * already-ingested messages. */
const QUERY_PAGE_SIZE = 200;
/** Upper bound on `Email/query` round trips per `fetchSince` call. */
const MAX_QUERY_PAGES = 20;
/** How far before the end of the known prefix paging starts. */
const KNOWN_PREFIX_OVERLAP = 200;

/** Hosts that may serve blob downloads for a session on a different host.
 * Fastmail's session lives on `api.fastmail.com` but its `downloadUrl`
 * points at `fastmailusercontent.com`. Matches the host itself or any
 * subdomain. */
const DEFAULT_TRUSTED_DOWNLOAD_HOST_SUFFIXES: readonly string[] = [
  "fastmailusercontent.com",
];

export interface JmapClientOptions {
  readonly fetchImpl?: typeof fetch;
  /** Largest raw message, in bytes, that will be downloaded. Larger ones
   * are reported in `skipped` instead of failing the run. */
  readonly maxMessageBytes?: number;
  /** Extra host suffixes (beyond the session host and Fastmail's download
   * host) a session may point `downloadUrl` at. */
  readonly trustedDownloadHostSuffixes?: readonly string[];
}

/** A message `fetchSince` deliberately did not download. The caller should
 * record it in its ledger so it is not retried on every run. */
export interface JmapSkippedMessage {
  readonly remoteId: string;
  readonly reason: "TOO_LARGE";
  /** Declared or observed size in bytes, when known. */
  readonly size: number | null;
}

export interface JmapFetchResultWithSkips extends JmapFetchResult {
  readonly skipped: readonly JmapSkippedMessage[];
}

/** {@link JmapClient} whose `fetchSince` also reports skipped messages. */
export interface JmapClientWithSkips extends JmapClient {
  fetchSince(
    credentials: JmapCredentials,
    knownRemoteIds: ReadonlySet<string>,
    max: number,
  ): Promise<JmapFetchResultWithSkips>;
}

/** Raised by {@link downloadBlob} when a blob exceeds the byte cap. Internal:
 * `fetchRawMessages` turns it into a skip. */
class BlobTooLargeError extends Error {
  constructor(readonly size: number | null) {
    super("JMAP blob exceeds the maximum message size");
    this.name = "BlobTooLargeError";
  }
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

function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  );
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
): Promise<unknown> {
  let response: Response;
  try {
    // Never follow redirects: the credentials ride on this request, and the
    // endpoint URLs were validated, so a redirect elsewhere is an error.
    response = await fetchImpl(url, { ...init, redirect: "manual" });
  } catch (error) {
    throw new ExternalMailTransportError(
      `${context} request to ${url} failed`,
      error,
    );
  }
  if (isRedirect(response)) {
    throw new ExternalMailTransportError(
      `${context} request to ${url} was redirected, which is not followed`,
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

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

function parseEndpointUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ExternalMailTransportError(
      `JMAP ${name} is not a valid absolute URL`,
      error,
    );
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!secure) {
    throw new ExternalMailTransportError(
      `JMAP ${name} must use https (http is only allowed for loopback hosts)`,
    );
  }
  return url;
}

function matchesHostSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** Validates a URL taken from the (server-controlled) session document: it
 * must be https and point back at the session host. `downloadUrl` may also
 * name a trusted download host, since some providers serve blobs from a
 * separate domain. */
function validateSessionEndpoint(
  raw: string,
  name: "apiUrl" | "downloadUrl",
  sessionUrl: URL,
  trustedDownloadHostSuffixes: readonly string[],
): string {
  const url = parseEndpointUrl(raw, `session.${name}`);
  const sameHost = url.host === sessionUrl.host;
  const trusted =
    name === "downloadUrl" &&
    url.protocol === "https:" &&
    trustedDownloadHostSuffixes.some((suffix) =>
      matchesHostSuffix(url.hostname, suffix),
    );
  if (!sameHost && !trusted) {
    throw new ExternalMailTransportError(
      `JMAP session.${name} points at a different host than the session URL`,
    );
  }
  return raw;
}

async function fetchSession(
  fetchImpl: typeof fetch,
  credentials: JmapCredentials,
  trustedDownloadHostSuffixes: readonly string[],
): Promise<JmapSession> {
  // Checked before the request: the credentials go out with it.
  const sessionUrl = parseEndpointUrl(credentials.sessionUrl, "session URL");
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
    apiUrl: validateSessionEndpoint(
      asString(record["apiUrl"], "session.apiUrl"),
      "apiUrl",
      sessionUrl,
      trustedDownloadHostSuffixes,
    ),
    downloadUrl: validateSessionEndpoint(
      asString(record["downloadUrl"], "session.downloadUrl"),
      "downloadUrl",
      sessionUrl,
      trustedDownloadHostSuffixes,
    ),
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

interface QueryPage {
  readonly ids: readonly string[];
  /** `null` when the server did not report a total. */
  readonly total: number | null;
}

async function queryInboxEmailPage(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  inboxId: string,
  position: number,
  limit: number,
): Promise<QueryPage> {
  const args = await callSingle(
    fetchImpl,
    session,
    credentials,
    "Email/query",
    {
      accountId: session.accountId,
      filter: { inMailbox: inboxId },
      sort: [{ property: "receivedAt", isAscending: true }],
      position,
      limit,
      calculateTotal: true,
    },
  );
  const ids = asArray(args["ids"], "Email/query.ids").map((id, index) =>
    asString(id, `Email/query.ids[${index}]`),
  );
  const total = args["total"];
  return { ids, total: typeof total === "number" ? total : null };
}

/** Pages through the inbox oldest-first, collecting ids not in `known`.
 *
 * Every id the caller processes (fetched or skipped) is ledgered, and the
 * query is oldest-first, so the known ids form a prefix of the sorted list.
 * Paging therefore starts near the end of that prefix --
 * `known.size - KNOWN_PREFIX_OVERLAP` -- rather than at 0, which is what
 * lets a mailbox with thousands of already-ingested messages reach a new one
 * in a single call. The overlap absorbs small reorderings and deletions.
 *
 * The prefix assumption can be wrong (known ids that were deleted remotely
 * shift the real boundary earlier). So the first page is checked: if its
 * first id is not known, the start has overshot, and the position steps back
 * a page at a time, collecting nothing, until it lands on a known id.
 *
 * The page budget bounds the cost; `hasMore` is true whenever unknown ids
 * may remain unfetched. */
async function collectUnknownIds(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  inboxId: string,
  known: ReadonlySet<string>,
  max: number,
): Promise<{ readonly ids: readonly string[]; readonly hasMore: boolean }> {
  if (max < 1) {
    return { ids: [], hasMore: false };
  }
  const pageSize = Math.max(max, QUERY_PAGE_SIZE);
  const collected: string[] = [];
  const seen = new Set<string>();
  let position = Math.max(0, known.size - KNOWN_PREFIX_OVERLAP);
  let anchored = position === 0;
  let exhausted = false;
  let overflow = false;

  for (let page = 0; page < MAX_QUERY_PAGES && !exhausted; page += 1) {
    const result = await queryInboxEmailPage(
      fetchImpl,
      session,
      credentials,
      inboxId,
      position,
      pageSize,
    );
    if (!anchored) {
      const first = result.ids[0];
      if (first === undefined || !known.has(first)) {
        position = Math.max(0, position - pageSize);
        anchored = position === 0;
        continue;
      }
      anchored = true;
    }
    for (const id of result.ids) {
      if (known.has(id) || seen.has(id)) {
        continue;
      }
      seen.add(id);
      if (collected.length < max) {
        collected.push(id);
      } else {
        overflow = true;
      }
    }
    // Advance by what the server actually returned: it may clamp `limit`.
    position += result.ids.length;
    exhausted =
      result.ids.length === 0 ||
      (result.total !== null
        ? position >= result.total
        : result.ids.length < pageSize);
    if (collected.length >= max) {
      break;
    }
  }
  return { ids: collected, hasMore: overflow || !exhausted };
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

/** Reads a response body, aborting once `maxBytes` is exceeded. Checks
 * `Content-Length` first so an honest oversized response is refused without
 * reading it; the running total covers a missing or lying header. */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BlobTooLargeError(declared);
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BlobTooLargeError(total);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BlobTooLargeError) {
      throw error;
    }
    throw new ExternalMailTransportError(
      "JMAP blob download was interrupted",
      error,
    );
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function downloadBlob(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  blobId: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const url = expandDownloadUrl(session.downloadUrl, session, blobId);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: basicAuth(credentials) },
      redirect: "manual",
    });
  } catch (error) {
    throw new ExternalMailTransportError(
      `JMAP blob download from ${url} failed`,
      error,
    );
  }
  if (isRedirect(response)) {
    throw new ExternalMailTransportError(
      "JMAP blob download was redirected, which is not followed",
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
  return readBodyCapped(response, maxBytes);
}

async function fetchRawMessages(
  fetchImpl: typeof fetch,
  session: JmapSession,
  credentials: JmapCredentials,
  ids: readonly string[],
  maxBytes: number,
): Promise<{
  readonly messages: readonly JmapFetchedMessage[];
  readonly skipped: readonly JmapSkippedMessage[];
}> {
  if (ids.length === 0) {
    return { messages: [], skipped: [] };
  }
  const args = await callSingle(fetchImpl, session, credentials, "Email/get", {
    accountId: session.accountId,
    ids,
    properties: ["id", "blobId", "size"],
  });
  const list = asArray(args["list"], "Email/get.list");
  const messages: JmapFetchedMessage[] = [];
  const skipped: JmapSkippedMessage[] = [];
  for (const entry of list) {
    const email = asRecord(entry, "Email/get.list[]");
    const remoteId = asString(email["id"], "Email/get.list[].id");
    const blobId = asString(email["blobId"], "Email/get.list[].blobId");
    const size = email["size"];
    // Skipped before the download. A message over the cap would only be
    // refused by ingest after being buffered in full.
    if (typeof size === "number" && size > maxBytes) {
      skipped.push({ remoteId, reason: "TOO_LARGE", size });
      continue;
    }
    try {
      const raw = await downloadBlob(
        fetchImpl,
        session,
        credentials,
        blobId,
        maxBytes,
      );
      messages.push({ remoteId, raw });
    } catch (error) {
      // The declared size was missing or wrong; the cap still holds.
      if (!(error instanceof BlobTooLargeError)) {
        throw error;
      }
      skipped.push({ remoteId, reason: "TOO_LARGE", size: error.size });
    }
  }
  return { messages, skipped };
}

export function createJmapClient(
  options: JmapClientOptions = {},
): JmapClientWithSkips {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxBytes = options.maxMessageBytes ?? MAX_FETCHED_RAW_BYTES;
  const trustedSuffixes = [
    ...DEFAULT_TRUSTED_DOWNLOAD_HOST_SUFFIXES,
    ...(options.trustedDownloadHostSuffixes ?? []),
  ];

  return {
    async testConnection(credentials) {
      // Session GET only, and nothing past it -- no Email/query -- so a
      // misconfigured/unreachable account fails fast without a fetch.
      await fetchSession(fetchImpl, credentials, trustedSuffixes);
    },

    async fetchSince(
      credentials,
      knownRemoteIds,
      max,
    ): Promise<JmapFetchResultWithSkips> {
      const session = await fetchSession(
        fetchImpl,
        credentials,
        trustedSuffixes,
      );
      const inboxId = await findInboxId(fetchImpl, session, credentials);
      // Known ids are filtered out while paging, before Email/get + blob
      // download: an id flying-mail has already ingested costs one query
      // result, never a second round trip.
      const { ids, hasMore } = await collectUnknownIds(
        fetchImpl,
        session,
        credentials,
        inboxId,
        knownRemoteIds,
        max,
      );
      const { messages, skipped } = await fetchRawMessages(
        fetchImpl,
        session,
        credentials,
        ids,
        maxBytes,
      );
      return { messages, hasMore, skipped };
    },
  };
}
