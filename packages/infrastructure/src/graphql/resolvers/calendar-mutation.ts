import type {
  ConnectCaldavAccountInput,
  ConnectCaldavAccountResult,
  CreateCalendarEventInput,
  CreateCalendarInput,
  DeleteCalendarEventInput,
  EventLinkUseCaseInput,
  LinkCaldavCalendarInput,
  SyncCalendarResult,
  UpdateCalendarEventInput,
  UpdateCalendarUseCaseInput,
} from "@mailcal/application/usecases/calendar-usecases";
import type {
  EventTimeInput,
  RecurrenceRuleUseCaseInput,
} from "@mailcal/application/usecases/calendar-event-inputs";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import type { CaldavCalendarLink } from "@mailcal/domain/entities/caldav-account";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import type {
  RecurrenceFrequency,
  Weekday,
} from "@mailcal/domain/value-objects/recurrence";
import {
  createAttachmentId,
  createCaldavAccountId,
  createCalendarEventId,
  createCalendarId,
  createEventLinkId,
} from "@mailcal/domain/value-objects/ids";
import type { GraphQLContext } from "../context";
import { requireViewerOrThrow } from "./helpers";

/** Every calendar mutation. Argument mapping only: authorization, domain
 * validation and persistence all live behind `ctx.usecases`. */

interface EventTimeArg {
  readonly allDay: boolean;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly timeZone?: string | null;
  readonly startDate?: string | null;
  readonly endDateExclusive?: string | null;
}

interface RecurrenceRuleArg {
  readonly freq: RecurrenceFrequency;
  readonly interval?: number | null;
  readonly count?: number | null;
  readonly until?: string | null;
  readonly byDay?: readonly Weekday[] | null;
  readonly byMonthDay?: readonly number[] | null;
  readonly byMonth?: readonly number[] | null;
  readonly weekStart?: Weekday | null;
}

interface EventLinkArg {
  readonly url: string;
  readonly title?: string | null;
}

interface CreateCalendarEventArg {
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly time: EventTimeArg;
  readonly recurrence?: RecurrenceRuleArg | null;
  readonly mentions?: readonly string[] | null;
  readonly links?: readonly EventLinkArg[] | null;
}

interface UpdateCalendarEventArg {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly time?: EventTimeArg | null;
  readonly recurrence?: RecurrenceRuleArg | null;
  readonly mentions?: readonly string[] | null;
  readonly links?: readonly EventLinkArg[] | null;
  readonly editScope?: "THIS_OCCURRENCE" | "ENTIRE_SERIES" | null;
  readonly occurrenceStart?: string | null;
}

/** `time` is not partial: a client changing an event's time supplies the
 * whole shape, because half a time is not a thing the domain can validate. */
function toTimeInput(arg: EventTimeArg): EventTimeInput {
  return {
    allDay: arg.allDay,
    ...(arg.startsAt == null ? {} : { startsAt: arg.startsAt }),
    ...(arg.endsAt == null ? {} : { endsAt: arg.endsAt }),
    ...(arg.timeZone == null ? {} : { timeZone: arg.timeZone }),
    ...(arg.startDate == null ? {} : { startDate: arg.startDate }),
    ...(arg.endDateExclusive == null
      ? {}
      : { endDateExclusive: arg.endDateExclusive }),
  };
}

function toRecurrenceInput(arg: RecurrenceRuleArg): RecurrenceRuleUseCaseInput {
  return {
    freq: arg.freq,
    ...(arg.interval == null ? {} : { interval: arg.interval }),
    ...(arg.count == null ? {} : { count: arg.count }),
    ...(arg.until == null ? {} : { until: arg.until }),
    ...(arg.byDay == null ? {} : { byDay: arg.byDay }),
    ...(arg.byMonthDay == null ? {} : { byMonthDay: arg.byMonthDay }),
    ...(arg.byMonth == null ? {} : { byMonth: arg.byMonth }),
    ...(arg.weekStart == null ? {} : { weekStart: arg.weekStart }),
  };
}

function toLinkInput(arg: EventLinkArg): EventLinkUseCaseInput {
  return {
    url: arg.url,
    ...(arg.title == null ? {} : { title: arg.title }),
  };
}

