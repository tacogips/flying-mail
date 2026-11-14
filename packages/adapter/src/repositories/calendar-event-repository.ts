import type {
  CalendarEventRepository,
  UtcRange,
} from "@mailcal/application/ports/calendar-event-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import { AttachmentKind } from "@mailcal/domain/entities/attachment";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import {
  createAttachmentId,
  createCalendarEventId,
  createMessageId,
} from "@mailcal/domain/value-objects/ids";
import {
  type CalendarEventRow,
  encodeOccurrenceStart,
  type EventLinkRow,
  type EventMentionRow,
  eventWriteStatements,
  rowToEvent,
} from "./calendar-event-rows";
import { assertEnumValue, buildInPlaceholders, sqlToBool } from "./sql-helpers";

interface AttachmentRow {
  readonly id: string;
  readonly message_id: string | null;
  readonly file_name: string;
  readonly content_type: string;
  readonly size: number;
  readonly blob_key: string;
  readonly content_id: string | null;
  readonly inline: number;
  readonly kind: string;
  readonly created_at: string;
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: createAttachmentId(row.id),
    messageId: row.message_id === null ? null : createMessageId(row.message_id),
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    blobKey: row.blob_key,
    contentId: row.content_id,
    inline: sqlToBool(row.inline),
    kind: assertEnumValue(AttachmentKind, row.kind, "attachment kind"),
    createdAt: row.created_at,
  };
}

