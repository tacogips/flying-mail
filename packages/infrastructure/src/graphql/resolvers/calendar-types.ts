import type { EventOccurrenceView } from "@mailcal/application/usecases/calendar-events";
import { formatOccurrenceStart } from "@mailcal/application/usecases/calendar-event-inputs";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import type { RecurrenceRule } from "@mailcal/domain/value-objects/recurrence";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

/** Field resolvers for the calendar types, plus the entity -> transport
 * mapping the query and mutation modules share.
 *
 * Everything here is either plain property access or a shape change; no
 * resolver reaches past `ctx.usecases`. */

export interface EventTimeView {
  readonly allDay: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timeZone: string | null;
  readonly startDate: string | null;
  readonly endDateExclusive: string | null;
}

export function toEventTimeView(event: CalendarEvent): EventTimeView {
  if (event.time.kind === "ALL_DAY") {
    return {
      allDay: true,
      startsAt: null,
      endsAt: null,
      timeZone: null,
      startDate: event.time.startDate,
      endDateExclusive: event.time.endDateExclusive,
    };
  }
  return {
    allDay: false,
    startsAt: new Date(event.time.startsAt).toISOString(),
    endsAt: new Date(event.time.endsAt).toISOString(),
    timeZone: event.time.timeZone,
    startDate: null,
    endDateExclusive: null,
  };
}

export interface RecurrenceRuleView {
  readonly freq: RecurrenceRule["freq"];
  readonly interval: number;
  readonly count: number | null;
  readonly until: string | null;
  readonly byDay: readonly string[] | null;
  readonly byMonthDay: readonly number[] | null;
  readonly byMonth: readonly number[] | null;
  readonly weekStart: string;
}

export function toRecurrenceRuleView(
  rule: RecurrenceRule | null,
): RecurrenceRuleView | null {
  if (rule === null) {
    return null;
  }
  return {
    freq: rule.freq,
    interval: rule.interval,
    count: rule.count ?? null,
    until:
      rule.untilUtc === undefined
        ? null
        : new Date(rule.untilUtc).toISOString(),
    byDay: rule.byDay ?? null,
    byMonthDay: rule.byMonthDay ?? null,
    byMonth: rule.byMonth ?? null,
    weekStart: rule.weekStart,
  };
}

export const calendarEventResolvers = {
  calendarId(event: CalendarEvent): string {
    return event.calendarId;
  },
  /** Loaded through the use case rather than the repository, so a viewer
   * that may read the event but not its calendar simply gets `null`. */
  async calendar(
    event: CalendarEvent,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<Calendar | null> {
    return ctx.usecases.getCalendar(
      requireViewerOrThrow(ctx),
      event.calendarId,
    );
  },
  time(event: CalendarEvent): EventTimeView {
    return toEventTimeView(event);
  },
  recurrence(event: CalendarEvent): RecurrenceRuleView | null {
    return toRecurrenceRuleView(event.recurrence);
  },
  exdates(event: CalendarEvent): readonly string[] {
    return event.exdates.map(formatOccurrenceStart);
  },
  overrideOfEventId(event: CalendarEvent): string | null {
    return event.overrideOf?.parentEventId ?? null;
  },
  recurrenceInstanceStart(event: CalendarEvent): string | null {
    return event.overrideOf === null
      ? null
      : formatOccurrenceStart(event.overrideOf.recurrenceInstanceStart);
  },
  mentions(event: CalendarEvent): readonly string[] {
    return event.mentions;
  },
  async attachments(
    event: CalendarEvent,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly Attachment[]> {
    return ctx.usecases.listEventAttachments(
      requireViewerOrThrow(ctx),
      event.id,
    );
  },
};

export const eventOccurrenceResolvers = {
  occurrenceStart(view: EventOccurrenceView): string {
    return formatOccurrenceStart(view.occurrenceStart);
  },
  startsAt(view: EventOccurrenceView): string {
    return new Date(view.startUtc).toISOString();
  },
  endsAt(view: EventOccurrenceView): string {
    return new Date(view.endUtc).toISOString();
  },
};
