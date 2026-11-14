import type { SqlStatement } from "@mailcal/application/ports/sql-database";
import {
  type CalendarEvent,
  type EventLink,
  eventTimeBoundsUtc,
  type EventTime,
  type OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createCalendarEventId,
  createCalendarId,
  createEventLinkId,
} from "@mailcal/domain/value-objects/ids";
import { createIsoDate } from "@mailcal/domain/value-objects/iso-date";
import {
  formatRecurrenceRule,
  parseRecurrenceRule,
  type RecurrenceRule,
} from "@mailcal/domain/value-objects/recurrence";
import { createTimeZoneId } from "@mailcal/domain/value-objects/time-zone";

/** Row <-> entity mapping for `calendar_events` and its two child tables.
 *
 * Kept beside the repository rather than inside it so the repository file
 * stays about queries, and so the denormalized `range_*` columns are derived
 * in exactly one place. */

export interface CalendarEventRow {
  readonly id: string;
  readonly calendar_id: string;
  readonly uid: string;
  readonly all_day: number;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly time_zone: string | null;
  readonly start_date: string | null;
  readonly end_date_exclusive: string | null;
  readonly range_start_utc: number;
  readonly range_end_utc: number;
  readonly rrule: string | null;
  readonly exdates_json: string;
  readonly recurrence_until_utc: number | null;
  readonly override_of_event_id: string | null;
  readonly recurrence_instance_start: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EventMentionRow {
  readonly event_id: string;
  readonly address: string;
}

export interface EventLinkRow {
  readonly id: string;
  readonly event_id: string;
  readonly url: string;
  readonly title: string | null;
  readonly position: number;
}

function rowToTime(row: CalendarEventRow): EventTime {
  if (row.all_day === 1) {
    if (row.start_date === null || row.end_date_exclusive === null) {
      throw new Error(`calendar event ${row.id} is all-day without dates`);
    }
    return {
      kind: "ALL_DAY",
      startDate: createIsoDate(row.start_date, "startDate"),
      endDateExclusive: createIsoDate(
        row.end_date_exclusive,
        "endDateExclusive",
      ),
    };
  }
  if (
    row.starts_at === null ||
    row.ends_at === null ||
    row.time_zone === null
  ) {
    throw new Error(`calendar event ${row.id} is timed without instants`);
  }
  return {
    kind: "TIMED",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timeZone: createTimeZoneId(row.time_zone),
  };
}

/** `recurrence_instance_start` is a single TEXT column for both event
 * shapes: an `IsoDate` for an all-day series, the epoch-ms decimal string
 * for a timed one. One column keeps the `(calendar_id, uid, instance)`
 * unique index -- the thing CalDAV maps objects by -- a single index. */
function decodeOccurrenceStart(
  value: string,
  time: EventTime,
): OccurrenceStart {
  return time.kind === "ALL_DAY"
    ? createIsoDate(value, "recurrenceInstanceStart")
    : Number(value);
}

export function encodeOccurrenceStart(value: OccurrenceStart): string {
  return String(value);
}

function decodeExdates(
  json: string,
  time: EventTime,
): readonly OccurrenceStart[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const result: OccurrenceStart[] = [];
  for (const entry of parsed) {
    if (time.kind === "ALL_DAY") {
      if (typeof entry === "string") {
        result.push(createIsoDate(entry, "exdates"));
      }
      continue;
    }
    if (typeof entry === "number") {
      result.push(entry);
    }
  }
  return result;
}

export function rowToEvent(
  row: CalendarEventRow,
  mentions: readonly string[],
  links: readonly EventLinkRow[],
): CalendarEvent {
  const time = rowToTime(row);
  let recurrence: RecurrenceRule | null = null;
  if (row.rrule !== null) {
    // Only rules mailcal itself wrote reach this column, so a parse failure
    // means the row is corrupt rather than merely foreign -- but dropping
    // the rule loses occurrences silently, so it is loud.
    recurrence = parseRecurrenceRule(row.rrule);
    if (recurrence === null) {
      throw new Error(
        `calendar event ${row.id} carries an unparsable RRULE: ${row.rrule}`,
      );
    }
  }
  return {
    id: createCalendarEventId(row.id),
    calendarId: createCalendarId(row.calendar_id),
    uid: row.uid,
    title: row.title,
    description: row.description,
    location: row.location,
    time,
    recurrence,
    exdates: decodeExdates(row.exdates_json, time),
    overrideOf:
      row.override_of_event_id === null ||
      row.recurrence_instance_start === null
        ? null
        : {
            parentEventId: createCalendarEventId(row.override_of_event_id),
            recurrenceInstanceStart: decodeOccurrenceStart(
              row.recurrence_instance_start,
              time,
            ),
          },
    mentions: mentions.map((address) => createEmailAddress(address)),
    links: links
      .slice()
      .sort((left, right) => left.position - right.position)
      .map(
        (link): EventLink => ({
          id: createEventLinkId(link.id),
          url: link.url,
          title: link.title,
          position: link.position,
        }),
      ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Upper bound on when this event can still produce an occurrence, or `null`
 * for "unbounded".
 *
 * `UNTIL` bounds an occurrence's *start*, so the event's own duration is
 * added: a weekly two-hour meeting ending `UNTIL` Friday 09:00 still overlaps
 * a range that begins Friday 10:00. A `COUNT`-bounded rule is stored as
 * unbounded rather than expanded here -- the candidate query would then be
 * merely less selective, never wrong. */
function recurrenceUntilUtc(
  recurrence: RecurrenceRule | null,
  bounds: { readonly startUtc: number; readonly endUtc: number },
): number | null {
  if (recurrence === null || recurrence.untilUtc === undefined) {
    return null;
  }
  return recurrence.untilUtc + (bounds.endUtc - bounds.startUtc);
}

const UPSERT_EVENT_SQL = `INSERT INTO calendar_events
  (id, calendar_id, uid, all_day, starts_at, ends_at, time_zone,
   start_date, end_date_exclusive, range_start_utc, range_end_utc,
   rrule, exdates_json, recurrence_until_utc, override_of_event_id,
   recurrence_instance_start, title, description, location,
   created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    calendar_id = excluded.calendar_id,
    uid = excluded.uid,
    all_day = excluded.all_day,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    time_zone = excluded.time_zone,
    start_date = excluded.start_date,
    end_date_exclusive = excluded.end_date_exclusive,
    range_start_utc = excluded.range_start_utc,
    range_end_utc = excluded.range_end_utc,
    rrule = excluded.rrule,
    exdates_json = excluded.exdates_json,
    recurrence_until_utc = excluded.recurrence_until_utc,
    override_of_event_id = excluded.override_of_event_id,
    recurrence_instance_start = excluded.recurrence_instance_start,
    title = excluded.title,
    description = excluded.description,
    location = excluded.location,
    updated_at = excluded.updated_at`;

/** The event row plus its mentions and links as one ordered statement list.
 *
 * D1 has no interactive transactions, so a write that must not tear has to
 * be a single `batch()`. Children are deleted then re-inserted rather than
 * diffed: the sets are small, and a full replace cannot leave a stale row
 * behind when a mention is removed. */
export function eventWriteStatements(
  event: CalendarEvent,
): readonly SqlStatement[] {
  const bounds = eventTimeBoundsUtc(event.time);
  const timed = event.time.kind === "TIMED" ? event.time : null;
  const allDay = event.time.kind === "ALL_DAY" ? event.time : null;

  const statements: SqlStatement[] = [
    {
      sql: UPSERT_EVENT_SQL,
      params: [
        event.id,
        event.calendarId,
        event.uid,
        allDay === null ? 0 : 1,
        timed?.startsAt ?? null,
        timed?.endsAt ?? null,
        timed?.timeZone ?? null,
        allDay?.startDate ?? null,
        allDay?.endDateExclusive ?? null,
        bounds.startUtc,
        bounds.endUtc,
        event.recurrence === null
          ? null
          : formatRecurrenceRule(event.recurrence),
        JSON.stringify(event.exdates),
        recurrenceUntilUtc(event.recurrence, bounds),
        event.overrideOf?.parentEventId ?? null,
        event.overrideOf === null
          ? null
          : encodeOccurrenceStart(event.overrideOf.recurrenceInstanceStart),
        event.title,
        event.description,
        event.location,
        event.createdAt,
        event.updatedAt,
      ],
    },
    {
      sql: "DELETE FROM event_mentions WHERE event_id = ?",
      params: [event.id],
    },
    { sql: "DELETE FROM event_links WHERE event_id = ?", params: [event.id] },
  ];

  for (const mention of event.mentions) {
    statements.push({
      sql: `INSERT INTO event_mentions (event_id, address, created_at)
            VALUES (?, ?, ?)`,
      params: [event.id, mention, event.updatedAt],
    });
  }
  for (const link of event.links) {
    statements.push({
      sql: `INSERT INTO event_links (id, event_id, url, title, position)
            VALUES (?, ?, ?, ?, ?)`,
      params: [link.id, event.id, link.url, link.title, link.position],
    });
  }
  return statements;
}
