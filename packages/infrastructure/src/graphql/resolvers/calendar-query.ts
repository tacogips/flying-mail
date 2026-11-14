import type {
  ListEventsInRangeInput,
  ListEventsMentioningInput,
  ListEventsResult,
} from "@mailcal/application/usecases/calendar-usecases";
import type { CaldavAccount } from "@mailcal/domain/entities/caldav-account";
import type { CaldavCalendarLink } from "@mailcal/domain/entities/caldav-account";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import {
  createCaldavAccountId,
  createCalendarEventId,
  createCalendarId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

interface CalendarEventRangeArg {
  readonly calendarIds?: readonly string[] | null;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly expand?: boolean | null;
}

/** Drops explicit nulls: GraphQL spells "not supplied" as `null`, which
 * `exactOptionalPropertyTypes` will not let through as an absent field. */
function toRangeInput(arg: CalendarEventRangeArg): ListEventsInRangeInput {
  return {
    rangeStart: arg.rangeStart,
    rangeEnd: arg.rangeEnd,
    ...(arg.calendarIds == null
      ? {}
      : { calendarIds: arg.calendarIds.map(createCalendarId) }),
    ...(arg.expand == null ? {} : { expand: arg.expand }),
  };
}

export const calendarQueryResolvers = {
  async calendars(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly Calendar[]> {
    return ctx.usecases.listCalendars(requireViewerOrThrow(ctx));
  },

  async calendar(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<Calendar | null> {
    return ctx.usecases.getCalendar(
      requireViewerOrThrow(ctx),
      createCalendarId(args.id),
    );
  },

  async calendarEvents(
    _parent: unknown,
    args: { readonly input: CalendarEventRangeArg },
    ctx: GraphQLContext,
  ): Promise<ListEventsResult> {
    return ctx.usecases.listCalendarEvents(
      requireViewerOrThrow(ctx),
      toRangeInput(args.input),
    );
  },

  async calendarEvent(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent | null> {
    return ctx.usecases.getCalendarEvent(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.id),
    );
  },

  async eventsMentioning(
    _parent: unknown,
    args: {
      readonly address: string;
      readonly rangeStart?: string | null;
      readonly rangeEnd?: string | null;
    },
    ctx: GraphQLContext,
  ): Promise<readonly CalendarEvent[]> {
    const input: ListEventsMentioningInput = {
      address: args.address,
      ...(args.rangeStart == null ? {} : { rangeStart: args.rangeStart }),
      ...(args.rangeEnd == null ? {} : { rangeEnd: args.rangeEnd }),
    };
    return ctx.usecases.listEventsMentioning(requireViewerOrThrow(ctx), input);
  },

  async caldavAccounts(
    _parent: unknown,
    _args: unknown,
    ctx: GraphQLContext,
  ): Promise<readonly CaldavAccount[]> {
    return ctx.usecases.listCaldavAccounts(requireViewerOrThrow(ctx));
  },

  async caldavCalendars(
    _parent: unknown,
    args: { readonly accountId: string },
    ctx: GraphQLContext,
  ): Promise<readonly CaldavCalendarLink[]> {
    return ctx.usecases.listCaldavCalendars(
      requireViewerOrThrow(ctx),
      createCaldavAccountId(args.accountId),
    );
  },
};
