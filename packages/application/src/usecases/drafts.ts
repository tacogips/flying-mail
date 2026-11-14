import { Capability } from "@mailcal/domain/entities/api-key";
import { attachToMessage } from "@mailcal/domain/entities/attachment";
import {
  createDraftMessage,
  MailStatus,
  type Message,
  RecipientKind,
  submitDraft,
  updateDraftMessage,
} from "@mailcal/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
  emailDomainName,
} from "@mailcal/domain/value-objects/email-address";
import {
  type AttachmentId,
  createMessageId,
  createThreadId,
  type MessageId,
} from "@mailcal/domain/value-objects/ids";
import { buildRawMessageBlobKey } from "@mailcal/domain/entities/attachment";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import { assertCanSendMail } from "@mailcal/domain/entities/mail-domain";
import { requireAddressCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  buildRecipientRows,
  deliver,
  loadOutboundAttachments,
  readAttachmentBytes,
  resolveThreadContext,
  type ValidatedRecipients,
} from "./send";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface SaveDraftInput {
  /** Updates this draft when present, creates a new one otherwise. */
  readonly draftId?: MessageId;
  /** Threads the draft as a reply to this message; resolved at save time
   * so the eventual send carries the right In-Reply-To and References. */
  readonly inReplyToMessageId?: MessageId;
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachmentIds?: readonly AttachmentId[];
}

/** Unlike a send, a draft may have any recipient set -- including none.
 * Addresses that are present must still parse, so a typo surfaces at save
 * time rather than at the eventual send. */
function parseDraftRecipients(input: SaveDraftInput): ValidatedRecipients {
  const parse = (
    values: readonly string[] | undefined,
    field: string,
  ): readonly EmailAddress[] =>
    (values ?? []).map((value) => createEmailAddress(value, field));
  return {
    to: parse(input.to, "to"),
    cc: parse(input.cc, "cc"),
    bcc: parse(input.bcc, "bcc"),
  };
}

async function requireDraftAuthority(
  deps: AppDependencies,
  viewer: Viewer,
  from: EmailAddress,
): Promise<void> {
  const domain = await deps.mailDomainRepository.findByName(
    emailDomainName(from),
  );
  if (domain === null) {
    throw new BadUserInputError(`${from} is not on a managed domain`, "from");
  }
  // Draft authorship is gated on the same capability the eventual send
  // needs; a key that could never send the mail has no business staging it.
  requireAddressCapability(viewer, Capability.MailSend, domain.id, [from]);
}

async function loadOwnDraft(
  deps: AppDependencies,
  viewer: Viewer,
  draftId: MessageId,
): Promise<Message> {
  const draft = await deps.messageRepository.findById(draftId);
  // Out-of-scope reads answer NOT_FOUND, never FORBIDDEN, to prevent id
  // probing -- the same policy as message reads.
  if (draft === null || draft.status !== MailStatus.Draft) {
    throw new NotFoundError("Draft", draftId);
  }
  await requireDraftAuthority(deps, viewer, draft.fromAddress);
  return draft;
}

export function createSaveDraftUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: SaveDraftInput) => Promise<Message> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const from = createEmailAddress(input.from, "from");
      await requireDraftAuthority(deps, viewer, from);
      const recipients = parseDraftRecipients(input);
      const attachments = await loadOutboundAttachments(
        deps,
        input.attachmentIds,
      );
      const now = deps.clock.now().toISOString();

      if (input.draftId !== undefined) {
        const existing = await loadOwnDraft(deps, viewer, input.draftId);
        const updated = updateDraftMessage(
          existing,
          {
            subject: input.subject ?? "",
            fromAddress: from,
            textBody: input.text ?? null,
            htmlBody: input.html ?? null,
          },
          now,
        );
        await deps.messageRepository.save(updated);
        await deps.messageRepository.replaceRecipients(
          updated.id,
          buildRecipientRows(recipients),
        );
        for (const attachment of attachments) {
          await deps.messageRepository.saveAttachment(
            attachToMessage(attachment, updated.id),
          );
        }
        return updated;
      }

      const domain = await deps.mailDomainRepository.findByName(
        emailDomainName(from),
      );
      if (domain === null) {
        throw new BadUserInputError(
          `${input.from} is not on a managed domain`,
          "from",
        );
      }
      const messageId = createMessageId(deps.random.uuid());
      const thread = await resolveThreadContext(deps, input.inReplyToMessageId);
      const draft = createDraftMessage({
        id: messageId,
        domainId: domain.id,
        threadId:
          thread.threadId === null
            ? createThreadId(messageId)
            : createThreadId(thread.threadId),
        rfcMessageId: null,
        inReplyTo: thread.inReplyTo,
        references: thread.references,
        subject: input.subject ?? "",
        fromAddress: from,
        fromName: null,
        textBody: input.text ?? null,
        htmlBody: input.html ?? null,
        rawKey: null,
        rawSize: 0,
        occurredAt: now,
        createdAt: now,
      });
      await deps.messageRepository.insertWithRelations({
        message: draft,
        recipients: buildRecipientRows(recipients),
        attachments: attachments.map((attachment) =>
          attachToMessage(attachment, messageId),
        ),
        tagIds: [],
        taggedAt: now,
      });
      return draft;
    });
}

