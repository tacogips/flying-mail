import type { MessageId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { deleteAttachmentsAndUnreferencedBlobs } from "./attachment-blobs";
import { loadOwnDraft } from "./drafts";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

/** Deletes a draft the viewer may send, including now-unreferenced blobs. */
export function createDeleteDraftUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MessageId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      await loadOwnDraft(deps, viewer, id);
      const attachments =
        (await deps.messageRepository.listAttachments([id])).get(id) ?? [];
      if (!(await deps.messageRepository.deleteDraftIfDraft(id))) {
        throw new NotFoundError("Draft", id);
      }
      await deleteAttachmentsAndUnreferencedBlobs(deps, attachments);
      return true;
    });
}
