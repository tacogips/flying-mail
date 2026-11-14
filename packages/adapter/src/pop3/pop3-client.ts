import {
  ExternalMailAuthError,
  ExternalMailTransportError,
  type Pop3Client,
  type Pop3Credentials,
  type Pop3FetchedMessage,
  type TcpDialer,
  type TextSocket,
} from "@flying-mail/application/ports/external-mail";
import { MAX_FETCHED_RAW_BYTES } from "../mail/fetch-limits";

/** RFC 1939 POP3 client. POP3 accepts implicit TLS on `995` only --
 * `validatePop3Endpoint` in the domain layer already rejects anything else,
 * so this client dials `tls: "implicit"` unconditionally rather than
 * re-validating the port itself. Never sends `DELE`: fetch always leaves
 * mail in place on the remote server, per the design doc's
 * aggregator-not-migrator stance. */

const POP3_TLS_MODE = "implicit" as const;
const LINE_ENDING = "\r\n";
/** A `UIDL`/`LIST` listing is ~20 bytes per message; this allows hundreds of
 * thousands while still refusing a server that never ends the listing. */
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
/** After a `RETR` passes the size cap its remaining lines are read and
 * discarded, so the session stays usable. This many times the cap is the
 * most that will be drained before the connection is given up on. */
const DRAIN_LIMIT_FACTOR = 4;

export interface Pop3ClientOptions {
  /** Largest message, in bytes, that will be buffered. Larger ones are
   * reported in `skipped`. */
  readonly maxMessageBytes?: number;
}

/** A message `fetchByUidlDetailed` deliberately did not download. The caller
 * should record it in its ledger so it is not retried on every run. */
export interface Pop3SkippedMessage {
  readonly remoteId: string;
  readonly reason: "TOO_LARGE";
  /** Size in bytes, as reported by `LIST` or counted while reading. */
  readonly size: number;
}

export interface Pop3FetchResultWithSkips {
  readonly messages: readonly Pop3FetchedMessage[];
  readonly skipped: readonly Pop3SkippedMessage[];
}

/** {@link Pop3Client} that can also report messages it skipped for size.
 * `fetchByUidl` keeps the base contract and simply omits them. */
export interface Pop3ClientWithSkips extends Pop3Client {
  fetchByUidlDetailed(
    credentials: Pop3Credentials,
    uidls: readonly string[],
  ): Promise<Pop3FetchResultWithSkips>;
}

async function writeLine(socket: TextSocket, line: string): Promise<void> {
  await socket.write(`${line}${LINE_ENDING}`);
}

async function readReplyLine(
  socket: TextSocket,
  context: string,
): Promise<string> {
  const line = await socket.readLine();
  if (line === null) {
    throw new ExternalMailTransportError(
      `POP3 connection closed while waiting for a reply to ${context}`,
    );
  }
  return line;
}

function isOk(line: string): boolean {
  return line.startsWith("+OK");
}

type MultilineResult =
  | { readonly kind: "ok"; readonly lines: readonly string[] }
  | { readonly kind: "too-large"; readonly bytes: number };

/** Reads a multi-line POP3 response body (a `UIDL`/`LIST` listing or a
 * `RETR` payload) up to the lone `.` terminator, undoing byte-stuffing on
 * any line that starts with a leading `.` (RFC 1939 section 3).
 *
 * Memory is bounded: once the body passes `maxBytes` the lines are no longer
 * kept, only counted and discarded up to `drainLimit`, so the terminator is
 * still consumed and the session remains in sync. Past `drainLimit` the
 * server is treated as broken and the read fails. */
async function readMultiline(
  socket: TextSocket,
  context: string,
  maxBytes: number,
  drainLimit: number,
): Promise<MultilineResult> {
  const lines: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (;;) {
    const line = await readReplyLine(socket, context);
    if (line === ".") {
      return bytes > maxBytes
        ? { kind: "too-large", bytes }
        : { kind: "ok", lines };
    }
    bytes += encoder.encode(line).byteLength + LINE_ENDING.length;
    if (bytes > drainLimit) {
      throw new ExternalMailTransportError(
        `POP3 response to ${context} exceeded ${drainLimit} bytes; giving up on the connection`,
      );
    }
    if (bytes <= maxBytes) {
      lines.push(line.startsWith(".") ? line.slice(1) : line);
    } else if (lines.length > 0) {
      // Over the cap: nothing read so far will be used, so free it now.
      lines.length = 0;
    }
  }
}

/** A listing that is not `ok` means the server never stopped talking. */
async function readListing(
  socket: TextSocket,
  context: string,
): Promise<readonly string[]> {
  const result = await readMultiline(
    socket,
    context,
    MAX_LISTING_BYTES,
    MAX_LISTING_BYTES,
  );
  if (result.kind !== "ok") {
    throw new ExternalMailTransportError(
      `POP3 ${context} listing exceeded ${MAX_LISTING_BYTES} bytes`,
    );
  }
  return result.lines;
}

async function authenticate(
  socket: TextSocket,
  credentials: Pop3Credentials,
): Promise<void> {
  const greeting = await readReplyLine(socket, "the greeting");
  if (!isOk(greeting)) {
    throw new ExternalMailTransportError(
      `POP3 server sent an unexpected greeting: ${greeting}`,
    );
  }
  await writeLine(socket, `USER ${credentials.username}`);
  const userReply = await readReplyLine(socket, "USER");
  if (!isOk(userReply)) {
    throw new ExternalMailAuthError("POP3 server rejected the username");
  }
  await writeLine(socket, `PASS ${credentials.password}`);
  const passReply = await readReplyLine(socket, "PASS");
  if (!isOk(passReply)) {
    throw new ExternalMailAuthError("POP3 server rejected the password");
  }
}

