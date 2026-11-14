import type { Attachment } from "@mailcal/domain/entities/attachment";
import type {
  CalendarEvent,
  OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import type {
  AttachmentId,
  CalendarEventId,
  CalendarId,
} from "@mailcal/domain/value-objects/ids";

/** An inclusive-exclusive UTC window, in epoch milliseconds. */
export interface UtcRange {
  readonly startUtc: number;
  readonly endUtc: number;
}

export interface CalendarEventRepository {
  findById(id: CalendarEventId): Promise<CalendarEvent | null>;
  /** CalDAV maps remote objects to local rows by `(UID, RECURRENCE-ID)`
   * within one collection, which is exactly this lookup. */
  findByUid(
    calendarId: CalendarId,
    uid: string,
    recurrenceInstanceStart: OccurrenceStart | null,
  ): Promise<CalendarEvent | null>;
  /** Writes the event row together with its mentions and links in a single
   * `batch()`. D1 has no interactive transactions, so a multi-row write that
   * must not tear has to be one batch. */
  createEvent(event: CalendarEvent): Promise<void>;
  updateEvent(event: CalendarEvent): Promise<void>;
  deleteEvent(id: CalendarEventId): Promise<void>;
  listOverrides(
    parentEventId: CalendarEventId,
  ): Promise<readonly CalendarEvent[]>;
  listOverridesForEvents(
    parentEventIds: readonly CalendarEventId[],
  ): Promise<readonly CalendarEvent[]>;
  /** Rows that *may* produce an occurrence inside the range: non-recurring
   * events whose own bounds overlap it, plus recurring masters whose window
   * (`range_start_utc` .. `recurrence_until_utc`, null = unbounded) does.
   * The domain then expands them; SQL only narrows the candidate set. */
  listCandidatesInRange(
    calendarIds: readonly CalendarId[],
    range: UtcRange,
  ): Promise<readonly CalendarEvent[]>;
  listByCalendar(calendarId: CalendarId): Promise<readonly CalendarEvent[]>;
  /** Index scan on `event_mentions.address`. */
  listByMentionAddress(
    address: EmailAddress,
    range?: UtcRange,
  ): Promise<readonly CalendarEvent[]>;

  attachAttachment(
    eventId: CalendarEventId,
    attachmentId: AttachmentId,
    position: number,
    createdAt: string,
  ): Promise<void>;
  detachAttachment(
    eventId: CalendarEventId,
    attachmentId: AttachmentId,
  ): Promise<boolean>;
  listAttachments(eventId: CalendarEventId): Promise<readonly Attachment[]>;
  listAttachmentsForEvents(
    eventIds: readonly CalendarEventId[],
  ): Promise<ReadonlyMap<string, readonly Attachment[]>>;
  /** Which events claim an attachment. Used by the download route to decide
   * whether an attachment is authorized through an event rather than a
   * message. */
  findEventIdsByAttachment(
    attachmentId: AttachmentId,
  ): Promise<readonly CalendarEventId[]>;
}
