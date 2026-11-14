/**
 * Hand-written transport types for the calendar surface, mirroring
 * `schema-calendar.graphql.ts`.
 *
 * Kept apart from `schema-types.ts` for the same reason the SDL is a
 * separate module: neither file should have to grow a second feature's
 * worth of shapes. There is no attendance or RSVP field here, by design.
 */

export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type EventEditScope = "THIS_OCCURRENCE" | "ENTIRE_SERIES";

export type CaldavLinkMode = "IMPORT_NEW" | "BIND_EXISTING";

export interface CalendarView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventLinkView {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  readonly position: number;
}

export interface RecurrenceRuleView {
  readonly freq: RecurrenceFrequency;
  readonly interval: number;
  readonly count: number | null;
  readonly until: string | null;
  readonly byDay: readonly Weekday[] | null;
  readonly byMonthDay: readonly number[] | null;
  readonly byMonth: readonly number[] | null;
  readonly weekStart: Weekday;
}

export interface EventTimeView {
  readonly allDay: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timeZone: string | null;
  readonly startDate: string | null;
  readonly endDateExclusive: string | null;
}

export interface EventAttachmentView {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
}

export interface CalendarEventView {
  readonly id: string;
  readonly calendarId: string;
  readonly uid: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly time: EventTimeView;
  readonly recurrence: RecurrenceRuleView | null;
  readonly exdates: readonly string[];
  readonly overrideOfEventId: string | null;
  readonly recurrenceInstanceStart: string | null;
  readonly mentions: readonly string[];
  readonly links: readonly EventLinkView[];
  readonly attachments: readonly EventAttachmentView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventOccurrenceView {
  readonly event: CalendarEventView;
  readonly occurrenceStart: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly isOverride: boolean;
}

export interface EventOccurrencePageView {
  readonly occurrences: readonly EventOccurrenceView[];
  readonly truncated: boolean;
}

export interface EventTimeInput {
  readonly allDay: boolean;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly timeZone?: string;
  readonly startDate?: string;
  readonly endDateExclusive?: string;
}

export interface RecurrenceRuleInput {
  readonly freq: RecurrenceFrequency;
  readonly interval?: number;
  readonly count?: number;
  readonly until?: string;
  readonly byDay?: readonly Weekday[];
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
  readonly weekStart?: Weekday;
}

export interface EventLinkInput {
  readonly url: string;
  readonly title?: string;
}

export interface CreateCalendarEventInput {
  readonly calendarId: string;
  readonly title: string;
  readonly description?: string;
  readonly location?: string;
  readonly time: EventTimeInput;
  readonly recurrence?: RecurrenceRuleInput;
  readonly mentions?: readonly string[];
  readonly links?: readonly EventLinkInput[];
}

export interface UpdateCalendarEventInput {
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly time?: EventTimeInput;
  readonly recurrence?: RecurrenceRuleInput;
  readonly mentions?: readonly string[];
  readonly links?: readonly EventLinkInput[];
  readonly editScope?: EventEditScope;
  readonly occurrenceStart?: string;
}

export interface CaldavAccountView {
  readonly id: string;
  readonly userId: string;
  readonly serverUrl: string;
  readonly username: string;
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CaldavDiscoveredCalendarView {
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
}

export interface CaldavCalendarView {
  readonly id: string;
  readonly accountId: string;
  readonly calendarId: string;
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
}

export interface ConnectCaldavAccountResultView {
  readonly account: CaldavAccountView;
  readonly calendars: readonly CaldavDiscoveredCalendarView[];
}

export interface SyncCalendarResultView {
  readonly pulled: number;
  readonly pushed: number;
  readonly deleted: number;
  readonly conflictsResolvedRemoteWins: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