export function createCalendarEventRepository(
  db: SqlDatabase,
): CalendarEventRepository {
  /** Loads the child rows for a page of events in two queries rather than
   * two per event: an event list of 400 occurrences would otherwise cost 800
   * round trips. */
  async function hydrate(
    rows: readonly CalendarEventRow[],
  ): Promise<readonly CalendarEvent[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const placeholders = buildInPlaceholders(ids.length);
    const [mentionRows, linkRows] = await Promise.all([
      db.query<EventMentionRow>(
        `SELECT event_id, address FROM event_mentions
         WHERE event_id IN (${placeholders})
         ORDER BY rowid ASC`,
        [...ids],
      ),
      db.query<EventLinkRow>(
        `SELECT id, event_id, url, title, position FROM event_links
         WHERE event_id IN (${placeholders})
         ORDER BY position ASC, id ASC`,
        [...ids],
      ),
    ]);

    const mentionsByEvent = new Map<string, string[]>();
    for (const row of mentionRows) {
      const bucket = mentionsByEvent.get(row.event_id) ?? [];
      bucket.push(row.address);
      mentionsByEvent.set(row.event_id, bucket);
    }
    const linksByEvent = new Map<string, EventLinkRow[]>();
    for (const row of linkRows) {
      const bucket = linksByEvent.get(row.event_id) ?? [];
      bucket.push(row);
      linksByEvent.set(row.event_id, bucket);
    }

    return rows.map((row) =>
      rowToEvent(
        row,
        mentionsByEvent.get(row.id) ?? [],
        linksByEvent.get(row.id) ?? [],
      ),
    );
  }

  async function queryEvents(
    sql: string,
    params: readonly (string | number | null)[],
  ): Promise<readonly CalendarEvent[]> {
    return hydrate(await db.query<CalendarEventRow>(sql, params));
  }

  return {
    async findById(id) {
      const events = await queryEvents(
        "SELECT * FROM calendar_events WHERE id = ?",
        [id],
      );
      return events[0] ?? null;
    },

    async findByUid(calendarId, uid, recurrenceInstanceStart) {
      const events = await queryEvents(
        `SELECT * FROM calendar_events
         WHERE calendar_id = ? AND uid = ?
           AND ifnull(recurrence_instance_start, '') = ?`,
        [
          calendarId,
          uid,
          recurrenceInstanceStart === null
            ? ""
            : encodeOccurrenceStart(recurrenceInstanceStart),
        ],
      );
      return events[0] ?? null;
    },

    async createEvent(event) {
      await db.batch(eventWriteStatements(event));
    },

    async updateEvent(event) {
      await db.batch(eventWriteStatements(event));
    },

    async deleteEvent(id) {
      // Mentions, links, attachment claims and the CalDAV event state row
      // all cascade (migration 0006).
      await db.execute("DELETE FROM calendar_events WHERE id = ?", [id]);
    },

    async listOverrides(parentEventId) {
      return queryEvents(
        `SELECT * FROM calendar_events WHERE override_of_event_id = ?
         ORDER BY range_start_utc ASC, id ASC`,
        [parentEventId],
      );
    },

    async listOverridesForEvents(parentEventIds) {
      if (parentEventIds.length === 0) {
        return [];
      }
      return queryEvents(
        `SELECT * FROM calendar_events
         WHERE override_of_event_id IN (${buildInPlaceholders(parentEventIds.length)})
         ORDER BY range_start_utc ASC, id ASC`,
        [...parentEventIds],
      );
    },

    /** SQL only narrows the candidate set; the domain decides which
     * occurrences actually fall in the range.
     *
     * Two disjoint cases: a non-recurring row (or an override, which is
     * stored as one) overlaps when its own bounds do, while a recurring
     * master is a candidate whenever its series window can still reach the
     * range -- `recurrence_until_utc IS NULL` means unbounded, which
     * deliberately includes every `COUNT`-bounded rule. */
    async listCandidatesInRange(calendarIds, range: UtcRange) {
      if (calendarIds.length === 0) {
        return [];
      }
      const placeholders = buildInPlaceholders(calendarIds.length);
      return queryEvents(
        `SELECT * FROM calendar_events
         WHERE calendar_id IN (${placeholders})
           AND (
             (rrule IS NULL AND range_start_utc < ? AND range_end_utc > ?)
             OR (rrule IS NOT NULL AND range_start_utc < ?
                 AND (recurrence_until_utc IS NULL OR recurrence_until_utc > ?))
           )
         ORDER BY range_start_utc ASC, id ASC`,
        [
          ...calendarIds,
          range.endUtc,
          range.startUtc,
          range.endUtc,
          range.startUtc,
        ],
      );
    },

    async listByCalendar(calendarId) {
      return queryEvents(
        `SELECT * FROM calendar_events WHERE calendar_id = ?
         ORDER BY range_start_utc ASC, id ASC`,
        [calendarId],
      );
    },

    async listByMentionAddress(address, range) {
      const rangeClause =
        range === undefined
          ? ""
          : ` AND (
               (e.rrule IS NULL AND e.range_start_utc < ? AND e.range_end_utc > ?)
               OR (e.rrule IS NOT NULL AND e.range_start_utc < ?
                   AND (e.recurrence_until_utc IS NULL OR e.recurrence_until_utc > ?))
             )`;
      const params: (string | number)[] = [address];
      if (range !== undefined) {
        params.push(range.endUtc, range.startUtc, range.endUtc, range.startUtc);
      }
      return queryEvents(
        `SELECT e.* FROM calendar_events e
         JOIN event_mentions m ON m.event_id = e.id
         WHERE m.address = ?${rangeClause}
         ORDER BY e.range_start_utc ASC, e.id ASC`,
        params,
      );
    },

    /** The `message_id IS NULL` guard is the claim rule: an attachment that
     * already belongs to a message is mail data, and an event must not be
     * able to borrow it and thereby inherit its authorization. */
    async attachAttachment(eventId, attachmentId, position, createdAt) {
      const claimed = await db.query<{ event_id: string }>(
        "SELECT event_id FROM event_attachments WHERE attachment_id = ?",
        [attachmentId],
      );
      const existingClaim = claimed[0]?.event_id;
      if (existingClaim === (eventId as string)) {
        // Re-claiming for the same event is a no-op, so a retried mutation
        // does not fail on the primary key.
        return;
      }
      if (existingClaim !== undefined) {
        throw new Error(
          `attachment ${attachmentId} is already claimed by event ${existingClaim}`,
        );
      }
      const result = await db.execute(
        `INSERT INTO event_attachments (event_id, attachment_id, position, created_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM attachments WHERE id = ? AND message_id IS NULL
         )`,
        [eventId, attachmentId, position, createdAt, attachmentId],
      );
      if (result.rowsAffected === 0) {
        throw new Error(
          `attachment ${attachmentId} is not an unclaimed staged upload`,
        );
      }
    },

    async detachAttachment(eventId, attachmentId) {
      const result = await db.execute(
        "DELETE FROM event_attachments WHERE event_id = ? AND attachment_id = ?",
        [eventId, attachmentId],
      );
      return result.rowsAffected > 0;
    },

    async listAttachments(eventId) {
      const rows = await db.query<AttachmentRow>(
        `SELECT a.* FROM attachments a
         JOIN event_attachments ea ON ea.attachment_id = a.id
         WHERE ea.event_id = ?
         ORDER BY ea.position ASC, a.id ASC`,
        [eventId],
      );
      return rows.map(rowToAttachment);
    },

    async listAttachmentsForEvents(eventIds) {
      const byEvent = new Map<string, readonly Attachment[]>(
        eventIds.map((id) => [id as string, []]),
      );
      if (eventIds.length === 0) {
        return byEvent;
      }
      const rows = await db.query<AttachmentRow & { event_id: string }>(
        `SELECT a.*, ea.event_id AS event_id FROM attachments a
         JOIN event_attachments ea ON ea.attachment_id = a.id
         WHERE ea.event_id IN (${buildInPlaceholders(eventIds.length)})
         ORDER BY ea.position ASC, a.id ASC`,
        [...eventIds],
      );
      const buckets = new Map<string, Attachment[]>();
      for (const row of rows) {
        const bucket = buckets.get(row.event_id) ?? [];
        bucket.push(rowToAttachment(row));
        buckets.set(row.event_id, bucket);
      }
      for (const [eventId, attachments] of buckets) {
        byEvent.set(eventId, attachments);
      }
      return byEvent;
    },

    async findEventIdsByAttachment(attachmentId) {
      const rows = await db.query<{ event_id: string }>(
        "SELECT event_id FROM event_attachments WHERE attachment_id = ?",
        [attachmentId],
      );
      return rows.map((row) => createCalendarEventId(row.event_id));
    },
  };
}
