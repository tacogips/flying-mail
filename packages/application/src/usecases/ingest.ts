import {
  buildAttachmentBlobKey,
  buildRawMessageBlobKey,
  createAttachment,
} from "@flying-mail/domain/entities/attachment";
import { isMailAddressActive } from "@flying-mail/domain/entities/mail-address";
import {
  canReceiveMail,
  type MailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  type Message,
  type MessageRecipient,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
  parseEmailAddress,
} from "@flying-mail/domain/value-objects/email-address";
import { parseDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  type DomainId,
  createAttachmentId,
  createMessageId,
  createThreadId,
  type MessageId,
  type TagId,
  type ThreadId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { DuplicateMessageError } from "../ports/message-repository";
import type {
  ParsedMime,
  ParsedMimeAddress,
  ParsedMimeAttachment,
} from "../ports/mime";
import type { SqlStatement } from "../ports/sql-database";
import {
  RuleAction,
  type RuleMatchInput,
  ruleMatches,
} from "@flying-mail/domain/entities/classification-rule";
import {
  createSpamMark,
  SpamMarkedBy,
} from "@flying-mail/domain/entities/spam-mark";
import { isSpam, scoreSpam } from "./spam";

/** Caps from `design-docs/specs/design-mail-pipeline.md#limits-summary`.
 * Every one is enforced here rather than only at the transport, so the
 * limits hold for the local dev ingest route and tests too. */
export const MAX_INBOUND_RAW_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 32;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_STORED_BODY_LENGTH = 256 * 1024;

/** Reasons handed to `message.setReject()`. Deliberately uniform for
 * "unknown domain" and "disabled domain": a sender must not be able to probe
 * which domains this deployment manages. */
const REJECT_UNKNOWN_RECIPIENT = "Recipient address is not served here";
const REJECT_DISABLED_RECIPIENT = "Recipient address is not accepting mail";
const REJECT_MALFORMED_RECIPIENT = "Recipient address is malformed";
const REJECT_TOO_LARGE = "Message exceeds the maximum accepted size";

const TRACE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "received",
  "x-received",
  "return-path",
  "delivered-to",
  "x-original-to",
  "received-spf",
  "authentication-results",
  "arc-seal",
  "arc-message-signature",
  "arc-authentication-results",
]);

export interface ReceiveMessageInput {
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly raw: ReadableStream | Uint8Array;
  readonly rawSize: number;
  readonly headers: ReadonlyMap<string, string>;
  /** Overrides the self-generated id for a `STORED` message. Lets a caller
   * that must build a `SqlStatement` referencing the message *before*
   * calling `receiveMessage` -- external-mail fetch orchestration's dedupe
   * ledger row, via `extraStatements` below -- name the exact id this call
   * will assign. Omitted by every other caller, which keeps today's
   * self-generated id. */
  readonly messageId?: MessageId;
  /** Threaded unchanged into `insertWithRelations`'s own `extraStatements`,
   * so it rides the same `db.batch()` call as the message insert. Only
   * applied on a `STORED` result: a `DUPLICATE` never calls
   * `insertWithRelations` at all, so there is no batch for these to join.
   * Empty by default; no behavior change for a caller that omits it. */
  readonly extraStatements?: readonly SqlStatement[];
}

export type ReceiveMessageResult =
  | { readonly kind: "STORED"; readonly message: Message }
  | { readonly kind: "DUPLICATE"; readonly message: Message }
  | { readonly kind: "REJECTED"; readonly reason: string };

interface ResolvedRecipient {
  readonly address: EmailAddress;
  readonly domain: MailDomain;
}

/** Resolves the envelope recipient to a managed, receiving domain, or
 * explains why the message must be rejected at SMTP time. Rejecting is
 * strictly better than black-holing: the sender learns immediately, and a
 * catch-all deployment does not silently become a spam sink. */
