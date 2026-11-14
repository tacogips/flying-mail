import type { Attachment } from "@flying-mail/domain/entities/attachment";
import { MailStatus } from "@flying-mail/domain/entities/message";
import type {
  AttachmentId,
  MessageId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { loadReadableMessage } from "./messages";

/** Provider attachment cap, re-exported by send.ts for its public API. */
export const MAX_OUTBOUND_ATTACHMENTS = 32;
/** Provider attachment byte cap, re-exported by send.ts for its public API. */
export const MAX_OUTBOUND_TOTAL_BYTES = 5 * 1024 * 1024;

/** Resolves attachment ids that may safely be attached to a send or draft. */
export async function resolveOwnAttachments(
  deps: AppDependencies,
  attachmentIds: readonly AttachmentId[] | undefined,
  draftId: MessageId | null,
): Promise<readonly Attachment[]> {
  const attachments: Attachment[] = [];
  for (const id of attachmentIds ?? []) {
    const attachment = await deps.messageRepository.findAttachmentById(id);
    if (
      attachment === null ||
      (attachment.messageId !== null && attachment.messageId !== draftId)
    ) {
      throw new NotFoundError("Attachment", id);
    }
    attachments.push(attachment);
  }
  return attachments;
}

/** Resolves authorized source attachments for forwarding without copying blobs. */
export async function resolveForwardSources(
  deps: AppDependencies,
  viewer: Viewer,
  forwardedFromMessageId: MessageId | undefined,
  forwardAttachmentIds: readonly AttachmentId[] | undefined,
): Promise<{
  readonly source: Awaited<ReturnType<typeof loadReadableMessage>>;
  readonly attachments: readonly Attachment[];
}> {
  const ids = forwardAttachmentIds ?? [];
  if (forwardedFromMessageId === undefined) {
    if (ids.length > 0) {
      throw new BadUserInputError(
        "Forwarded attachments require a source message",
        "forwardedFromMessageId",
      );
    }
    return { source: null, attachments: [] };
  }

  const source = await loadReadableMessage(
    deps,
    viewer,
    forwardedFromMessageId,
  );
  if (source === null) {
    throw new NotFoundError("Message", forwardedFromMessageId);
  }
  if (source.status === MailStatus.Draft) {
    throw new BadUserInputError(
      "A draft cannot be used as a forward source",
      "forwardedFromMessageId",
    );
  }

  const attachments: Attachment[] = [];
  for (const id of ids) {
    const attachment = await deps.messageRepository.findAttachmentById(id);
    if (attachment === null || attachment.messageId !== source.id) {
      throw new NotFoundError("Attachment", id);
    }
    attachments.push(attachment);
  }
  return { source, attachments };
}

/** Checks the provider's outbound attachment count and byte limits. */
export function assertOutboundAttachmentLimits(
  attachments: readonly Pick<Attachment, "size">[],
): void {
  if (attachments.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new BadUserInputError(
      `A message may not have more than ${MAX_OUTBOUND_ATTACHMENTS} attachments`,
      "attachmentIds",
    );
  }
  const totalBytes = attachments.reduce((total, item) => total + item.size, 0);
  if (totalBytes > MAX_OUTBOUND_TOTAL_BYTES) {
    throw new BadUserInputError(
      `Attachments exceed the ${MAX_OUTBOUND_TOTAL_BYTES / (1024 * 1024)} MB total size limit`,
      "attachmentIds",
    );
  }
}
