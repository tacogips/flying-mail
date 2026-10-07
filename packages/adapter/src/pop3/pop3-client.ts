import {
  ExternalMailAuthError,
  ExternalMailTransportError,
  type Pop3Client,
  type Pop3Credentials,
  type Pop3FetchedMessage,
  type TcpDialer,
  type TextSocket,
} from "@flying-mail/application/ports/external-mail";

/** RFC 1939 POP3 client. POP3 accepts implicit TLS on `995` only --
 * `validatePop3Endpoint` in the domain layer already rejects anything else,
 * so this client dials `tls: "implicit"` unconditionally rather than
 * re-validating the port itself. Never sends `DELE`: fetch always leaves
 * mail in place on the remote server, per the design doc's
 * aggregator-not-migrator stance. */

const POP3_TLS_MODE = "implicit" as const;
const LINE_ENDING = "\r\n";

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

/** Reads a multi-line POP3 response body (a `UIDL`/`LIST` listing or a
 * `RETR` payload) up to the lone `.` terminator, undoing byte-stuffing on
 * any line that starts with a leading `.` (RFC 1939 section 3). */
async function readMultiline(
  socket: TextSocket,
  context: string,
): Promise<readonly string[]> {
  const lines: string[] = [];
  for (;;) {
    const line = await readReplyLine(socket, context);
    if (line === ".") {
      return lines;
    }
    lines.push(line.startsWith(".") ? line.slice(1) : line);
  }
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
  const lines = await readMultiline(socket, "UIDL");
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

async function retrieve(
  socket: TextSocket,
  msgNum: string,
): Promise<Uint8Array | null> {
  await writeLine(socket, `RETR ${msgNum}`);
  const status = await readReplyLine(socket, `RETR ${msgNum}`);
  if (!isOk(status)) {
    // A message the server no longer has by the time RETR runs is a
    // per-message skip, not a hard failure for the whole batch.
    return null;
  }
  const lines = await readMultiline(socket, `RETR ${msgNum}`);
  return new TextEncoder().encode(lines.join(LINE_ENDING) + LINE_ENDING);
}

export function createPop3Client(dialer: TcpDialer): Pop3Client {
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
      return withSession(dialer, credentials, async (socket) => {
        const byUidl = await listUidlMap(socket);
        const results: Pop3FetchedMessage[] = [];
        for (const uidl of uidls) {
          const msgNum = byUidl.get(uidl);
          if (msgNum === undefined) {
            // Not currently in the mailbox -- the same "skip, do not fail
            // the batch" outcome as a server -ERR reply to RETR.
            continue;
          }
          const raw = await retrieve(socket, msgNum);
          if (raw !== null) {
            results.push({ remoteId: uidl, raw });
          }
        }
        return results;
      });
    },
  };
}
