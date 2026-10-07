import { Capability } from "@flying-mail/domain/entities/api-key";
import type { Attachment } from "@flying-mail/domain/entities/attachment";
import {
  attachToMessage,
  buildRawMessageBlobKey,
  copyAttachmentForForward,
} from "@flying-mail/domain/entities/attachment";
import {
  type ExternalMailAccount,
  isExternalAccountActive,
} from "@flying-mail/domain/entities/external-mail-account";
import { isMailAddressActive } from "@flying-mail/domain/entities/mail-address";
import { assertCanSendMail } from "@flying-mail/domain/entities/mail-domain";
import { UserRole } from "@flying-mail/domain/entities/user";
import {
  createOutboundMessage,
  DeliveryStatus,
  markMessageFailed,
  markMessageSent,
  type Message,
  type MessageRecipient,
  RecipientKind,
  requeueMessage,
} from "@flying-mail/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
  emailDomainName,
} from "@flying-mail/domain/value-objects/email-address";
import {
  type AttachmentId,
  createAttachmentId,
  type DomainId,
  createMessageId,
  createThreadId,
  type MailAddressId,
  type MessageId,
  type TagId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import {
  authorizesAnyAddress,
  mailAuthorizationRules,
  requireAddressCapability,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type { BuildMimeAttachment } from "../ports/mime";
import { readDeliveryReason } from "../ports/mail-sender";
import { loadReadableMessage } from "./messages";
import {
  assertOutboundAttachmentLimits,
  resolveForwardSources,
  resolveOwnAttachments,
} from "./attachment-binding";
import { assembleOutbound } from "./outbound-assembly";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Provider limits, validated before the binding call so a caller gets a
 * `BAD_USER_INPUT` naming the offending field instead of an opaque
 * provider error. See `design-mail-pipeline.md#limits-summary`. */
export const MAX_RECIPIENTS_PER_MESSAGE = 50;
export {
  MAX_OUTBOUND_ATTACHMENTS,
  MAX_OUTBOUND_TOTAL_BYTES,
} from "./attachment-binding";

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
  readonly replyTo?: string;
  readonly inReplyToMessageId?: MessageId;
  readonly forwardedFromMessageId?: MessageId;
  readonly forwardAttachmentIds?: readonly AttachmentId[];
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
  viewer: Viewer,
  inReplyToMessageId: MessageId | undefined,
): Promise<ThreadContext> {
  if (inReplyToMessageId === undefined) {
    return { threadId: null, inReplyTo: null, references: [] };
  }
  const parent = await loadReadableMessage(deps, viewer, inReplyToMessageId);
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

type OutboundMailInput = Parameters<AppDependencies["mailSender"]["send"]>[0];

/** Non-null only when `mailAddressId`'s external account is `ACTIVE` and has
 * an SMTP relay configured -- the two conditions under which `deliver`
 * relays through it instead of `deps.mailSender`. Exported for fetch/send
 * branch unit tests. */
export async function resolveExternalSmtpAccount(
  deps: AppDependencies,
  mailAddressId: MailAddressId,
): Promise<ExternalMailAccount | null> {
  const account =
    await deps.externalMailAccountRepository.findByMailAddress(mailAddressId);
  if (
    account === null ||
    !isExternalAccountActive(account) ||
    account.smtp === null
  ) {
    return null;
  }
  return account;
}

/** Reconstructs an RFC 5322 source for the SMTP relay branch when `mail.raw`
 * is absent -- `retrySend` may hand `deliver` a `mail` with no `raw` when the
 * original blob could not be read back. `deps.mailSender` tolerates that
 * (providers that accept structured parts build their own MIME), but
 * `SmtpSubmissionClient.send` always needs actual bytes for `DATA`. */
function buildFallbackRaw(
  deps: AppDependencies,
  message: Message,
  mail: OutboundMailInput,
): string {
  return deps.mimeBuilder.build({
    from: { address: message.fromAddress, name: message.fromName },
    to: mail.to.map((address) => ({ address, name: null })),
    cc: (mail.cc ?? []).map((address) => ({ address, name: null })),
    bcc: (mail.bcc ?? []).map((address) => ({ address, name: null })),
    subject: message.subject,
    ...(message.textBody === null ? {} : { text: message.textBody }),
    ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
    messageId: message.rfcMessageId ?? `${message.id}@retry`,
    ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
    references: message.references,
    date: message.occurredAt,
    headers: mail.headers ?? new Map(),
  });
}

/** Picks the transport for one outbound message: an `ACTIVE` external
 * account with SMTP configured for `mail.from` relays through its own
 * provider, with `From`/`MAIL FROM` set to the *external* address, so
 * replies work and SPF/DKIM are the provider's. Everything else keeps using
 * the existing `mailSender` -- already resolved once, at composition time,
 * by `resolveMailSender`'s Email Sending REST API -> `send_email` binding ->
 * unavailable-sender fallback chain. Checked *before* `mailSender` is
 * touched at all, so an external account never even reaches that chain. */
async function deliverMail(
  deps: AppDependencies,
  message: Message,
  mail: OutboundMailInput,
): Promise<{ readonly providerMessageId: string | null }> {
  const mailAddress = await deps.mailAddressRepository.findByAddress(mail.from);
  const account =
    mailAddress === null
      ? null
      : await resolveExternalSmtpAccount(deps, mailAddress.id);
  if (account === null || account.smtp === null) {
    return deps.mailSender.send(mail);
  }

  const smtp = account.smtp;
  try {
    const password = await deps.credentialCipher.decrypt(
      smtp.passwordCiphertext,
    );
    await deps.smtpSubmissionClient.send(
      {
        host: smtp.host,
        port: smtp.port,
        security: smtp.security,
        username: smtp.username,
        password,
      },
      {
        from: account.externalAddress,
        to: [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])],
        raw: mail.raw ?? buildFallbackRaw(deps, message, mail),
      },
    );
  } catch {
    throw { reason: "RELAY_ERROR" };
  }
  return { providerMessageId: null };
}

