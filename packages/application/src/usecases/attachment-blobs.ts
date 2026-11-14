import type { AppDependencies } from "../dependencies";
import type { Attachment } from "@flying-mail/domain/entities/attachment";

type AttachmentBlobDependencies = Pick<
  AppDependencies,
  "messageRepository" | "blobs"
>;

/** Deletes attachment rows first, then removes blobs with no remaining row references. */
export async function deleteAttachmentsAndUnreferencedBlobs(
  deps: AttachmentBlobDependencies,
  attachments: readonly Attachment[],
): Promise<void> {
  await deps.messageRepository.deleteAttachments(
    attachments.map(({ id }) => id),
  );
  await deleteUnreferencedBlobs(deps, [
    ...new Set(attachments.map(({ blobKey }) => blobKey)),
  ]);
}

/** Deletes only blobs that have no attachment rows, leaving a safe orphan if storage deletion fails. */
export async function deleteUnreferencedBlobs(
  deps: AttachmentBlobDependencies,
  blobKeys: readonly string[],
): Promise<void> {
  const uniqueKeys = [...new Set(blobKeys)];
  const references =
    await deps.messageRepository.countAttachmentsByBlobKeys(uniqueKeys);
  await Promise.all(
    uniqueKeys
      .filter((key) => (references.get(key) ?? 0) === 0)
      .map((key) => deps.blobs.delete(key).catch(() => undefined)),
  );
}
