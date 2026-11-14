import type { Attachment } from "@mailcal/domain/entities/attachment";
import type {
  CaldavAccount,
  CaldavCalendarLink,
} from "@mailcal/domain/entities/caldav-account";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import type {
  AttachmentId,
  CalendarEventId,
  CalendarId,
  CaldavAccountId,
  EventLinkId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import type { Viewer } from "../policies/viewer";
import {
  type ConnectCaldavAccountInput,
  type ConnectCaldavAccountResult,
  createConnectCaldavAccountUseCase,
  createDeleteCaldavAccountUseCase,
  createLinkCaldavCalendarUseCase,
  createListCaldavAccountsUseCase,
  createListCaldavCalendarsUseCase,
  type LinkCaldavCalendarInput,
} from "./caldav";
import {
  createSyncCalendarUseCase,
  type SyncCalendarResult,
} from "./caldav-sync";
import {
  createAddEventLinkUseCase,
  createAddEventMentionUseCase,
  createAttachFileToEventUseCase,
  createCanViewerReadEventAttachmentUseCase,
  createDetachFileFromEventUseCase,
  createListEventAttachmentsUseCase,
  createRemoveEventLinkUseCase,
  createRemoveEventMentionUseCase,
} from "./calendar-event-details";
import type { EventLinkUseCaseInput } from "./calendar-event-inputs";
import {
  type CreateCalendarEventInput,
  createCreateCalendarEventUseCase,
  createDeleteCalendarEventUseCase,
  createGetCalendarEventUseCase,
  createListEventsInRangeUseCase,
  createListEventsMentioningUseCase,
  createUpdateCalendarEventUseCase,
  type DeleteCalendarEventInput,
  type ListEventsInRangeInput,
  type ListEventsMentioningInput,
  type ListEventsResult,
  type UpdateCalendarEventInput,
} from "./calendar-events";
import {
  type CreateCalendarInput,
  createCreateCalendarUseCase,
  createDeleteCalendarUseCase,
  createGetCalendarUseCase,
  createListCalendarsUseCase,
  createUpdateCalendarUseCase,
  type UpdateCalendarUseCaseInput,
} from "./calendars";

/** The calendar half of `UseCases`, assembled here so `usecases.ts` gains a
 * single spread rather than fifty more lines. */
export interface CalendarUseCases {
  readonly listCalendars: (viewer: Viewer) => Promise<readonly Calendar[]>;
  readonly getCalendar: (
    viewer: Viewer,
    id: CalendarId,
  ) => Promise<Calendar | null>;
  readonly createCalendar: (
    viewer: Viewer,
    input: CreateCalendarInput,
  ) => Promise<Calendar>;
  readonly updateCalendar: (
    viewer: Viewer,
    id: CalendarId,
    input: UpdateCalendarUseCaseInput,
  ) => Promise<Calendar>;
  readonly deleteCalendar: (viewer: Viewer, id: CalendarId) => Promise<boolean>;

  readonly createCalendarEvent: (
    viewer: Viewer,
    input: CreateCalendarEventInput,
  ) => Promise<CalendarEvent>;
  readonly getCalendarEvent: (
    viewer: Viewer,
    id: CalendarEventId,
  ) => Promise<CalendarEvent | null>;
  readonly updateCalendarEvent: (
    viewer: Viewer,
    id: CalendarEventId,
    input: UpdateCalendarEventInput,
  ) => Promise<CalendarEvent>;
  readonly deleteCalendarEvent: (
    viewer: Viewer,
    id: CalendarEventId,
    input?: DeleteCalendarEventInput,
  ) => Promise<boolean>;
  readonly listCalendarEvents: (
    viewer: Viewer,
    input: ListEventsInRangeInput,
  ) => Promise<ListEventsResult>;
  readonly listEventsMentioning: (
    viewer: Viewer,
    input: ListEventsMentioningInput,
  ) => Promise<readonly CalendarEvent[]>;

  readonly addEventMention: (
    viewer: Viewer,
    eventId: CalendarEventId,
    address: string,
  ) => Promise<CalendarEvent>;
  readonly removeEventMention: (
    viewer: Viewer,
    eventId: CalendarEventId,
    address: string,
  ) => Promise<CalendarEvent>;
  readonly addEventLink: (
    viewer: Viewer,
    eventId: CalendarEventId,
    link: EventLinkUseCaseInput,
  ) => Promise<CalendarEvent>;
  readonly removeEventLink: (
    viewer: Viewer,
    eventId: CalendarEventId,
    linkId: EventLinkId,
  ) => Promise<CalendarEvent>;
  readonly attachFileToEvent: (
    viewer: Viewer,
    eventId: CalendarEventId,
    attachmentId: AttachmentId,
  ) => Promise<readonly Attachment[]>;
  readonly detachFileFromEvent: (
    viewer: Viewer,
    eventId: CalendarEventId,
    attachmentId: AttachmentId,
  ) => Promise<boolean>;
  readonly listEventAttachments: (
    viewer: Viewer,
    eventId: CalendarEventId,
  ) => Promise<readonly Attachment[]>;
  /** Backs the attachment download route's event-authorization branch. */
  readonly canViewerReadEventAttachment: (
    viewer: Viewer,
    attachmentId: AttachmentId,
  ) => Promise<boolean>;

  readonly listCaldavAccounts: (
    viewer: Viewer,
  ) => Promise<readonly CaldavAccount[]>;
  readonly listCaldavCalendars: (
    viewer: Viewer,
    accountId: CaldavAccountId,
  ) => Promise<readonly CaldavCalendarLink[]>;
  readonly connectCaldavAccount: (
    viewer: Viewer,
    input: ConnectCaldavAccountInput,
  ) => Promise<ConnectCaldavAccountResult>;
  readonly linkCaldavCalendar: (
    viewer: Viewer,
    input: LinkCaldavCalendarInput,
  ) => Promise<CaldavCalendarLink>;
  readonly syncCalendar: (
    viewer: Viewer,
    calendarId: CalendarId,
  ) => Promise<SyncCalendarResult>;
  readonly deleteCaldavAccount: (
    viewer: Viewer,
    id: CaldavAccountId,
  ) => Promise<boolean>;
}

export function createCalendarUseCases(
  deps: AppDependencies,
): CalendarUseCases {
  return {
    listCalendars: createListCalendarsUseCase(deps),
    getCalendar: createGetCalendarUseCase(deps),
    createCalendar: createCreateCalendarUseCase(deps),
    updateCalendar: createUpdateCalendarUseCase(deps),
    deleteCalendar: createDeleteCalendarUseCase(deps),

    createCalendarEvent: createCreateCalendarEventUseCase(deps),
    getCalendarEvent: createGetCalendarEventUseCase(deps),
    updateCalendarEvent: createUpdateCalendarEventUseCase(deps),
    deleteCalendarEvent: createDeleteCalendarEventUseCase(deps),
    listCalendarEvents: createListEventsInRangeUseCase(deps),
    listEventsMentioning: createListEventsMentioningUseCase(deps),

    addEventMention: createAddEventMentionUseCase(deps),
    removeEventMention: createRemoveEventMentionUseCase(deps),
    addEventLink: createAddEventLinkUseCase(deps),
    removeEventLink: createRemoveEventLinkUseCase(deps),
    attachFileToEvent: createAttachFileToEventUseCase(deps),
    detachFileFromEvent: createDetachFileFromEventUseCase(deps),
    listEventAttachments: createListEventAttachmentsUseCase(deps),
    canViewerReadEventAttachment:
      createCanViewerReadEventAttachmentUseCase(deps),

    listCaldavAccounts: createListCaldavAccountsUseCase(deps),
    listCaldavCalendars: createListCaldavCalendarsUseCase(deps),
    connectCaldavAccount: createConnectCaldavAccountUseCase(deps),
    linkCaldavCalendar: createLinkCaldavCalendarUseCase(deps),
    syncCalendar: createSyncCalendarUseCase(deps),
    deleteCaldavAccount: createDeleteCaldavAccountUseCase(deps),
  };
}

export type {
  ConnectCaldavAccountInput,
  ConnectCaldavAccountResult,
  CreateCalendarEventInput,
  CreateCalendarInput,
  DeleteCalendarEventInput,
  EventLinkUseCaseInput,
  LinkCaldavCalendarInput,
  ListEventsInRangeInput,
  ListEventsMentioningInput,
  ListEventsResult,
  SyncCalendarResult,
  UpdateCalendarEventInput,
  UpdateCalendarUseCaseInput,
};
