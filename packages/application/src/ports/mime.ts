/** One parsed mailbox. `address` is the raw string from the message and is
 * *not* yet validated -- the ingest use case parses it through
 * `parseEmailAddress` and skips entries that fail, so a malformed `Cc:`
 * does not cost us the whole message. */
export interface ParsedMimeAddress {
  readonly address: string;
  readonly name: string | null;
}

export interface ParsedMimeAttachment {
  readonly fileName: string | null;
  readonly contentType: string;
  readonly content: Uint8Array;
  /** RFC 2392 `Content-ID` without angle brackets, for `cid:` references. */
  readonly contentId: string | null;
  readonly inline: boolean;
}

/** The result of parsing an RFC 5322 source. `messageId`, `inReplyTo` and
 * each `references` entry have their angle brackets stripped, so they
 * compare directly against stored values. */
export interface ParsedMime {
  readonly from: ParsedMimeAddress | null;
  readonly to: readonly ParsedMimeAddress[];
  readonly cc: readonly ParsedMimeAddress[];
  readonly bcc: readonly ParsedMimeAddress[];
  readonly replyTo: readonly ParsedMimeAddress[];
  readonly subject: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly ParsedMimeAttachment[];
  /** Every header, keyed by its lower-cased name. Repeated headers are
   * joined with `", "`, matching how `Headers` itself behaves. */
  readonly headers: ReadonlyMap<string, string>;
}

/** Port over MIME parsing. Implemented by `postal-mime` in
 * `@mailcal/adapter`; kept behind this interface so the application layer
 * stays testable with canned parse results and the parser stays
 * replaceable. */
export interface MimeParser {
  parse(raw: ReadableStream | Uint8Array): Promise<ParsedMime>;
}

export interface BuildMimeAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly contentId: string | null;
  readonly inline: boolean;
}

export interface BuildMimeInput {
  readonly from: ParsedMimeAddress;
  readonly to: readonly ParsedMimeAddress[];
  readonly cc?: readonly ParsedMimeAddress[];
  readonly bcc?: readonly ParsedMimeAddress[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly date: string;
  /** Custom headers. The builder rejects any value containing CR or LF --
   * that is the header-injection guard, and it lives at the boundary rather
   * than only in the caller so it cannot be forgotten. */
  readonly headers?: ReadonlyMap<string, string>;
  readonly attachments?: readonly BuildMimeAttachment[];
}

/** Port over RFC 5322 message construction. Implemented by `mimetext` in
 * `@mailcal/adapter`. Used to produce the `.eml` source stored for outbound
 * messages; actual delivery prefers the provider's structured send form,
 * which avoids a whole class of header-injection bugs. */
export interface MimeBuilder {
  build(input: BuildMimeInput): string;
}
