import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import type { MessageId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { deleteAttachmentsAndUnreferencedBlobs } from "./attachment-blobs";
import { loadOwnDraft } from "./drafts";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";
import { collectMailEventAddresses, recordMailEvents } from "./mail-events";

/** Deletes a draft the viewer may send, including now-unreferenced blobs. */
export function createDeleteDraftUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MessageId) => Promise<boolean> {
  return async (viewer, id) =>
    withAsyncDomainErrorTranslation(async () => {
      const draft = await loadOwnDraft(deps, viewer, id);
      const addressesByMessage = await collectMailEventAddresses(deps, [draft]);
      const addresses = addressesByMessage.get(draft.id) ?? [];
      const attachments =
        (await deps.messageRepository.listAttachments([id])).get(id) ?? [];
      if (!(await deps.messageRepository.deleteDraftIfDraft(id))) {
        throw new NotFoundError("Draft", id);
      }
      await recordMailEvents(deps, [
        { type: MailEventType.DraftDeleted, message: draft, addresses },
      ]);
      await deleteAttachmentsAndUnreferencedBlobs(deps, attachments);
      return true;
    });
}
