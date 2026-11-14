import { Capability } from "@flying-mail/domain/entities/api-key";
import { MailStatus, type Message } from "@flying-mail/domain/entities/message";
import { authorizesAnyAddress } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";

/** Whether `viewer` may see and edit this draft. Drafts are private to
 * whoever could send as the draft's `From` address: being a listed recipient
 * (or holding read access to a recipient mailbox) must not reveal unsent
 * content, including secret Bcc recipients. Lives in its own module so the
 * message read path can use it without importing the send pipeline. */
export function hasDraftAuthority(viewer: Viewer, draft: Message): boolean {
  return authorizesAnyAddress(viewer, Capability.MailSend, draft.domainId, [
    draft.fromAddress,
  ]);
}

/** Read-path gate: non-drafts pass through; a draft is visible only to a
 * viewer with draft authority for it. */
export function isVisibleDraftOrMessage(
  viewer: Viewer,
  message: Message,
): boolean {
  return (
    message.status !== MailStatus.Draft || hasDraftAuthority(viewer, message)
  );
}