/** Delivers `message` and records the outcome. The message row is already
 * persisted by the time this runs, so a delivery failure -- including a
 * Worker eviction between the write and the provider call -- leaves a
 * visible, retryable `QUEUED`/`FAILED` row rather than a silently lost send.
 * Post-delivery persistence errors propagate so a successfully delivered
 * message is never marked failed and sent again by `retrySend`. Shared by
 * both transports: `markMessageSent`/`markMessageFailed` bookkeeping never
 * duplicates between the Cloudflare and SMTP-relay branches, since both
 * flow through this one function and only `deliverMail` above branches on
 * the transport. */
export async function deliver(
  deps: AppDependencies,
  message: Message,
  mail: OutboundMailInput,
): Promise<Message> {
  const now = deps.clock.now().toISOString();
  let receipt: { readonly providerMessageId: string | null };
  try {
    receipt = await deliverMail(deps, message, mail);
  } catch (error) {
    const reason = readDeliveryReason(error);
    const failed = markMessageFailed(message, reason, now);
    await deps.messageRepository.save(failed);
    return failed;
  }

  const providerMessageId = receipt.providerMessageId
    ?.trim()
    .replace(/^<|>$/g, "");
  const normalizedProviderMessageId =
    providerMessageId === "" ? null : (providerMessageId ?? null);
  const sent = markMessageSent(message, now);
  const reconciled =
    normalizedProviderMessageId !== null &&
    normalizedProviderMessageId !== message.rfcMessageId
      ? { ...sent, rfcMessageId: normalizedProviderMessageId }
      : sent;
  await deps.messageRepository.save(reconciled);
  return reconciled;
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
      const provisionedFrom =
        await deps.mailAddressRepository.findByAddress(from);
      if (provisionedFrom !== null && !isMailAddressActive(provisionedFrom)) {
        throw new BadUserInputError(
          "A disabled mail address cannot be used as a sender",
          "from",
        );
      }

      const recipients = validateRecipients(input);
      validateBodies(input);
      const headers = validateCustomHeaders(input.headers);
      const ownAttachments = await resolveOwnAttachments(
        deps,
        input.attachmentIds,
        null,
      );
      const forward = await resolveForwardSources(
        deps,
        viewer,
        input.forwardedFromMessageId,
        input.forwardAttachmentIds,
      );
      assertOutboundAttachmentLimits([
        ...ownAttachments,
        ...forward.attachments,
      ]);
      const replyTo =
        input.replyTo === undefined
          ? null
          : createEmailAddress(input.replyTo, "replyTo");

      const now = deps.clock.now().toISOString();
      const messageId = createMessageId(deps.random.uuid());
      const rfcMessageId = `${messageId}@${domain.name}`;
      const thread = await resolveThreadContext(
        deps,
        viewer,
        input.inReplyToMessageId,
      );
      const rawKey = buildRawMessageBlobKey(messageId);
      const message = createOutboundMessage({
        id: messageId,
        domainId: domain.id,
        threadId:
          thread.threadId === null
            ? createThreadId(messageId)
            : createThreadId(thread.threadId),
        rfcMessageId,
        inReplyTo: thread.inReplyTo,
        replyTo,
        forwardedFromMessageId: input.forwardedFromMessageId ?? null,
        references: thread.references,
        subject: input.subject,
        fromAddress: from,
        fromName: null,
        textBody: input.text ?? null,
        htmlBody: input.html ?? null,
        rawKey,
        rawSize: 0,
        occurredAt: now,
        createdAt: now,
      });

      const forwardedAttachments = forward.attachments.map((attachment) =>
        copyAttachmentForForward(attachment, {
          id: createAttachmentId(deps.random.uuid()),
          messageId,
          createdAt: now,
        }),
      );
      await deps.messageRepository.insertWithRelations({
        message,
        recipients: buildRecipientRows(recipients),
        // Binds the staged uploads to this message, so they stop being
        // orphans and start cascading with it on delete.
        attachments: [
          ...ownAttachments.map((attachment) =>
            attachToMessage(attachment, messageId),
          ),
          ...forwardedAttachments,
        ],
        tagIds: input.tagIds ?? [],
        taggedAt: now,
      });
      const outbound = await assembleOutbound(deps, message, {
        customHeaders: headers,
      });
      const ready = { ...message, rawSize: outbound.raw.length };
      await deps.messageRepository.save(ready);
      await deps.blobs.put(rawKey, new TextEncoder().encode(outbound.raw), {
        contentType: "message/rfc822",
      });
      return deliver(deps, ready, outbound.mail);
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

      const requeued = requeueMessage(message, deps.clock.now().toISOString());
      await deps.messageRepository.save(requeued);
      const outbound = await assembleOutbound(deps, requeued);
      return deliver(deps, requeued, outbound.mail);
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

/** Fallback sendable patterns for domains with no usable provisioned
 * mailbox: admins get the domain wildcard subject to DENY rules, members get
 * only their own ALLOW patterns, and API keys keep their scoped patterns. */
function fallbackPatterns(
  viewer: Viewer,
  domain: { readonly id: DomainId; readonly name: string },
): readonly string[] {
  if (viewer.kind === "USER") {
    const rules = mailAuthorizationRules(viewer, Capability.MailSend).filter(
      (rule) => rule.domainId === null || rule.domainId === domain.id,
    );
    const denied = rules.some(
      (rule) =>
        rule.effect === "DENY" &&
        (rule.addressPattern === "*" ||
          rule.addressPattern === `*@${domain.name}`),
    );
    if (denied) {
      return [];
    }
    if (viewer.role === UserRole.Admin) {
      return [`*@${domain.name}`];
    }
    if (viewer.role !== UserRole.Member) {
      return [];
    }
    return rules
      .filter((rule) => rule.effect === "ALLOW")
      .map((rule) => rule.addressPattern as string)
      .filter(
        (pattern) =>
          !rules.some(
            (rule) => rule.effect === "DENY" && rule.addressPattern === pattern,
          ),
      );
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
