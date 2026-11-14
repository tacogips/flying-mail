import { Capability } from "@mailcal/domain/entities/api-key";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import {
  attachToMessage,
  buildRawMessageBlobKey,
} from "@mailcal/domain/entities/attachment";
import { isMailAddressActive } from "@mailcal/domain/entities/mail-address";
import { assertCanSendMail } from "@mailcal/domain/entities/mail-domain";
import {
  createOutboundMessage,
  DeliveryStatus,
  markMessageFailed,
  markMessageSent,
  type Message,
  type MessageRecipient,
  RecipientKind,
  requeueMessage,
} from "@mailcal/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
  emailDomainName,
} from "@mailcal/domain/value-objects/email-address";
import {
  type AttachmentId,
  type DomainId,
  createMessageId,
  createThreadId,
  type MessageId,
  type TagId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import {
  authorizesAnyAddress,
  requireAddressCapability,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type { BuildMimeAttachment } from "../ports/mime";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Provider limits, validated before the binding call so a caller gets a
 * `BAD_USER_INPUT` naming the offending field instead of an opaque
 * provider error. See `design-mail-pipeline.md#limits-summary`. */
export const MAX_RECIPIENTS_PER_MESSAGE = 50;
export const MAX_OUTBOUND_ATTACHMENTS = 32;
export const MAX_OUTBOUND_TOTAL_BYTES = 5 * 1024 * 1024;

/** Custom headers must be `X-`-prefixed and free of CR/LF. This is the
 * header-injection guard: without it, a newline in a caller-supplied value
 * would let an agent forge additional headers -- extra recipients, a
 * different `From` -- on a message it was authorized to send. */
const CUSTOM_HEADER_NAME = /^X-[A-Za-z0-9-]+$/;
const HEADER_VALUE_FORBIDDEN = /[\r\n]/;

export interface SendMessageHeaderInput {
  readonly name: string;
  readonly value: string;
}

export interface SendMessageInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly inReplyToMessageId?: MessageId;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly headers?: readonly SendMessageHeaderInput[];
  readonly tagIds?: readonly TagId[];
}

export interface ValidatedRecipients {
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
}

function parseAddressList(
  values: readonly string[] | undefined,
  field: string,
): readonly EmailAddress[] {
  return (values ?? []).map((value, index) =>
    createEmailAddress(value, `${field}[${index}]`),
  );
}

function validateRecipients(input: SendMessageInput): ValidatedRecipients {
  const to = parseAddressList(input.to, "to");
  const cc = parseAddressList(input.cc, "cc");
  const bcc = parseAddressList(input.bcc, "bcc");
  const total = to.length + cc.length + bcc.length;
  if (total === 0) {
    throw new BadUserInputError("At least one recipient is required", "to");
  }
  if (total > MAX_RECIPIENTS_PER_MESSAGE) {
    throw new BadUserInputError(
      `A message may not have more than ${MAX_RECIPIENTS_PER_MESSAGE} recipients`,
      "to",
    );
  }
  return { to, cc, bcc };
}

export function validateBodies(input: SendMessageInput): void {
  const hasText = input.text !== undefined && input.text.length > 0;
  const hasHtml = input.html !== undefined && input.html.length > 0;
  if (!hasText && !hasHtml) {
    throw new BadUserInputError(
      "A message must have a text or html body",
      "text",
    );
  }
}

/** Validates and normalizes custom headers. Exported so the same rules can
 * be unit-tested directly and reused by any future send surface. */
export function validateCustomHeaders(
  headers: readonly SendMessageHeaderInput[] | undefined,
): ReadonlyMap<string, string> {
  const validated = new Map<string, string>();
  for (const header of headers ?? []) {
    if (!CUSTOM_HEADER_NAME.test(header.name)) {
      throw new BadUserInputError(
        `Custom header "${header.name}" must match X-Name`,
        "headers",
      );
    }
    if (HEADER_VALUE_FORBIDDEN.test(header.value)) {
      throw new BadUserInputError(
        `Custom header "${header.name}" must not contain CR or LF`,
        "headers",
      );
    }
    validated.set(header.name, header.value);
  }
  return validated;
}

export async function loadOutboundAttachments(
  deps: AppDependencies,
  ids: readonly AttachmentId[] | undefined,
): Promise<readonly Attachment[]> {
  if (ids === undefined || ids.length === 0) {
    return [];
  }
  if (ids.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new BadUserInputError(
      `A message may not have more than ${MAX_OUTBOUND_ATTACHMENTS} attachments`,
      "attachmentIds",
    );
  }
  const loaded: Attachment[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const attachment = await deps.messageRepository.findAttachmentById(id);
    if (attachment === null) {
      throw new NotFoundError("Attachment", id);
    }
    totalBytes += attachment.size;
    loaded.push(attachment);
  }
  if (totalBytes > MAX_OUTBOUND_TOTAL_BYTES) {
    throw new BadUserInputError(
      `Attachments exceed the ${MAX_OUTBOUND_TOTAL_BYTES / (1024 * 1024)} MB total size limit`,
      "attachmentIds",
    );
  }
  return loaded;
}

export async function readAttachmentBytes(
  deps: AppDependencies,
  attachments: readonly Attachment[],
): Promise<readonly BuildMimeAttachment[]> {
  const built: BuildMimeAttachment[] = [];
  for (const attachment of attachments) {
    const blob = await deps.blobs.get(attachment.blobKey);
    if (blob === null) {
      throw new NotFoundError("Attachment body", attachment.id);
    }
    built.push({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      content: new Uint8Array(await new Response(blob.body).arrayBuffer()),
      contentId: attachment.contentId,
      inline: attachment.inline,
    });
  }
  return built;
}

export function buildRecipientRows(
  recipients: ValidatedRecipients,
): readonly MessageRecipient[] {
  const rows: MessageRecipient[] = [];
  const groups: readonly (readonly [RecipientKind, readonly EmailAddress[]])[] =
    [
      [RecipientKind.To, recipients.to],
      [RecipientKind.Cc, recipients.cc],
      [RecipientKind.Bcc, recipients.bcc],
    ];
  for (const [kind, addresses] of groups) {
    addresses.forEach((address, position) => {
      rows.push({ kind, address, name: null, position });
    });
  }
  return rows;
}

interface ThreadContext {
  readonly threadId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
}

export async function resolveThreadContext(
  deps: AppDependencies,
  inReplyToMessageId: MessageId | undefined,
): Promise<ThreadContext> {
  if (inReplyToMessageId === undefined) {
    return { threadId: null, inReplyTo: null, references: [] };
  }
  const parent = await deps.messageRepository.findById(inReplyToMessageId);
  if (parent === null) {
    throw new NotFoundError("Message", inReplyToMessageId);
  }
  const references =
    parent.rfcMessageId === null
      ? parent.references
      : [...parent.references, parent.rfcMessageId];
  return {
    threadId: parent.threadId,
    inReplyTo: parent.rfcMessageId,
    references,
  };
}

/** Delivers `message` and records the outcome. The message row is already
 * persisted by the time this runs, so a failure -- including a Worker
 * eviction between the write and the provider call -- leaves a visible,
 * retryable `QUEUED`/`FAILED` row rather than a silently lost send. */
export async function deliver(
  deps: AppDependencies,
  message: Message,
  mail: Parameters<AppDependencies["mailSender"]["send"]>[0],
): Promise<Message> {
  const now = deps.clock.now().toISOString();
  try {
    await deps.mailSender.send(mail);
  } catch (error) {
    // The provider's own message routinely echoes recipient addresses and
    // subjects; store only its class name so the failure is diagnosable
    // without leaking message content into an error field clients can read.
    const reason =
      error instanceof Error ? error.name : "Unknown delivery failure";
    const failed = markMessageFailed(message, reason, now);
    await deps.messageRepository.save(failed);
    return failed;
  }
  const sent = markMessageSent(message, now);
  await deps.messageRepository.save(sent);
  return sent;
}

export function createSendMessageUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: SendMessageInput) => Promise<Message> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const from = createEmailAddress(input.from, "from");
      const domain = await deps.mailDomainRepository.findByName(
        emailDomainName(from),
      );
      if (domain === null) {
        throw new BadUserInputError(
          `${input.from} is not on a managed domain`,
          "from",
        );
      }
      requireAddressCapability(viewer, Capability.MailSend, domain.id, [from]);
      assertCanSendMail(domain);

      const recipients = validateRecipients(input);
      validateBodies(input);
      const headers = validateCustomHeaders(input.headers);
      const attachments = await loadOutboundAttachments(
        deps,
        input.attachmentIds,
      );

      const now = deps.clock.now().toISOString();
      const messageId = createMessageId(deps.random.uuid());
      const rfcMessageId = `${messageId}@${domain.name}`;
      const thread = await resolveThreadContext(deps, input.inReplyToMessageId);

      const mimeAttachments = await readAttachmentBytes(deps, attachments);
      const raw = deps.mimeBuilder.build({
        from: { address: from, name: null },
        to: recipients.to.map((address) => ({ address, name: null })),
        cc: recipients.cc.map((address) => ({ address, name: null })),
        bcc: recipients.bcc.map((address) => ({ address, name: null })),
        subject: input.subject,
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.html === undefined ? {} : { html: input.html }),
        messageId: rfcMessageId,
        ...(thread.inReplyTo === null ? {} : { inReplyTo: thread.inReplyTo }),
        references: thread.references,
        date: now,
        headers,
        attachments: mimeAttachments,
      });

      const rawKey = buildRawMessageBlobKey(messageId);
      await deps.blobs.put(rawKey, new TextEncoder().encode(raw), {
        contentType: "message/rfc822",
      });

      const message = createOutboundMessage({
        id: messageId,
        domainId: domain.id,
        threadId:
          thread.threadId === null
            ? createThreadId(messageId)
            : createThreadId(thread.threadId),
        rfcMessageId,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
        subject: input.subject,
        fromAddress: from,
        fromName: null,
        textBody: input.text ?? null,
        htmlBody: input.html ?? null,
        rawKey,
        rawSize: raw.length,
        occurredAt: now,
        createdAt: now,
      });

      await deps.messageRepository.insertWithRelations({
        message,
        recipients: buildRecipientRows(recipients),
        // Binds the staged uploads to this message, so they stop being
        // orphans and start cascading with it on delete.
        attachments: attachments.map((attachment) =>
          attachToMessage(attachment, messageId),
        ),
        tagIds: input.tagIds ?? [],
        taggedAt: now,
      });

      return deliver(deps, message, {
        from,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        subject: input.subject,
        text: input.text ?? "",
        ...(input.html === undefined ? {} : { html: input.html }),
        headers,
        raw,
        // Same bytes `raw` already encodes, handed over structurally for a
        // provider that assembles the MIME itself.
        attachments: mimeAttachments.map((attachment) => ({
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          content: attachment.content,
          inline: attachment.inline,
        })),
      });
    });
}

