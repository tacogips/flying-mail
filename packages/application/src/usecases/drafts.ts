import { Capability } from "@flying-mail/domain/entities/api-key";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  attachToMessage,
  buildRawMessageBlobKey,
  copyAttachmentForForward,
} from "@flying-mail/domain/entities/attachment";
import { isMailAddressActive } from "@flying-mail/domain/entities/mail-address";
import {
  createDraftMessage,
  MailStatus,
  type Message,
  RecipientKind,
  submitDraft,
  updateDraftMessage,
} from "@flying-mail/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
  emailDomainName,
} from "@flying-mail/domain/value-objects/email-address";
import {
  type AttachmentId,
  createAttachmentId,
  createMessageId,
  createThreadId,
  type MessageId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ConflictError, NotFoundError } from "../errors";
import { assertCanSendMail } from "@flying-mail/domain/entities/mail-domain";
import { requireAddressCapability } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  buildRecipientRows,
  deliver,
  resolveThreadContext,
  type ValidatedRecipients,
} from "./send";
import {
  assertOutboundAttachmentLimits,
  resolveForwardSources,
  resolveOwnAttachments,
} from "./attachment-binding";
import { assembleOutbound } from "./outbound-assembly";
import { deleteAttachmentsAndUnreferencedBlobs } from "./attachment-blobs";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";
import { recordMailEvents } from "./mail-events";

export interface SaveDraftInput {
  /** Updates this draft when present, creates a new one otherwise. */
  readonly draftId?: MessageId;
  /** Threads the draft as a reply to this message; resolved at save time
   * so the eventual send carries the right In-Reply-To and References. */
  readonly inReplyToMessageId?: MessageId;
  readonly replyTo?: string;
  readonly forwardedFromMessageId?: MessageId;
  readonly forwardAttachmentIds?: readonly AttachmentId[];
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
  const provisioned = await deps.mailAddressRepository.findByAddress(from);
  if (provisioned !== null && !isMailAddressActive(provisioned)) {
    throw new BadUserInputError(
      "A disabled mail address cannot be used as a sender",
      "from",
    );
  }
}

export async function loadOwnDraft(
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
      const ownAttachments = await resolveOwnAttachments(
        deps,
        input.attachmentIds,
        input.draftId ?? null,
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
      const domain = await deps.mailDomainRepository.findByName(
        emailDomainName(from),
      );
      if (domain === null) {
        throw new BadUserInputError(
          `${input.from} is not on a managed domain`,
          "from",
        );
      }
      const now = deps.clock.now().toISOString();

      if (input.draftId !== undefined) {
        const existing = await loadOwnDraft(deps, viewer, input.draftId);
        const thread =
          input.inReplyToMessageId === undefined
            ? null
            : await resolveThreadContext(
                deps,
                viewer,
                input.inReplyToMessageId,
              );
        const updated = updateDraftMessage(
          existing,
          {
            subject: input.subject ?? "",
            fromAddress: from,
            replyTo,
            textBody: input.text ?? null,
            htmlBody: input.html ?? null,
            domainId: domain.id,
            ...(thread === null
              ? {}
              : {
                  threadId:
                    thread.threadId === null
                      ? createThreadId(existing.id)
                      : createThreadId(thread.threadId),
                  inReplyTo: thread.inReplyTo,
                  references: thread.references,
                }),
            ...(input.forwardedFromMessageId === undefined
              ? {}
              : {
                  forwardedFromMessageId: input.forwardedFromMessageId,
                }),
          },
          now,
        );
        if (!(await deps.messageRepository.saveIfDraft(updated))) {
          throw new ConflictError("Draft was already sent or deleted");
        }
        await deps.messageRepository.replaceRecipients(
          updated.id,
          buildRecipientRows(recipients),
        );
        const currentAttachments =
          (await deps.messageRepository.listAttachments([updated.id])).get(
            updated.id,
          ) ?? [];
        const keepIds = new Set(ownAttachments.map(({ id }) => id));
        const removed = currentAttachments.filter(
          (attachment) => !keepIds.has(attachment.id),
        );
        await deleteAttachmentsAndUnreferencedBlobs(deps, removed);
        for (const attachment of ownAttachments) {
          if (attachment.messageId === null) {
            await deps.messageRepository.saveAttachment(
              attachToMessage(attachment, updated.id),
            );
          }
        }
        const currentAfterReplacement =
          (await deps.messageRepository.listAttachments([updated.id])).get(
            updated.id,
          ) ?? [];
        const existingBlobKeys = new Set(
          currentAfterReplacement.map(({ blobKey }) => blobKey),
        );
        for (const attachment of forward.attachments) {
          if (existingBlobKeys.has(attachment.blobKey)) {
            continue;
          }
          await deps.messageRepository.saveAttachment(
            copyAttachmentForForward(attachment, {
              id: createAttachmentId(deps.random.uuid()),
              messageId: updated.id,
              createdAt: now,
            }),
          );
          existingBlobKeys.add(attachment.blobKey);
        }
        await recordMailEvents(deps, [
          { type: MailEventType.DraftSaved, message: updated },
        ]);
        return updated;
      }

      const messageId = createMessageId(deps.random.uuid());
      const thread = await resolveThreadContext(
        deps,
        viewer,
        input.inReplyToMessageId,
      );
      const draft = createDraftMessage({
        id: messageId,
        domainId: domain.id,
        threadId:
          thread.threadId === null
            ? createThreadId(messageId)
            : createThreadId(thread.threadId),
        rfcMessageId: null,
        inReplyTo: thread.inReplyTo,
        replyTo,
        forwardedFromMessageId: input.forwardedFromMessageId ?? null,
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
        attachments: [
          ...ownAttachments.map((attachment) =>
            attachToMessage(attachment, messageId),
          ),
          ...forward.attachments.map((attachment) =>
            copyAttachmentForForward(attachment, {
              id: createAttachmentId(deps.random.uuid()),
              messageId,
              createdAt: now,
            }),
          ),
        ],
        tagIds: [],
        taggedAt: now,
      });
      await recordMailEvents(deps, [
        { type: MailEventType.DraftSaved, message: draft },
      ]);
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
      if (to.length === 0) {
        throw new BadUserInputError("The draft has no To recipient", "draftId");
      }
      if (draft.textBody === null && draft.htmlBody === null) {
        throw new BadUserInputError("The draft has no body", "draftId");
      }

      const now = deps.clock.now().toISOString();
      const rfcMessageId = `${draft.id}@${domain.name}`;
      const rawKey = buildRawMessageBlobKey(draft.id);
      const submitted = {
        ...submitDraft(draft, now),
        rfcMessageId,
        rawKey,
      };
      if (!(await deps.messageRepository.saveIfDraft(submitted))) {
        throw new ConflictError("Draft was already sent or deleted");
      }
      const outbound = await assembleOutbound(deps, submitted);
      await deps.blobs.put(rawKey, new TextEncoder().encode(outbound.raw), {
        contentType: "message/rfc822",
      });
      const ready = { ...submitted, rawSize: outbound.raw.length };
      await deps.messageRepository.save(ready);
      const delivered = await deliver(deps, ready, outbound.mail);
      await recordMailEvents(deps, [
        { type: MailEventType.MessageSent, message: delivered },
      ]);
      return delivered;
    });
}