async function resolveRecipient(
  deps: AppDependencies,
  envelopeTo: string,
): Promise<ResolvedRecipient | { readonly reason: string }> {
  const address = parseEmailAddress(envelopeTo);
  if (address === null) {
    return { reason: REJECT_MALFORMED_RECIPIENT };
  }
  const domainName = parseDomainName(
    address.slice(address.lastIndexOf("@") + 1),
  );
  if (domainName === null) {
    return { reason: REJECT_MALFORMED_RECIPIENT };
  }
  const domain = await deps.mailDomainRepository.findByName(domainName);
  if (domain === null || !canReceiveMail(domain)) {
    return { reason: REJECT_UNKNOWN_RECIPIENT };
  }

  // An explicitly provisioned mailbox is the operator's stated intent, so
  // it decides on its own -- in both directions. A DISABLED address is
  // refused even on a catch-all domain, which is the only way to close one
  // mailbox without closing the domain, and it is reported distinctly from
  // "never existed" because the sender's mistake is a different one.
  const provisioned = await deps.mailAddressRepository.findByAddress(address);
  if (provisioned !== null) {
    return isMailAddressActive(provisioned)
      ? { address, domain }
      : { reason: REJECT_DISABLED_RECIPIENT };
  }

  if (!domain.catchAll) {
    // No explicit row: fall back to the historical heuristic, so a domain
    // that predates mailbox provisioning keeps delivering exactly as before.
    const known = await deps.mailDomainRepository.hasKnownLocalPart(
      domain.id,
      address,
    );
    if (!known) {
      return { reason: REJECT_UNKNOWN_RECIPIENT };
    }
  }
  return { address, domain };
}

function isRejection(
  value: ResolvedRecipient | { readonly reason: string },
): value is { readonly reason: string } {
  return "reason" in value;
}

/** Builds recipient rows from the parsed headers, skipping any address that
 * fails to parse: a malformed `Cc:` entry is routine in real mail and must
 * not cost us the message. */
function collectHeaderRecipients(
  parsed: ParsedMime,
  envelopeAddress: EmailAddress,
): readonly MessageRecipient[] {
  const recipients: MessageRecipient[] = [
    {
      kind: RecipientKind.Envelope,
      address: envelopeAddress,
      name: null,
      position: 0,
    },
  ];
  const groups: readonly (readonly [
    RecipientKind,
    readonly ParsedMimeAddress[],
  ])[] = [
    [RecipientKind.To, parsed.to],
    [RecipientKind.Cc, parsed.cc],
    [RecipientKind.Bcc, parsed.bcc],
  ];
  for (const [kind, entries] of groups) {
    let position = 0;
    for (const entry of entries) {
      const address = parseEmailAddress(entry.address);
      if (address === null) {
        continue;
      }
      recipients.push({ kind, address, name: entry.name, position });
      position += 1;
    }
  }
  return recipients;
}

interface TruncatedBodies {
  readonly text: string | null;
  readonly html: string | null;
  readonly truncated: boolean;
}

/** Caps the bodies stored in D1. The untouched original always remains
 * reachable through the raw `.eml` file link, so truncation loses nothing
 * -- it only keeps one oversized message from bloating every listing query. */
function truncateBodies(parsed: ParsedMime): TruncatedBodies {
  const text = parsed.text;
  const html = parsed.html;
  const textTooLong = text !== null && text.length > MAX_STORED_BODY_LENGTH;
  const htmlTooLong = html !== null && html.length > MAX_STORED_BODY_LENGTH;
  return {
    text: textTooLong ? text.slice(0, MAX_STORED_BODY_LENGTH) : text,
    html: htmlTooLong ? html.slice(0, MAX_STORED_BODY_LENGTH) : html,
    truncated: textTooLong || htmlTooLong,
  };
}

