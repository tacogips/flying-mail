import type {
  CalendarEvent,
  EventTime,
  OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import { createIsoDate } from "@mailcal/domain/value-objects/iso-date";
import {
  createRecurrenceRule,
  type RecurrenceFrequency,
  type RecurrenceRule,
  type Weekday,
} from "@mailcal/domain/value-objects/recurrence";
import { createTimeZoneId } from "@mailcal/domain/value-objects/time-zone";
import { BadUserInputError } from "../errors";

/** Transport-shaped inputs (ISO strings, plain objects) and their mapping
 * onto domain value objects. Kept out of the use-case files so those stay
 * about behavior rather than parsing. */

export interface EventTimeInput {
  readonly allDay: boolean;
  /** ISO 8601 instant, required when `allDay` is false. */
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly timeZone?: string | null;
  /** `YYYY-MM-DD`, required when `allDay` is true. */
  readonly startDate?: string | null;
  readonly endDateExclusive?: string | null;
}

export interface RecurrenceRuleUseCaseInput {
  readonly freq: RecurrenceFrequency;
  readonly interval?: number | null;
  readonly count?: number | null;
  readonly until?: string | null;
  readonly byDay?: readonly Weekday[] | null;
  readonly byMonthDay?: readonly number[] | null;
  readonly byMonth?: readonly number[] | null;
  readonly weekStart?: Weekday | null;
}

export interface EventLinkUseCaseInput {
  readonly url: string;
  readonly title?: string | null;
}

function requireInstant(
  value: string | null | undefined,
  field: string,
): number {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new BadUserInputError(`${field} is required`, field);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new BadUserInputError(
      `${field} must be an ISO 8601 timestamp`,
      field,
    );
  }
  return parsed;
}

function requireDate(value: string | null | undefined, field: string): string {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new BadUserInputError(`${field} is required`, field);
  }
  return value.trim();
}

export function toEventTime(input: EventTimeInput): EventTime {
  if (input.allDay) {
    return {
      kind: "ALL_DAY",
      startDate: createIsoDate(
        requireDate(input.startDate, "startDate"),
        "startDate",
      ),
      endDateExclusive: createIsoDate(
        requireDate(input.endDateExclusive, "endDateExclusive"),
        "endDateExclusive",
      ),
    };
  }
  return {
    kind: "TIMED",
    startsAt: requireInstant(input.startsAt, "startsAt"),
    endsAt: requireInstant(input.endsAt, "endsAt"),
    // Defaults to UTC rather than the server's zone: a server-local default
    // would make the same payload mean different things per deployment.
    timeZone: createTimeZoneId(
      input.timeZone === null || input.timeZone === undefined
        ? "UTC"
        : input.timeZone,
    ),
  };
}

export function toRecurrenceRule(
  input: RecurrenceRuleUseCaseInput | null | undefined,
): RecurrenceRule | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (input.count != null && input.until != null) {
    throw new BadUserInputError(
      "recurrence count and until are mutually exclusive",
      "recurrence",
    );
  }
  const untilUtc =
    input.until == null ? undefined : requireInstant(input.until, "until");
  return createRecurrenceRule({
    freq: input.freq,
    ...(input.interval == null ? {} : { interval: input.interval }),
    ...(input.count == null ? {} : { count: input.count }),
    ...(untilUtc === undefined ? {} : { untilUtc }),
    ...(input.byDay == null ? {} : { byDay: input.byDay }),
    ...(input.byMonthDay == null ? {} : { byMonthDay: input.byMonthDay }),
    ...(input.byMonth == null ? {} : { byMonth: input.byMonth }),
    ...(input.weekStart == null ? {} : { weekStart: input.weekStart }),
  });
}

/** Parses the client's identifier for one occurrence of a series. Timed
 * series address instances by instant, all-day ones by date -- the same
 * split `RECURRENCE-ID` makes. */
export function toOccurrenceStart(
  value: string,
  time: CalendarEvent["time"],
  field = "occurrenceStart",
): OccurrenceStart {
  if (time.kind === "ALL_DAY") {
    return createIsoDate(value.trim(), field);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new BadUserInputError(
      `${field} must be an ISO 8601 timestamp`,
      field,
    );
  }
  return parsed;
}

export function formatOccurrenceStart(value: OccurrenceStart): string {
  return typeof value === "number" ? new Date(value).toISOString() : value;
}