/** Re-attempts a `FAILED` outbound message. Guarded to that state so a
 * `SENT` message can never be delivered twice by a retry. */
export function createRetrySendUseCase(
  deps: AppDependencies,
): (viewer: Viewer, messageId: MessageId) => Promise<Message> {
  return async (viewer, messageId) =>
    withAsyncDomainErrorTranslation(async () => {
      const message = await deps.messageRepository.findById(messageId);
      if (message === null) {
        throw new NotFoundError("Message", messageId);
      }
      requireAddressCapability(viewer, Capability.MailSend, message.domainId, [
        message.fromAddress,
      ]);
      if (message.deliveryStatus !== DeliveryStatus.Failed) {
        throw new BadUserInputError(
          "Only a failed message can be retried",
          "messageId",
        );
      }

      const recipientsByKind = await deps.messageRepository.listRecipients([
        messageId,
      ]);
      const rows = recipientsByKind.get(messageId) ?? [];
      const addressesOf = (kind: RecipientKind): readonly EmailAddress[] =>
        rows.filter((row) => row.kind === kind).map((row) => row.address);

      const requeued = requeueMessage(message, deps.clock.now().toISOString());
      await deps.messageRepository.save(requeued);

      const stored = await deps.blobs.get(message.rawKey ?? "");
      const raw =
        stored === null ? undefined : await new Response(stored.body).text();

      return deliver(deps, requeued, {
        from: message.fromAddress,
        to: addressesOf(RecipientKind.To),
        cc: addressesOf(RecipientKind.Cc),
        bcc: addressesOf(RecipientKind.Bcc),
        subject: message.subject,
        text: message.textBody ?? "",
        ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
        ...(raw === undefined ? {} : { raw }),
      });
    });
}