async function hasEnvelopeFor(
  deps: AppDependencies,
  messageId: MessageId,
  address: EmailAddress,
): Promise<boolean> {
  const recipients = await deps.messageRepository.listRecipients([messageId]);
  return (
    recipients
      .get(messageId)
      ?.some(
        (recipient) =>
          recipient.kind === RecipientKind.Envelope &&
          recipient.address === address,
      ) ?? false
  );
}

function traceHeaderEnd(bytes: Uint8Array): number {
  let offset = 0;
  while (offset < bytes.length) {
    const lineStart = offset;
    let lineEnd = lineStart;
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
      lineEnd += 1;
    }
    const contentEnd =
      lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d
        ? lineEnd - 1
        : lineEnd;
    if (contentEnd === lineStart) {
      return offset;
    }

    let colon = lineStart;
    while (colon < contentEnd && bytes[colon] !== 0x3a) {
      colon += 1;
    }
    if (colon === contentEnd) {
      return offset;
    }

    let nameStart = lineStart;
    let nameEnd = colon;
    while (
      nameStart < nameEnd &&
      (bytes[nameStart] === 0x20 || bytes[nameStart] === 0x09)
    ) {
      nameStart += 1;
    }
    while (
      nameEnd > nameStart &&
      (bytes[nameEnd - 1] === 0x20 || bytes[nameEnd - 1] === 0x09)
    ) {
      nameEnd -= 1;
    }
    let name = "";
    for (let index = nameStart; index < nameEnd; index += 1) {
      const byte = bytes[index];
      if (byte === undefined || byte > 0x7f) {
        return offset;
      }
      name += String.fromCharCode(byte);
    }
    name = name.toLowerCase();

    let fieldEnd = lineEnd < bytes.length ? lineEnd + 1 : lineEnd;
    while (
      fieldEnd < bytes.length &&
      (bytes[fieldEnd] === 0x20 || bytes[fieldEnd] === 0x09)
    ) {
      lineEnd = fieldEnd;
      while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
        lineEnd += 1;
      }
      fieldEnd = lineEnd < bytes.length ? lineEnd + 1 : lineEnd;
    }

    if (!TRACE_HEADER_NAMES.has(name)) {
      return offset;
    }
    offset = fieldEnd;
  }
  return offset;
}

async function hasSameRawMessage(
  deps: AppDependencies,
  existing: Message,
  candidate: Uint8Array,
): Promise<boolean> {
  const existingRaw = await deps.blobs.get(
    existing.rawKey ?? buildRawMessageBlobKey(existing.id),
  );
  if (existingRaw === null) {
    return false;
  }
  const existingBytes = new Uint8Array(
    await new Response(existingRaw.body).arrayBuffer(),
  );
  // Each recipient's copy can have different leading MTA trace fields.
  const existingContent = existingBytes.subarray(traceHeaderEnd(existingBytes));
  const candidateContent = candidate.subarray(traceHeaderEnd(candidate));
  if (existingContent.length !== candidateContent.length) {
    return false;
  }
  return existingContent.every(
    (byte, index) => byte === candidateContent[index],
  );
}

/** Applies the attachment caps, keeping the first N that fit rather than
 * failing the whole message: a mail with 40 attachments is unusual but not
 * hostile, and losing it entirely would be worse than losing its tail. */
export function limitAttachments(
  attachments: readonly ParsedMimeAttachment[],
): readonly ParsedMimeAttachment[] {
  const kept: ParsedMimeAttachment[] = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (kept.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      break;
    }
    if (totalBytes + attachment.content.length > MAX_TOTAL_ATTACHMENT_BYTES) {
      break;
    }
    kept.push(attachment);
    totalBytes += attachment.content.length;
  }
  return kept;
}

/** Threading, in the order RFC 5322 clients expect: an exact `In-Reply-To`
 * match first, then the most recent `References` entry we know, then a new
 * thread rooted at this message's own id. */
