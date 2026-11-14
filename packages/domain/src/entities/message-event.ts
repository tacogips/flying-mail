import { ValidationError } from "../errors";
import type { MessageEventId, MessageId } from "../value-objects/ids";

/** What kind of obligation or note an event records against a message.
 * The canonical example: mail that needs an answer by 10/1 carries a
 * `DEADLINE` event with `dueAt` 10/1 and title "reply". */
export enum MessageEventKind {
  Deadline = "DEADLINE",
  Reminder = "REMINDER",
  FollowUp = "FOLLOW_UP",
  Other = "OTHER",
}

/** An event attached to a message. A message can carry any number of
 * them; completing one records when, so an agenda view can show both the
 * open obligations and what was already handled. */
export interface MessageEvent {
  readonly id: MessageEventId;
  readonly messageId: MessageId;
  readonly kind: MessageEventKind;
  /** When the event falls due, ISO 8601. Null for undated notes -- valid
   * for every kind except `DEADLINE`, which is meaningless without one. */
  readonly dueAt: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMessageEventInput {
  readonly id: MessageEventId;
  readonly messageId: MessageId;
  readonly kind: MessageEventKind;
  readonly dueAt: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly createdAt: string;
}

const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_LENGTH = 2000;

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("event title must not be empty", "title");
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `event title must be at most ${MAX_TITLE_LENGTH} characters`,
      "title",
    );
  }
  return trimmed;
}

function normalizeNote(note: string | null): string | null {
  if (note === null) {
    return null;
  }
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new ValidationError(
      `event note must be at most ${MAX_NOTE_LENGTH} characters`,
      "note",
    );
  }
  return trimmed;
}

function assertDueAt(kind: MessageEventKind, dueAt: string | null): void {
  if (dueAt === null) {
    if (kind === MessageEventKind.Deadline) {
      throw new ValidationError("a DEADLINE event requires dueAt", "dueAt");
    }
    return;
  }
  if (Number.isNaN(Date.parse(dueAt))) {
    throw new ValidationError("dueAt must be an ISO 8601 timestamp", "dueAt");
  }
}

export function createMessageEvent(
  input: CreateMessageEventInput,
): MessageEvent {
  assertDueAt(input.kind, input.dueAt);
  return {
    id: input.id,
    messageId: input.messageId,
    kind: input.kind,
    dueAt: input.dueAt,
    title: normalizeTitle(input.title),
    note: normalizeNote(input.note),
    completedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export interface UpdateMessageEventPatch {
  readonly kind?: MessageEventKind;
  readonly dueAt?: string | null;
  readonly title?: string;
  readonly note?: string | null;
}

export function updateMessageEvent(
  event: MessageEvent,
  patch: UpdateMessageEventPatch,
  at: string,
): MessageEvent {
  const kind = patch.kind ?? event.kind;
  const dueAt = patch.dueAt === undefined ? event.dueAt : patch.dueAt;
  assertDueAt(kind, dueAt);
  return {
    ...event,
    kind,
    dueAt,
    title:
      patch.title === undefined ? event.title : normalizeTitle(patch.title),
    note: patch.note === undefined ? event.note : normalizeNote(patch.note),
    updatedAt: at,
  };
}

/** Completing twice is a no-op rather than an error: two clients racing a
 * checkbox should converge, not fail. Same for reopening. */
export function setMessageEventCompleted(
  event: MessageEvent,
  completed: boolean,
  at: string,
): MessageEvent {
  if (completed === (event.completedAt !== null)) {
    return event;
  }
  return {
    ...event,
    completedAt: completed ? at : null,
    updatedAt: at,
  };
}