/** Dispatches an existing draft: builds the MIME source from the stored
 * content, flips the lifecycle to SENT, and hands it to the provider. The
 * draft row *becomes* the sent message -- same id, same thread. */
export function createSendDraftUseCase(
  deps: AppDependencies,
): (viewer: Viewer, draftId: MessageId) => Promise<Message> {
  return async (viewer, draftId) =>
    withAsyncDomainErrorTranslation(async () => {
      const draft = await loadOwnDraft(deps, viewer, draftId);
      const domain = await deps.mailDomainRepository.findById(draft.domainId);
      if (domain === null) {
        throw new NotFoundError("Domain", draft.domainId);
      }
      assertCanSendMail(domain);

      const recipientRows =
        (await deps.messageRepository.listRecipients([draft.id])).get(
          draft.id,
        ) ?? [];
      const byKind = (kind: RecipientKind): readonly EmailAddress[] =>
        recipientRows
          .filter((row) => row.kind === kind)
          .map((row) => row.address);
      const to = byKind(RecipientKind.To);
      const cc = byKind(RecipientKind.Cc);
      const bcc = byKind(RecipientKind.Bcc);
      if (to.length === 0) {
        throw new BadUserInputError("The draft has no To recipient", "draftId");
      }
      if (draft.textBody === null && draft.htmlBody === null) {
        throw new BadUserInputError("The draft has no body", "draftId");
      }

      const attachments =
        (await deps.messageRepository.listAttachments([draft.id])).get(
          draft.id,
        ) ?? [];
      const now = deps.clock.now().toISOString();
      const rfcMessageId = `${draft.id}@${domain.name}`;
      const raw = deps.mimeBuilder.build({
        from: { address: draft.fromAddress, name: draft.fromName },
        to: to.map((address) => ({ address, name: null })),
        cc: cc.map((address) => ({ address, name: null })),
        bcc: bcc.map((address) => ({ address, name: null })),
        subject: draft.subject,
        ...(draft.textBody === null ? {} : { text: draft.textBody }),
        ...(draft.htmlBody === null ? {} : { html: draft.htmlBody }),
        messageId: rfcMessageId,
        // The thread context resolved at save time, so a reply draft
        // still threads correctly however long it sat unsent.
        ...(draft.inReplyTo === null ? {} : { inReplyTo: draft.inReplyTo }),
        references: draft.references,
        date: now,
        headers: new Map(),
        attachments: await readAttachmentBytes(deps, attachments),
      });
      const rawKey = buildRawMessageBlobKey(draft.id);
      await deps.blobs.put(rawKey, new TextEncoder().encode(raw), {
        contentType: "message/rfc822",
      });

      const submitted = {
        ...submitDraft(draft, now),
        rfcMessageId,
        rawKey,
        rawSize: raw.length,
      };
      await deps.messageRepository.save(submitted);

      return deliver(deps, submitted, {
        from: draft.fromAddress,
        to,
        cc,
        bcc,
        subject: draft.subject,
        text: draft.textBody ?? "",
        ...(draft.htmlBody === null ? {} : { html: draft.htmlBody }),
        headers: new Map(),
        raw,
      });
    });
}