async function resolveThreadId(
  deps: AppDependencies,
  parsed: ParsedMime,
  ownId: string,
): Promise<ThreadId> {
  if (parsed.messageId !== null) {
    const sameMessage = await deps.messageRepository.findByRfcMessageId(
      parsed.messageId,
    );
    if (sameMessage !== null) {
      return sameMessage.threadId;
    }
  }
  if (parsed.inReplyTo !== null) {
    const parent = await deps.messageRepository.findByRfcMessageId(
      parsed.inReplyTo,
    );
    if (parent !== null) {
      return parent.threadId;
    }
  }
  if (parsed.references.length > 0) {
    const existing = await deps.messageRepository.findThreadIdByReferences(
      parsed.references,
    );
    if (existing !== null) {
      return existing;
    }
  }
  return createThreadId(ownId);
}

function normalizeMessageId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  const normalized =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return normalized.length === 0 ? null : normalized;
}

async function deleteBlobsBestEffort(
  deps: AppDependencies,
  keys: readonly string[],
): Promise<void> {
  await Promise.allSettled(keys.map((key) => deps.blobs.delete(key)));
}

function headerFromAddress(
  parsed: ParsedMime,
  fallback: EmailAddress,
): { readonly address: EmailAddress; readonly name: string | null } {
  if (parsed.from === null) {
    return { address: fallback, name: null };
  }
  const parsedAddress = parseEmailAddress(parsed.from.address);
  return {
    address: parsedAddress ?? fallback,
    name: parsed.from.name,
  };
}

/** RFC 2919 `List-Id`: prefer the angle-bracket identifier ("Dev
 * <dev.example.com>" -> "dev.example.com"), fall back to the whole value. */
function extractListId(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /<([^>]+)>/.exec(header);
  const value = (match?.[1] ?? header).trim();
  return value.length === 0 ? null : value;
}

interface ListSignals {
  readonly listId: string | null;
  readonly isMailingList: boolean;
}

/** Mailing-list detection from the standard list headers (RFC 2369/2919)
 * plus the conventional `Precedence: list|bulk`. Detected once at receive
 * time and stored as message fields -- an intrinsic property, not a tag. */
function detectListSignals(
  headers: ReadonlyMap<string, string>,
  parsedHeaders: { get(name: string): string | null | undefined },
): ListSignals {
  const header = (name: string): string | null =>
    headers.get(name) ?? parsedHeaders.get(name) ?? null;
  const listId = extractListId(header("list-id"));
  const precedence = header("precedence")?.trim().toLowerCase() ?? "";
  const isMailingList =
    listId !== null ||
    header("list-unsubscribe") !== null ||
    header("list-post") !== null ||
    precedence === "list" ||
    precedence === "bulk";
  return { listId, isMailingList };
}

interface RuleOutcome {
  readonly spamByRule: boolean;
  readonly mailingListByRule: boolean;
  readonly tagIds: readonly TagId[];
}

/** Evaluates the operator's classification rules for the receiving domain.
 * A broken rule never throws (see `ruleMatches`): ingest must not lose
 * mail to a bad pattern. */
async function evaluateRules(
  deps: AppDependencies,
  domainId: DomainId,
  input: RuleMatchInput,
): Promise<RuleOutcome> {
  const rules =
    await deps.classificationRuleRepository.listEnabledForDomain(domainId);
  let spamByRule = false;
  let mailingListByRule = false;
  const tagIds: TagId[] = [];
  for (const rule of rules) {
    if (!ruleMatches(rule, input)) {
      continue;
    }
    switch (rule.action) {
      case RuleAction.Spam:
        spamByRule = true;
        break;
      case RuleAction.MailingList:
        mailingListByRule = true;
        break;
      case RuleAction.Tag:
        if (rule.tagId !== null && !tagIds.includes(rule.tagId)) {
          tagIds.push(rule.tagId);
        }
        break;
    }
  }
  return { spamByRule, mailingListByRule, tagIds };
}

