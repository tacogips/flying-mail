import { Capability } from "@flying-mail/domain/entities/api-key";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import { SystemTagSlug } from "@flying-mail/domain/entities/tag";
import type { MessageId } from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ServiceUnavailableError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { assertIdCountWithinLimit } from "./id-limits";
import { loadReadableMessages } from "./messages";
import { recordMailEvents } from "./mail-events";

/** Move readable, manageable messages to Trash without ever purging them. */
export function createTrashMessagesUseCase(
  deps: AppDependencies,
): (viewer: Viewer, ids: readonly MessageId[]) => Promise<number> {
  return async (viewer, ids) => {
    assertIdCountWithinLimit(ids, "ids");
    const messages = await loadReadableMessages(
      deps,
      viewer,
      ids,
      Capability.MailManage,
    );
    if (messages.length === 0) {
      return 0;
    }

    const trashTag = await deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    if (trashTag === null) {
      throw new ServiceUnavailableError("The Trash system tag is missing");
    }

    const idsToCheck = messages.map((message) => message.id);
    const tagsByMessage = await deps.messageRepository.listTagIds(idsToCheck);
    const newlyTrashed = messages.filter(
      (message) => !(tagsByMessage.get(message.id) ?? []).includes(trashTag.id),
    );
    if (newlyTrashed.length > 0) {
      await deps.messageRepository.addTags(
        newlyTrashed.map((message) => message.id),
        [trashTag.id],
        deps.clock.now().toISOString(),
      );
      await recordMailEvents(
        deps,
        newlyTrashed.map((message) => ({
          type: MailEventType.MessageUpdated,
          message,
        })),
      );
    }
    return messages.length;
  };
}