/** The mailboxes this credential may actually send as.
 *
 * Provisioned addresses come first and are reported concretely, one entry
 * per real mailbox, each checked against the viewer's own `MAIL_SEND`
 * authorization -- so an agent can list what it may use and pass one
 * straight back as `SendMessageInput.from`.
 *
 * A sendable domain with no provisioned mailbox the viewer may use falls
 * back to the pattern form (`*@example.com`, or the scope's own pattern).
 * Dropping that would silently empty the picker on a catch-all deployment
 * that has never provisioned anything, which is every deployment predating
 * mailbox provisioning. */
export function createListSendableAddressesUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly string[]> {
  return async (viewer) => {
    const domains = await deps.mailDomainRepository.list();
    const sendable = domains.filter((domain) => {
      try {
        assertCanSendMail(domain);
        return true;
      } catch {
        return false;
      }
    });
    if (sendable.length === 0) {
      return [];
    }

    const provisioned = await deps.mailAddressRepository.list();
    const results: string[] = [];
    const push = (value: string): void => {
      if (!results.includes(value)) {
        results.push(value);
      }
    };

    for (const domain of sendable) {
      const usable = provisioned.filter(
        (entry) =>
          entry.domainId === domain.id &&
          isMailAddressActive(entry) &&
          authorizesAnyAddress(viewer, Capability.MailSend, domain.id, [
            entry.address,
          ]),
      );
      if (usable.length > 0) {
        for (const entry of usable) {
          push(entry.address);
        }
        continue;
      }
      for (const pattern of fallbackPatterns(viewer, domain)) {
        push(pattern);
      }
    }
    return results;
  };
}

/** The pre-provisioning behaviour, kept for domains with no usable mailbox:
 * a user sees the whole domain, a key sees each of its `MAIL_SEND` scope
 * patterns. */
function fallbackPatterns(
  viewer: Viewer,
  domain: { readonly id: DomainId; readonly name: string },
): readonly string[] {
  if (viewer.kind === "USER") {
    return [`*@${domain.name}`];
  }
  const patterns: string[] = [];
  for (const scope of viewer.scopes) {
    if (scope.capability !== Capability.MailSend) {
      continue;
    }
    if (scope.domainId !== null && scope.domainId !== domain.id) {
      continue;
    }
    const rendered =
      scope.addressPattern === "*"
        ? `*@${domain.name}`
        : (scope.addressPattern as string);
    if (!patterns.includes(rendered)) {
      patterns.push(rendered);
    }
  }
  return patterns;
}
