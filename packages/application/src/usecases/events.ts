import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMessageEvent,
  type MessageEvent,
  type MessageEventKind,
  setMessageEventCompleted,
  updateMessageEvent,
} from "@mailcal/domain/entities/message-event";
import {
  createMessageEventId,
  type MessageEventId,
  type MessageId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import {
  mailPermissionListFilter,
  readableAddressPatterns,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import { loadReadableMessages } from "./messages";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface CreateMessageEventInput {
  readonly messageId: MessageId;
  readonly kind: MessageEventKind;
  readonly dueAt?: string | null;
  readonly title: string;
  readonly note?: string | null;
}

export interface UpdateMessageEventInput {
  readonly kind?: MessageEventKind;
  readonly dueAt?: string | null;
  readonly title?: string;
  readonly note?: string | null;
  readonly completed?: boolean;
}

export interface ListMessageEventsInput {
  readonly dueBefore?: string;
  readonly dueAfter?: string;
  readonly includeCompleted?: boolean;
  readonly limit?: number;
}

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

/** Writing an event requires MAIL_MANAGE on the message, mirroring tags;
 * an event is an annotation on mail, and the same scope that may tag mail
 * may schedule follow-ups on it. Reads come scoped through the message
 * allowlist exactly like message listings. */
async function requireManageableMessage(
  deps: AppDependencies,
  viewer: Viewer,
  messageId: MessageId,
): Promise<void> {
  const messages = await loadReadableMessages(
    deps,
    viewer,
    [messageId],
    Capability.MailManage,
  );
  if (messages.length === 0) {
    throw new NotFoundError("Message", messageId);
  }
}

/** Loads an event and proves the viewer may manage its message; the
 * uniform NOT_FOUND (never FORBIDDEN) keeps event ids unprobeable. */
async function loadOwnEvent(
  deps: AppDependencies,
  viewer: Viewer,
  id: MessageEventId,
): Promise<MessageEvent> {
  const event = await deps.messageEventRepository.findById(id);
  if (event === null) {
    throw new NotFoundError("MessageEvent", id);
  }
  await requireManageableMessage(deps, viewer, event.messageId);
  return event;
}

export function createCreateMessageEventUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateMessageEventInput) => Promise<MessageEvent> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      await requireManageableMessage(deps, viewer, input.messageId);
      const event = createMessageEvent({
        id: createMessageEventId(deps.random.uuid()),
        messageId: input.messageId,
        kind: input.kind,
        dueAt: input.dueAt ?? null,
        title: input.title,
        note: input.note ?? null,
        createdAt: deps.clock.now().toISOString(),
      });
      await deps.messageEventRepository.save(event);
      return event;
    });
}

export function createUpdateMessageEventUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: MessageEventId,
  input: UpdateMessageEventInput,
) => Promise<MessageEvent> {
  return async (viewer, id, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const existing = await loadOwnEvent(deps, viewer, id);
      const now = deps.clock.now().toISOString();
      let event = updateMessageEvent(
        existing,
        {
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.note === undefined ? {} : { note: input.note }),
        },
        now,
      );
      if (input.completed !== undefined) {
        event = setMessageEventCompleted(event, input.completed, now);
      }
      await deps.messageEventRepository.save(event);
      return event;
    });
}

export function createDeleteMessageEventUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: MessageEventId) => Promise<boolean> {
  return async (viewer, id) => {
    const event = await loadOwnEvent(deps, viewer, id);
    await deps.messageEventRepository.delete(event.id);
    return true;
  };
}

export function createListMessageEventsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: ListMessageEventsInput,
) => Promise<readonly MessageEvent[]> {
  return async (viewer, input) => {
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_EVENT_LIMIT, 1),
      MAX_EVENT_LIMIT,
    );
    const allowedPatterns = readableAddressPatterns(
      viewer,
      Capability.MailRead,
    );
    const mailPermissionFilter = mailPermissionListFilter(
      viewer,
      Capability.MailRead,
    );
    return deps.messageEventRepository.list(
      {
        ...(input.dueBefore === undefined
          ? {}
          : { dueBefore: input.dueBefore }),
        ...(input.dueAfter === undefined ? {} : { dueAfter: input.dueAfter }),
        ...(input.includeCompleted === undefined
          ? {}
          : { includeCompleted: input.includeCompleted }),
        allowedPatterns,
        mailPermissionFilter,
      },
      limit,
    );
  };
}

/** Batch loader body for `Message.events`. */
export function createListEventsByMessagesUseCase(
  deps: AppDependencies,
): (
  ids: readonly MessageId[],
) => Promise<ReadonlyMap<string, readonly MessageEvent[]>> {
  return async (ids) => deps.messageEventRepository.listByMessages(ids);
}
