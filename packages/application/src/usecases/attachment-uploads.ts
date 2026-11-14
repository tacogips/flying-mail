import {
  buildAttachmentBlobKey,
  createAttachment,
  type Attachment,
} from "@flying-mail/domain/entities/attachment";
import {
  createAttachmentId,
  type AttachmentId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import { authorizesAnyMailSend } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type { BlobObject } from "../ports/blob-store";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "./mail-limits";
import { loadReadableMessage } from "./messages";

export interface StageAttachmentUploadInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface AttachmentContent {
  readonly attachment: Attachment;
  readonly blob: BlobObject | null;
}

export function createStageAttachmentUploadUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: StageAttachmentUploadInput) => Promise<Attachment> {
  return async (viewer, input) => {
    // A staged upload costs blob storage and exists only to be attached to a
    // send, so a credential that could never send has no use for one.
    if (!authorizesAnyMailSend(viewer)) {
      throw new ForbiddenError(
        "This credential is not permitted to stage attachment uploads",
      );
    }
    if (input.bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
      throw new BadUserInputError(
        "Attachment exceeds the 5 MB size limit",
        "content",
      );
    }

    const fileName =
      input.fileName.length === 0 ? "attachment" : input.fileName;
    const contentType =
      input.contentType.length === 0
        ? "application/octet-stream"
        : input.contentType;
    const id = createAttachmentId(deps.random.uuid());
    const blobKey = buildAttachmentBlobKey(id, fileName);
    await deps.blobs.put(blobKey, input.bytes, { contentType });

    const attachment = createAttachment({
      id,
      messageId: null,
      fileName,
      contentType,
      size: input.bytes.byteLength,
      blobKey,
      contentId: null,
      inline: false,
      createdAt: deps.clock.now().toISOString(),
    });
    await deps.messageRepository.saveAttachment(attachment);
    return attachment;
  };
}

export function createReadAttachmentUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: AttachmentId,
  options: { readonly includeBody: boolean },
) => Promise<AttachmentContent> {
  return async (viewer, id, options) => {
    const attachment = await deps.messageRepository.findAttachmentById(id);
    if (attachment === null || attachment.messageId === null) {
      throw new NotFoundError("Attachment", id);
    }

    const message = await loadReadableMessage(
      deps,
      viewer,
      attachment.messageId,
    );
    if (message === null) {
      throw new NotFoundError("Attachment", id);
    }

    if (!options.includeBody) {
      return { attachment, blob: null };
    }
    const blob = await deps.blobs.get(attachment.blobKey);
    if (blob === null) {
      throw new NotFoundError("Attachment", id);
    }
    return { attachment, blob };
  };
}
