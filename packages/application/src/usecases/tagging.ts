import { Capability } from "@mailcal/domain/entities/api-key";
import type { Message } from "@mailcal/domain/entities/message";
import {
  createSpamMark,
  SpamMarkedBy,
} from "@mailcal/domain/entities/spam-mark";
import type { Tag } from "@mailcal/domain/entities/tag";
import type { MessageId, TagId } from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { loadReadableMessages } from "./messages";

async function requireTags(
  deps: AppDependencies,
  tagIds: readonly TagId[],
): Promise<readonly Tag[]> {
  const found = await deps.tagRepository.findByIds(tagIds);
  const foundIds = new Set<string>(found.map((tag) => tag.id));
  for (const tagId of tagIds) {
    if (!foundIds.has(tagId)) {
      throw new NotFoundError("Tag", tagId);
    }
  }
  return found;
}

async function applyTags(
  deps: AppDependencies,
  viewer: Viewer,
  messageIds: readonly MessageId[],
  tagIds: readonly TagId[],
  add: boolean,
): Promise<readonly Message[]> {
  const messages = await loadReadableMessages(
    deps,
    viewer,
    messageIds,
    Capability.MailManage,
  );
  if (messages.length === 0 || tagIds.length === 0) {
    return messages;
  }
  const ids = messages.map((message) => message.id);
  if (add) {
    await deps.messageRepository.addTags(
      ids,
      tagIds,
      deps.clock.now().toISOString(),
    );
  } else {
    await deps.messageRepository.removeTags(ids, tagIds);
  }
  return messages;
}

export function createTagMessagesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  messageIds: readonly MessageId[],
  tagIds: readonly TagId[],
) => Promise<readonly Message[]> {
  return async (viewer, messageIds, tagIds) => {
    await requireTags(deps, tagIds);
    return applyTags(deps, viewer, messageIds, tagIds, true);
  };
}

export function createUntagMessagesUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  messageIds: readonly MessageId[],
  tagIds: readonly TagId[],
) => Promise<readonly Message[]> {
  return async (viewer, messageIds, tagIds) => {
    await requireTags(deps, tagIds);
    return applyTags(deps, viewer, messageIds, tagIds, false);
  };
}

/** A hand mark writes a `USER` spam verdict row -- no score, since no
 * scorer ran. Marking already-marked messages simply refreshes the mark. */
export function createMarkSpamUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  messageIds: readonly MessageId[],
) => Promise<readonly Message[]> {
  return async (viewer, messageIds) => {
    const messages = await loadReadableMessages(
      deps,
      viewer,
      messageIds,
      Capability.MailManage,
    );
    const markedAt = deps.clock.now().toISOString();
    await deps.messageRepository.setSpamMarks(
      messages.map((message) =>
        createSpamMark({
          messageId: message.id,
          score: null,
          markedBy: SpamMarkedBy.User,
          markedAt,
        }),
      ),
    );
    return messages;
  };
}

export function createMarkNotSpamUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  messageIds: readonly MessageId[],
) => Promise<readonly Message[]> {
  return async (viewer, messageIds) => {
    const messages = await loadReadableMessages(
      deps,
      viewer,
      messageIds,
      Capability.MailManage,
    );
    await deps.messageRepository.clearSpamMarks(
      messages.map((message) => message.id),
    );
    return messages;
  };
}