export const calendarMutationResolvers = {
  async createCalendar(
    _parent: unknown,
    args: {
      readonly input: {
        readonly name: string;
        readonly color?: string | null;
        readonly description?: string | null;
        readonly ownerUserId?: string | null;
      };
    },
    ctx: GraphQLContext,
  ): Promise<Calendar> {
    const input: CreateCalendarInput = {
      name: args.input.name,
      ...(args.input.color == null ? {} : { color: args.input.color }),
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
      ...(args.input.ownerUserId == null
        ? {}
        : { ownerUserId: args.input.ownerUserId }),
    };
    return ctx.usecases.createCalendar(requireViewerOrThrow(ctx), input);
  },

  async updateCalendar(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly input: {
        readonly name?: string | null;
        readonly color?: string | null;
        readonly description?: string | null;
      };
    },
    ctx: GraphQLContext,
  ): Promise<Calendar> {
    const input: UpdateCalendarUseCaseInput = {
      ...(args.input.name == null ? {} : { name: args.input.name }),
      ...(args.input.color == null ? {} : { color: args.input.color }),
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
    };
    return ctx.usecases.updateCalendar(
      requireViewerOrThrow(ctx),
      createCalendarId(args.id),
      input,
    );
  },

  async deleteCalendar(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.deleteCalendar(
      requireViewerOrThrow(ctx),
      createCalendarId(args.id),
    );
  },

  async createCalendarEvent(
    _parent: unknown,
    args: { readonly input: CreateCalendarEventArg },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    const input: CreateCalendarEventInput = {
      calendarId: createCalendarId(args.input.calendarId),
      title: args.input.title,
      time: toTimeInput(args.input.time),
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
      ...(args.input.location == null ? {} : { location: args.input.location }),
      ...(args.input.recurrence == null
        ? {}
        : { recurrence: toRecurrenceInput(args.input.recurrence) }),
      ...(args.input.mentions == null ? {} : { mentions: args.input.mentions }),
      ...(args.input.links == null
        ? {}
        : { links: args.input.links.map(toLinkInput) }),
    };
    return ctx.usecases.createCalendarEvent(requireViewerOrThrow(ctx), input);
  },

  async updateCalendarEvent(
    _parent: unknown,
    args: { readonly id: string; readonly input: UpdateCalendarEventArg },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    const input: UpdateCalendarEventInput = {
      ...(args.input.title == null ? {} : { title: args.input.title }),
      ...(args.input.description == null
        ? {}
        : { description: args.input.description }),
      ...(args.input.location == null ? {} : { location: args.input.location }),
      ...(args.input.time == null
        ? {}
        : { time: toTimeInput(args.input.time) }),
      ...(args.input.recurrence == null
        ? {}
        : { recurrence: toRecurrenceInput(args.input.recurrence) }),
      ...(args.input.mentions == null ? {} : { mentions: args.input.mentions }),
      ...(args.input.links == null
        ? {}
        : { links: args.input.links.map(toLinkInput) }),
      ...(args.input.editScope == null
        ? {}
        : { editScope: args.input.editScope }),
      ...(args.input.occurrenceStart == null
        ? {}
        : { occurrenceStart: args.input.occurrenceStart }),
    };
    return ctx.usecases.updateCalendarEvent(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.id),
      input,
    );
  },

  async deleteCalendarEvent(
    _parent: unknown,
    args: {
      readonly id: string;
      readonly input?: {
        readonly editScope?: "THIS_OCCURRENCE" | "ENTIRE_SERIES" | null;
        readonly occurrenceStart?: string | null;
      } | null;
    },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    const input: DeleteCalendarEventInput = {
      ...(args.input?.editScope == null
        ? {}
        : { editScope: args.input.editScope }),
      ...(args.input?.occurrenceStart == null
        ? {}
        : { occurrenceStart: args.input.occurrenceStart }),
    };
    return ctx.usecases.deleteCalendarEvent(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.id),
      input,
    );
  },

  async addEventMention(
    _parent: unknown,
    args: { readonly eventId: string; readonly address: string },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    return ctx.usecases.addEventMention(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      args.address,
    );
  },

  async removeEventMention(
    _parent: unknown,
    args: { readonly eventId: string; readonly address: string },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    return ctx.usecases.removeEventMention(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      args.address,
    );
  },

  async addEventLink(
    _parent: unknown,
    args: { readonly eventId: string; readonly input: EventLinkArg },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    return ctx.usecases.addEventLink(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      toLinkInput(args.input),
    );
  },

  async removeEventLink(
    _parent: unknown,
    args: { readonly eventId: string; readonly linkId: string },
    ctx: GraphQLContext,
  ): Promise<CalendarEvent> {
    return ctx.usecases.removeEventLink(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      createEventLinkId(args.linkId),
    );
  },

  async attachFileToEvent(
    _parent: unknown,
    args: { readonly eventId: string; readonly attachmentId: string },
    ctx: GraphQLContext,
  ): Promise<readonly Attachment[]> {
    return ctx.usecases.attachFileToEvent(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      createAttachmentId(args.attachmentId),
    );
  },

  async detachFileFromEvent(
    _parent: unknown,
    args: { readonly eventId: string; readonly attachmentId: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.detachFileFromEvent(
      requireViewerOrThrow(ctx),
      createCalendarEventId(args.eventId),
      createAttachmentId(args.attachmentId),
    );
  },

  async connectCaldavAccount(
    _parent: unknown,
    args: { readonly input: ConnectCaldavAccountInput },
    ctx: GraphQLContext,
  ): Promise<ConnectCaldavAccountResult> {
    return ctx.usecases.connectCaldavAccount(requireViewerOrThrow(ctx), {
      serverUrl: args.input.serverUrl,
      username: args.input.username,
      appPassword: args.input.appPassword,
    });
  },

  async linkCaldavCalendar(
    _parent: unknown,
    args: {
      readonly input: {
        readonly accountId: string;
        readonly remoteUrl: string;
        readonly mode: "IMPORT_NEW" | "BIND_EXISTING";
        readonly calendarId?: string | null;
        readonly displayName?: string | null;
      };
    },
    ctx: GraphQLContext,
  ): Promise<CaldavCalendarLink> {
    const input: LinkCaldavCalendarInput = {
      accountId: createCaldavAccountId(args.input.accountId),
      remoteUrl: args.input.remoteUrl,
      mode: args.input.mode,
      ...(args.input.calendarId == null
        ? {}
        : { calendarId: createCalendarId(args.input.calendarId) }),
      ...(args.input.displayName == null
        ? {}
        : { displayName: args.input.displayName }),
    };
    return ctx.usecases.linkCaldavCalendar(requireViewerOrThrow(ctx), input);
  },

  async syncCalendar(
    _parent: unknown,
    args: { readonly calendarId: string },
    ctx: GraphQLContext,
  ): Promise<SyncCalendarResult> {
    return ctx.usecases.syncCalendar(
      requireViewerOrThrow(ctx),
      createCalendarId(args.calendarId),
    );
  },

  async deleteCaldavAccount(
    _parent: unknown,
    args: { readonly id: string },
    ctx: GraphQLContext,
  ): Promise<boolean> {
    return ctx.usecases.deleteCaldavAccount(
      requireViewerOrThrow(ctx),
      createCaldavAccountId(args.id),
    );
  },
};
