import type { BlobObject, BlobStore } from "../ports/blob-store";
import type { MailSender, OutboundMail } from "../ports/mail-sender";
import type {
  BuildMimeInput,
  MimeBuilder,
  MimeParser,
  ParsedMime,
} from "../ports/mime";
import type { Clock, RandomSource, TokenHasher } from "../ports/runtime-ports";
import type {
  SqlDatabase,
  SqlStatement,
  SqlValue,
} from "../ports/sql-database";

/** A clock frozen at `iso`, advanceable by tests that need to observe
 * expiry. */
export interface FixedClock extends Clock {
  set(iso: string): void;
  advanceSeconds(seconds: number): void;
}

export function fixedClock(iso = "2026-08-23T00:00:00.000Z"): FixedClock {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set(next: string) {
      current = new Date(next);
    },
    advanceSeconds(seconds: number) {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

/** Deterministic ids (`<prefix>-1`, `<prefix>-2`, ...) and token bytes, so
 * assertions can name exact values instead of matching shapes. */
export function sequenceRandom(prefix = "id"): RandomSource {
  let counter = 0;
  return {
    uuid(): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
    tokenBytes(length: number): Uint8Array {
      counter += 1;
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = (counter + index) % 256;
      }
      return bytes;
    },
  };
}

/** Reversible stand-in for SHA-256, so a test can assert which value was
 * hashed. Never use anything like this outside tests. */
export function plainTokenHasher(): TokenHasher {
  return {
    async hash(value: string): Promise<string> {
      return `hash(${value})`;
    },
  };
}

export interface MemoryBlobStore extends BlobStore {
  readonly keys: () => readonly string[];
  readonly raw: (key: string) => Uint8Array | undefined;
}

async function toBytes(body: Uint8Array | ReadableStream): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value as Uint8Array;
    chunks.push(chunk);
    total += chunk.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function memoryBlobStore(): MemoryBlobStore {
  const store = new Map<
    string,
    { bytes: Uint8Array; contentType: string | null }
  >();
  return {
    async put(key, body, opts) {
      store.set(key, {
        bytes: await toBytes(body),
        contentType: opts?.contentType ?? null,
      });
    },
    async get(key): Promise<BlobObject | null> {
      const entry = store.get(key);
      if (entry === undefined) {
        return null;
      }
      const bytes = entry.bytes;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: entry.contentType,
        size: bytes.length,
      };
    },
    async delete(key) {
      store.delete(key);
    },
    keys: () => [...store.keys()],
    raw: (key) => store.get(key)?.bytes,
  };
}

export interface RecordingMailSender extends MailSender {
  readonly sent: readonly OutboundMail[];
  failNext(error: Error): void;
}

export function recordingMailSender(): RecordingMailSender {
  const sent: OutboundMail[] = [];
  let pendingFailure: Error | null = null;
  return {
    sent,
    failNext(error: Error) {
      pendingFailure = error;
    },
    async send(mail: OutboundMail): Promise<void> {
      if (pendingFailure !== null) {
        const error = pendingFailure;
        pendingFailure = null;
        throw error;
      }
      sent.push(mail);
    },
  };
}

const EMPTY_PARSED_MIME: ParsedMime = {
  from: null,
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: null,
  messageId: null,
  inReplyTo: null,
  references: [],
  date: null,
  text: null,
  html: null,
  attachments: [],
  headers: new Map(),
};

export interface StubMimeParser extends MimeParser {
  setResult(result: Partial<ParsedMime>): void;
}

/** Returns a canned parse result, so ingest tests exercise the pipeline
 * rather than the parser (which has its own adapter-level tests). */
export function stubMimeParser(
  initial: Partial<ParsedMime> = {},
): StubMimeParser {
  let result: ParsedMime = { ...EMPTY_PARSED_MIME, ...initial };
  return {
    setResult(next: Partial<ParsedMime>) {
      result = { ...EMPTY_PARSED_MIME, ...next };
    },
    async parse(): Promise<ParsedMime> {
      return result;
    },
  };
}

/** Emits a recognizable, inspectable stand-in for an RFC 5322 source. */
export function stubMimeBuilder(): MimeBuilder {
  return {
    build(input: BuildMimeInput): string {
      const lines = [
        `From: ${input.from.address}`,
        `To: ${input.to.map((entry) => entry.address).join(", ")}`,
        `Subject: ${input.subject}`,
        `Message-ID: <${input.messageId}>`,
        `Date: ${input.date}`,
      ];
      if (input.inReplyTo !== undefined) {
        lines.push(`In-Reply-To: <${input.inReplyTo}>`);
      }
      lines.push("", input.text ?? input.html ?? "");
      return lines.join("\r\n");
    },
  };
}

/** A `SqlDatabase` that records calls and returns nothing. Use cases never
 * touch `db` directly -- they go through repositories -- so this exists only
 * to satisfy `AppDependencies`. */
export function unusedSqlDatabase(): SqlDatabase {
  const fail = (): never => {
    throw new Error(
      "The fake SqlDatabase was called: use cases must go through repositories",
    );
  };
  return {
    async query<T>(
      _sql: string,
      _params?: readonly SqlValue[],
    ): Promise<readonly T[]> {
      return fail();
    },
    async execute(): Promise<{ rowsAffected: number }> {
      return fail();
    },
    async batch(_statements: readonly SqlStatement[]): Promise<void> {
      return fail();
    },
  };
}

import type { DnsResolver } from "../ports/dns-resolver";

export interface FakeDnsResolver extends DnsResolver {
  /** Sets the TXT values returned for a name. */
  setTxt(name: string, values: readonly string[]): void;
  failNextLookup(error: Error): void;
}

/** By default answers every `_mailcal.<domain>` lookup with whatever the
 * caller staged; unknown names resolve to no records. */
export function fakeDnsResolver(): FakeDnsResolver {
  const records = new Map<string, readonly string[]>();
  let pendingFailure: Error | null = null;
  return {
    setTxt(name, values) {
      records.set(name.toLowerCase(), values);
    },
    failNextLookup(error) {
      pendingFailure = error;
    },
    async lookupTxt(name) {
      if (pendingFailure !== null) {
        const error = pendingFailure;
        pendingFailure = null;
        throw error;
      }
      return records.get(name.toLowerCase()) ?? [];
    },
  };
}