/** Inbound pipeline. See
 * `design-docs/specs/design-mail-pipeline.md#inbound` for the step list.
 *
 * The raw source is stored in the object store *before* parsing, so a parse
 * failure still leaves the original message recoverable rather than
 * discarded. Duplicate delivery of the same `Message-ID` returns the
 * already-stored message instead of inserting a second copy. */
export function createReceiveMessageUseCase(
  deps: AppDependencies,
): (input: ReceiveMessageInput) => Promise<ReceiveMessageResult> {
  return async (input) => {
    if (input.rawSize > MAX_INBOUND_RAW_BYTES) {
      return { kind: "REJECTED", reason: REJECT_TOO_LARGE };
    }

    const resolved = await resolveRecipient(deps, input.envelopeTo);
    if (isRejection(resolved)) {
      return { kind: "REJECTED", reason: resolved.reason };
    }

    const envelopeFrom = parseEmailAddress(input.envelopeFrom);
    if (envelopeFrom === null) {
      // A malformed envelope sender means we could never reply or attribute
      // the message; rejecting is more honest than storing an orphan.
      return { kind: "REJECTED", reason: "Sender address is malformed" };
    }

    const now = deps.clock.now().toISOString();
    const messageId = input.messageId ?? createMessageId(deps.random.uuid());
    const rawKey = buildRawMessageBlobKey(messageId);

    const headerMessageId = normalizeMessageId(input.headers.get("message-id"));
    if (headerMessageId !== null) {
      const existing = await deps.messageRepository.findInboundByRfcMessageId(
        headerMessageId,
        resolved.domain.id,
      );
      if (existing !== null) {
        if (await hasEnvelopeFor(deps, existing.id, resolved.address)) {
          return { kind: "DUPLICATE", message: existing };
        }
      }
    }

    // Store first, then re-read for parsing. `input.raw` is typically a
    // `ReadableStream` that can only be consumed once, and storing before
    // parsing means a parse failure still leaves the original message
    // recoverable rather than discarded.
    await deps.blobs.put(rawKey, input.raw, { contentType: "message/rfc822" });
    const stored = await deps.blobs.get(rawKey);
    if (stored === null) {
      // The object store accepted the write and then could not return it.
      // Throwing (rather than parsing an empty body into a blank message)
      // lets the caller leave the message unacknowledged so the sending MTA
      // retries.
      throw new Error(`Stored raw message ${rawKey} could not be read back`);
    }
    const rawBytes = new Uint8Array(
      await new Response(stored.body).arrayBuffer(),
    );
    const parsed = await deps.mimeParser.parse(rawBytes);
    const from = headerFromAddress(parsed, envelopeFrom);
    const bodies = truncateBodies(parsed);

    if (parsed.messageId !== null) {
      const existing = await deps.messageRepository.findInboundByRfcMessageId(
        parsed.messageId,
        resolved.domain.id,
      );
      if (existing !== null) {
        if (await hasSameRawMessage(deps, existing, rawBytes)) {
          await deps.messageRepository.addEnvelopeRecipient(
            existing.id,
            resolved.address,
          );
        }
        await deleteBlobsBestEffort(deps, [rawKey]);
        return { kind: "DUPLICATE", message: existing };
      }
    }

    const threadId = await resolveThreadId(deps, parsed, messageId);

    const spam = scoreSpam({
      // The transport's headers win when present (on Workers, Email Routing
      // supplies the authoritative set), but fall back to the parsed
      // message's own headers so scoring still works for any caller that
      // hands over only the raw source -- the local dev ingest route, a
      // replay tool, a future transport.
      authenticationResults:
        input.headers.get("authentication-results") ??
        parsed.headers.get("authentication-results") ??
        null,
      envelopeFrom,
      headerFrom: from.address,
      subject: parsed.subject ?? "",
      bodyText: bodies.text,
      phrases: deps.instanceConfig.spamPhrases,
    });

    const listSignals = detectListSignals(input.headers, parsed.headers);
    const ruleOutcome = await evaluateRules(deps, resolved.domain.id, {
      senderAddress: from.address,
      subject: parsed.subject ?? "",
      listId: listSignals.listId,
    });

    const message = createInboundMessage({
      id: messageId,
      domainId: resolved.domain.id,
      threadId,
      rfcMessageId: parsed.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      replyTo:
        parsed.replyTo.length === 0
          ? null
          : parseEmailAddress(parsed.replyTo[0]?.address ?? ""),
      subject: parsed.subject ?? "",
      fromAddress: from.address,
      fromName: from.name,
      textBody: bodies.text,
      htmlBody: bodies.html,
      bodyTruncated: bodies.truncated,
      rawKey,
      rawSize: input.rawSize,
      occurredAt: parsed.date ?? now,
      createdAt: now,
      spamScore: spam.score,
      listId: listSignals.listId,
      isMailingList: listSignals.isMailingList || ruleOutcome.mailingListByRule,
    });

    const kept = limitAttachments(parsed.attachments);
    const attachments = await Promise.all(
      kept.map(async (attachment) => {
        const attachmentId = createAttachmentId(deps.random.uuid());
        const fileName = attachment.fileName ?? "attachment";
        const blobKey = buildAttachmentBlobKey(attachmentId, fileName);
        await deps.blobs.put(blobKey, attachment.content, {
          contentType: attachment.contentType,
        });
        return createAttachment({
          id: attachmentId,
          messageId,
          fileName,
          contentType: attachment.contentType,
          size: attachment.content.length,
          blobKey,
          contentId: attachment.contentId,
          inline: attachment.inline,
          createdAt: now,
        });
      }),
    );

    // A rule mark records the operator's explicit intent, so it wins over
    // the scorer for attribution; the score is kept either way.
    const spamMark = ruleOutcome.spamByRule
      ? createSpamMark({
          messageId,
          score: spam.score,
          markedBy: SpamMarkedBy.Rule,
          markedAt: now,
        })
      : isSpam(spam, deps.instanceConfig.spamThreshold)
        ? createSpamMark({
            messageId,
            score: spam.score,
            markedBy: SpamMarkedBy.System,
            markedAt: now,
          })
        : undefined;

    try {
      await deps.messageRepository.insertWithRelations({
        message,
        recipients: collectHeaderRecipients(parsed, resolved.address),
        attachments,
        tagIds: ruleOutcome.tagIds,
        taggedAt: now,
        ...(spamMark === undefined ? {} : { spam: spamMark }),
        ...(input.extraStatements === undefined
          ? {}
          : { extraStatements: input.extraStatements }),
      });
    } catch (error) {
      if (
        !(error instanceof DuplicateMessageError) ||
        parsed.messageId === null
      ) {
        throw error;
      }
      await deleteBlobsBestEffort(deps, [
        rawKey,
        ...attachments.map((attachment) => attachment.blobKey),
      ]);
      const existing = await deps.messageRepository.findInboundByRfcMessageId(
        parsed.messageId,
        resolved.domain.id,
      );
      if (existing === null) {
        throw error;
      }
      if (await hasSameRawMessage(deps, existing, rawBytes)) {
        await deps.messageRepository.addEnvelopeRecipient(
          existing.id,
          resolved.address,
        );
      }
      return { kind: "DUPLICATE", message: existing };
    }

    return { kind: "STORED", message };
  };
}

/** Exposed for the dev-only local ingest route, which accepts a raw `.eml`
 * body plus explicit envelope addresses. */
export function buildDevIngestInput(params: {
  readonly raw: Uint8Array;
  readonly from: string;
  readonly to: string;
  readonly headers?: ReadonlyMap<string, string>;
}): ReceiveMessageInput {
  return {
    envelopeFrom: createEmailAddress(params.from, "from"),
    envelopeTo: createEmailAddress(params.to, "to"),
    raw: params.raw,
    rawSize: params.raw.length,
    headers: params.headers ?? new Map(),
  };
}