async function quit(socket: TextSocket): Promise<void> {
  try {
    await writeLine(socket, "QUIT");
    await socket.readLine();
  } finally {
    await socket.close();
  }
}

async function withSession<T>(
  dialer: TcpDialer,
  credentials: Pop3Credentials,
  run: (socket: TextSocket) => Promise<T>,
): Promise<T> {
  let socket: TextSocket;
  try {
    socket = await dialer.dial({
      host: credentials.host,
      port: credentials.port,
      tls: POP3_TLS_MODE,
    });
  } catch (error) {
    throw new ExternalMailTransportError(
      `POP3 failed to connect to ${credentials.host}:${credentials.port}`,
      error,
    );
  }
  try {
    await authenticate(socket, credentials);
    return await run(socket);
  } finally {
    await quit(socket);
  }
}

/** Message-number -> `UIDL`, from a bare `UIDL` (no argument) response.
 * `RETR` addresses messages by number, not by `UIDL`, so every fetch has to
 * go through this map first. */
async function listUidlMap(
  socket: TextSocket,
): Promise<ReadonlyMap<string, string>> {
  await writeLine(socket, "UIDL");
  const status = await readReplyLine(socket, "UIDL");
  if (!isOk(status)) {
    throw new ExternalMailTransportError(`POP3 UIDL command failed: ${status}`);
  }
  const lines = await readListing(socket, "UIDL");
  const byUidl = new Map<string, string>();
  for (const line of lines) {
    const spaceIndex = line.indexOf(" ");
    if (spaceIndex === -1) {
      continue;
    }
    byUidl.set(line.slice(spaceIndex + 1), line.slice(0, spaceIndex));
  }
  return byUidl;
}

/** Message-number -> size in octets, from a bare `LIST`. `null` when the
 * server refuses `LIST`; sizes are then simply unknown and the byte cap
 * applied while reading is the only guard. */
async function listSizes(
  socket: TextSocket,
): Promise<ReadonlyMap<string, number> | null> {
  await writeLine(socket, "LIST");
  const status = await readReplyLine(socket, "LIST");
  if (!isOk(status)) {
    return null;
  }
  const sizes = new Map<string, number>();
  for (const line of await readListing(socket, "LIST")) {
    const [msgNum, size] = line.trim().split(/\s+/);
    const parsed = Number(size);
    if (msgNum !== undefined && size !== undefined && Number.isFinite(parsed)) {
      sizes.set(msgNum, parsed);
    }
  }
  return sizes;
}

type RetrieveOutcome =
  | { readonly kind: "ok"; readonly raw: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "too-large"; readonly size: number };

async function retrieve(
  socket: TextSocket,
  msgNum: string,
  maxBytes: number,
): Promise<RetrieveOutcome> {
  await writeLine(socket, `RETR ${msgNum}`);
  const status = await readReplyLine(socket, `RETR ${msgNum}`);
  if (!isOk(status)) {
    // A message the server no longer has by the time RETR runs is a
    // per-message skip, not a hard failure for the whole batch.
    return { kind: "missing" };
  }
  const result = await readMultiline(
    socket,
    `RETR ${msgNum}`,
    maxBytes,
    maxBytes * DRAIN_LIMIT_FACTOR,
  );
  if (result.kind === "too-large") {
    return { kind: "too-large", size: result.bytes };
  }
  return {
    kind: "ok",
    raw: new TextEncoder().encode(result.lines.join(LINE_ENDING) + LINE_ENDING),
  };
}

export function createPop3Client(
  dialer: TcpDialer,
  options: Pop3ClientOptions = {},
): Pop3ClientWithSkips {
  const maxBytes = options.maxMessageBytes ?? MAX_FETCHED_RAW_BYTES;

  async function fetchByUidlDetailed(
    credentials: Pop3Credentials,
    uidls: readonly string[],
  ): Promise<Pop3FetchResultWithSkips> {
    return withSession(dialer, credentials, async (socket) => {
      const byUidl = await listUidlMap(socket);
      // Sizes are asked for once, up front, so an oversized message is
      // skipped without a single byte of it being transferred.
      const sizes = await listSizes(socket);
      const messages: Pop3FetchedMessage[] = [];
      const skipped: Pop3SkippedMessage[] = [];
      for (const uidl of uidls) {
        const msgNum = byUidl.get(uidl);
        if (msgNum === undefined) {
          // Not currently in the mailbox -- the same "skip, do not fail
          // the batch" outcome as a server -ERR reply to RETR.
          continue;
        }
        const listed = sizes?.get(msgNum);
        if (listed !== undefined && listed > maxBytes) {
          skipped.push({ remoteId: uidl, reason: "TOO_LARGE", size: listed });
          continue;
        }
        const outcome = await retrieve(socket, msgNum, maxBytes);
        if (outcome.kind === "ok") {
          messages.push({ remoteId: uidl, raw: outcome.raw });
        } else if (outcome.kind === "too-large") {
          skipped.push({
            remoteId: uidl,
            reason: "TOO_LARGE",
            size: outcome.size,
          });
        }
      }
      return { messages, skipped };
    });
  }

  return {
    async testConnection(credentials) {
      await withSession(dialer, credentials, async () => {});
    },

    async listUidls(credentials) {
      return withSession(dialer, credentials, async (socket) => {
        const byUidl = await listUidlMap(socket);
        return [...byUidl.keys()];
      });
    },

    async fetchByUidl(credentials, uidls) {
      return (await fetchByUidlDetailed(credentials, uidls)).messages;
    },

    fetchByUidlDetailed,
  };
}
