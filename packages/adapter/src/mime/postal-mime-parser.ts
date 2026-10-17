import { normalizeAttachmentContentType } from "@flying-mail/domain/entities/attachment";
import type {
  MimeParser,
  ParsedMime,
  ParsedMimeAddress,
  ParsedMimeAttachment,
} from "@flying-mail/application/ports/mime";
import PostalMime, {
  type Address,
  type Attachment as PostalAttachment,
  type Email,
  type Mailbox,
} from "postal-mime";

/** Guards against a hostile message: mail is attacker-supplied input, and
 * postal-mime enforces both of these while parsing rather than after. */
const DEFAULT_MAX_NESTING_DEPTH = 32;
const DEFAULT_MAX_HEADERS_SIZE = 1024 * 1024;

/** RFC 5322 caps a header line at 998 characters; no real id gets near it. */
const MAX_MESSAGE_ID_LENGTH = 998;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_ID_CHARS = /[\s\x00-\x1f\x7f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_CHAR_RUNS = /[\x00-\x1f\x7f]+/g;

/** Replaces control characters (CR/LF included) in a parsed display string.
 *
 * postal-mime RFC 2047-decodes subjects and display names, so an encoded
 * word can decode to a CRLF. Nothing downstream should ever see one in a
 * single-line field, so each run becomes one space. */
function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHAR_RUNS, " ").trim();
}

/** Strips the angle brackets RFC 5322 wraps `Message-ID`, `In-Reply-To` and
 * `References` values in, so stored ids compare directly against each other
 * without every call site re-trimming.
 *
 * Returns `null` for an id carrying whitespace or control characters, or
 * longer than a header line may be. postal-mime RFC 2047-decodes these
 * headers, so a hostile `=?utf-8?B?...?=` can decode to an id containing
 * CRLF; ingest stores ids and replies copy them into outbound headers, so
 * such an id must never get in. */
export function normalizeMessageId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_MESSAGE_ID_LENGTH ||
    UNSAFE_ID_CHARS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** `References` (and a multi-id `In-Reply-To`) arrives as one string of
 * whitespace-separated, bracketed ids. Bracketed ids are extracted whole, so
 * a hostile id with whitespace inside its brackets is dropped as one entry
 * rather than split into plausible-looking fragments. */
export function splitReferences(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  const candidates = value.includes("<")
    ? [...value.matchAll(/<([^<>]*)>/g)].map((match) => match[1] ?? "")
    : value.split(/\s+/);
  return candidates
    .map((entry) => normalizeMessageId(entry))
    .filter((entry): entry is string => entry !== null);
}

function isMailbox(address: Address): address is Mailbox {
  return "address" in address && address.address !== undefined;
}

/** Flattens group syntax (`Team: a@x.com, b@x.com;`) down to its member
 * mailboxes. A group has no address of its own, so keeping it would produce
 * a recipient row with nothing to deliver to or authorize against. */
function toParsedAddress(address: string, name: string): ParsedMimeAddress {
  const cleanName = stripControlChars(name);
  return { address, name: cleanName.length === 0 ? null : cleanName };
}

function flattenAddresses(
  addresses: readonly Address[] | undefined,
): readonly ParsedMimeAddress[] {
  const flattened: ParsedMimeAddress[] = [];
  for (const address of addresses ?? []) {
    if (isMailbox(address)) {
      flattened.push(toParsedAddress(address.address, address.name));
      continue;
    }
    for (const member of address.group) {
      flattened.push(toParsedAddress(member.address, member.name));
    }
  }
  return flattened;
}

function firstAddress(address: Address | undefined): ParsedMimeAddress | null {
  const flattened = flattenAddresses(address === undefined ? [] : [address]);
  return flattened[0] ?? null;
}

function toBytes(content: PostalAttachment["content"]): Uint8Array {
  if (typeof content === "string") {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(content);
}

function toAttachment(attachment: PostalAttachment): ParsedMimeAttachment {
  const contentId = normalizeMessageId(attachment.contentId);
  return {
    fileName: attachment.filename,
    // Inbound types are arbitrary; a malformed one degrades rather than
    // making ingest throw.
    contentType: normalizeAttachmentContentType(attachment.mimeType),
    content: toBytes(attachment.content),
    contentId,
    // An attachment with a `Content-ID` is referenced by a `cid:` URL from
    // the HTML body even when the disposition header is missing or wrong,
    // so it is treated as inline either way.
    inline: attachment.disposition === "inline" || contentId !== null,
  };
}

function toHeaderMap(email: Email): ReadonlyMap<string, string> {
  const headers = new Map<string, string>();
  for (const header of email.headers) {
    const existing = headers.get(header.key);
    // Repeated headers (`Received`, `Authentication-Results`) are joined
    // rather than last-wins, so a spam check that scans the joined value
    // sees every instance.
    headers.set(
      header.key,
      existing === undefined ? header.value : `${existing}, ${header.value}`,
    );
  }
  return headers;
}

/** Maps postal-mime's `Email` onto the `MimeParser` port.
 *
 * postal-mime is used because it is dependency-free and written for exactly
 * this runtime (browsers and serverless), unlike `mailparser`, which needs
 * Node streams and does not run on Workers. Keeping it behind the port
 * means the application layer never imports it and this choice stays
 * replaceable. */
export function createPostalMimeParser(options?: {
  readonly maxNestingDepth?: number;
  readonly maxHeadersSize?: number;
}): MimeParser {
  const parseOptions = {
    maxNestingDepth: options?.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH,
    maxHeadersSize: options?.maxHeadersSize ?? DEFAULT_MAX_HEADERS_SIZE,
  };

  return {
    async parse(raw: ReadableStream | Uint8Array): Promise<ParsedMime> {
      const email = await PostalMime.parse(raw, parseOptions);
      return {
        from: firstAddress(email.from),
        to: flattenAddresses(email.to),
        cc: flattenAddresses(email.cc),
        bcc: flattenAddresses(email.bcc),
        replyTo: flattenAddresses(email.replyTo),
        subject:
          email.subject === undefined ? null : stripControlChars(email.subject),
        messageId: normalizeMessageId(email.messageId),
        // `In-Reply-To` may list several ids; the first is the direct parent.
        inReplyTo: splitReferences(email.inReplyTo)[0] ?? null,
        references: splitReferences(email.references),
        date: email.date ?? null,
        text: email.text ?? null,
        html: email.html ?? null,
        attachments: email.attachments.map(toAttachment),
        headers: toHeaderMap(email),
      };
    },
  };
}
