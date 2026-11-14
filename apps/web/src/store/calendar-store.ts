import { createSignal } from "solid-js";
import {
  ADD_EVENT_LINK_MUTATION,
  ADD_EVENT_MENTION_MUTATION,
  ATTACH_FILE_TO_EVENT_MUTATION,
  CALDAV_ACCOUNTS_QUERY,
  CALDAV_CALENDARS_QUERY,
  CALENDAR_EVENTS_QUERY,
  CALENDARS_QUERY,
  CONNECT_CALDAV_ACCOUNT_MUTATION,
  CREATE_CALENDAR_EVENT_MUTATION,
  CREATE_CALENDAR_MUTATION,
  DELETE_CALDAV_ACCOUNT_MUTATION,
  DELETE_CALENDAR_EVENT_MUTATION,
  DELETE_CALENDAR_MUTATION,
  DETACH_FILE_FROM_EVENT_MUTATION,
  LINK_CALDAV_CALENDAR_MUTATION,
  REMOVE_EVENT_LINK_MUTATION,
  REMOVE_EVENT_MENTION_MUTATION,
  SYNC_CALENDAR_MUTATION,
  UPDATE_CALENDAR_EVENT_MUTATION,
  UPDATE_CALENDAR_MUTATION,
} from "../api/calendar-documents";
import type {
  CaldavAccountView,
  CaldavCalendarView,
  CaldavLinkMode,
  CalendarEventView,
  CalendarView,
  ConnectCaldavAccountResultView,
  CreateCalendarEventInput,
  EventAttachmentView,
  EventEditScope,
  EventLinkInput,
  EventOccurrencePageView,
  EventOccurrenceView,
  SyncCalendarResultView,
  UpdateCalendarEventInput,
} from "../api/calendar-types";
import { graphqlRequest, type GraphQLResult } from "../api/graphql-client";
import {
  type CalendarRange,
  type CalendarViewMode,
  addDays,
  addMonths,
  startOfDay,
  visibleRange,
} from "../lib/calendar-dates";
import { describeErrors } from "../lib/mutation-error";
import { pushToast } from "../lib/toast";

/** Calendar state, mounted alongside the mail store rather than inside it.
 *
 * Occurrences are cached per visible range: paging back to last month must
 * not re-query, but the cache key has to be the range rather than the month,
 * because a week view and a month view of the same day are different
 * questions. Any write invalidates the whole cache -- a recurring edit can
 * change occurrences in ranges the client never loaded, so a surgical patch
 * would be a guess. */

export interface CalendarStore {
  readonly calendars: () => readonly CalendarView[];
  readonly hiddenCalendarIds: () => ReadonlySet<string>;
  readonly occurrences: () => readonly EventOccurrenceView[];
  readonly visibleOccurrences: () => readonly EventOccurrenceView[];
  readonly truncated: () => boolean;
  readonly loading: () => boolean;
  readonly mode: () => CalendarViewMode;
  readonly anchor: () => Date;
  readonly range: () => CalendarRange;
  readonly caldavAccounts: () => readonly CaldavAccountView[];
  readonly caldavCalendars: () => readonly CaldavCalendarView[];

  setMode(mode: CalendarViewMode): void;
  setAnchor(date: Date): void;
  goToday(): void;
  goPrevious(): void;
  goNext(): void;
  toggleCalendarVisible(calendarId: string): void;

  loadCalendars(): Promise<void>;
  loadRange(options?: { readonly force?: boolean }): Promise<void>;

  createCalendar(input: {
    readonly name: string;
    readonly color?: string;
    readonly description?: string;
  }): Promise<CalendarView | null>;
  updateCalendar(
    id: string,
    input: {
      readonly name?: string;
      readonly color?: string;
      readonly description?: string;
    },
  ): Promise<CalendarView | null>;
  deleteCalendar(id: string): Promise<boolean>;

  createEvent(
    input: CreateCalendarEventInput,
  ): Promise<CalendarEventView | null>;
  updateEvent(
    id: string,
    input: UpdateCalendarEventInput,
  ): Promise<CalendarEventView | null>;
  deleteEvent(
    id: string,
    options?: {
      readonly editScope?: EventEditScope;
      readonly occurrenceStart?: string;
    },
  ): Promise<boolean>;

  addMention(
    eventId: string,
    address: string,
  ): Promise<CalendarEventView | null>;
  removeMention(
    eventId: string,
    address: string,
  ): Promise<CalendarEventView | null>;
  addLink(
    eventId: string,
    input: EventLinkInput,
  ): Promise<CalendarEventView | null>;
  removeLink(
    eventId: string,
    linkId: string,
  ): Promise<CalendarEventView | null>;
  attachFile(
    eventId: string,
    attachmentId: string,
  ): Promise<readonly EventAttachmentView[] | null>;
  detachFile(eventId: string, attachmentId: string): Promise<boolean>;

  loadCaldavAccounts(): Promise<void>;
  loadCaldavCalendars(accountId: string): Promise<void>;
  connectCaldavAccount(input: {
    readonly serverUrl: string;
    readonly username: string;
    readonly appPassword: string;
  }): Promise<ConnectCaldavAccountResultView | null>;
  linkCaldavCalendar(input: {
    readonly accountId: string;
    readonly remoteUrl: string;
    readonly mode: CaldavLinkMode;
    readonly calendarId?: string;
    readonly displayName?: string;
  }): Promise<CaldavCalendarView | null>;
  syncCalendar(calendarId: string): Promise<SyncCalendarResultView | null>;
  deleteCaldavAccount(id: string): Promise<boolean>;
}

function rangeKey(range: CalendarRange): string {
  return `${range.start.toISOString()}|${range.end.toISOString()}`;
}

export function createCalendarStore(): CalendarStore {
  const [calendars, setCalendars] = createSignal<readonly CalendarView[]>([]);
  const [hiddenCalendarIds, setHiddenCalendarIds] = createSignal<
    ReadonlySet<string>
  >(new Set());
  const [occurrences, setOccurrences] = createSignal<
    readonly EventOccurrenceView[]
  >([]);
  const [truncated, setTruncated] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [mode, setModeSignal] = createSignal<CalendarViewMode>("MONTH");
  const [anchor, setAnchorSignal] = createSignal(startOfDay(new Date()));
  const [caldavAccounts, setCaldavAccounts] = createSignal<
    readonly CaldavAccountView[]
  >([]);
  const [caldavCalendars, setCaldavCalendars] = createSignal<
    readonly CaldavCalendarView[]
  >([]);

  const cache = new Map<string, EventOccurrencePageView>();

  function range(): CalendarRange {
    return visibleRange(mode(), anchor());
  }

  function reportFailure(result: GraphQLResult<unknown>): boolean {
    if (result.ok) {
      return false;
    }
    pushToast("error", describeErrors(result.errors));
    return true;
  }

  /** A write may change occurrences outside the loaded range (a recurrence
   * rule, an EXDATE, a moved instance), so the whole cache goes. */
  function invalidate(): void {
    cache.clear();
  }

  function applyPage(page: EventOccurrencePageView): void {
    setOccurrences(page.occurrences);
    setTruncated(page.truncated);
  }

  async function loadRange(
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const current = range();
    const key = rangeKey(current);
    const cached = cache.get(key);
    if (cached !== undefined && options.force !== true) {
      applyPage(cached);
      return;
    }
    setLoading(true);
    const result = await graphqlRequest<
      { calendarEvents: EventOccurrencePageView },
      { input: Record<string, unknown> }
    >(CALENDAR_EVENTS_QUERY, {
      input: {
        rangeStart: current.start.toISOString(),
        rangeEnd: current.end.toISOString(),
        expand: true,
      },
    });
    setLoading(false);
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    cache.set(key, result.data.calendarEvents);
    applyPage(result.data.calendarEvents);
  }

  async function refresh(): Promise<void> {
    invalidate();
    await loadRange({ force: true });
  }

  async function loadCalendars(): Promise<void> {
    const result = await graphqlRequest<{ calendars: readonly CalendarView[] }>(
      CALENDARS_QUERY,
    );
    if (reportFailure(result) || !result.ok) {
      return;
    }
    setCalendars(result.data.calendars);
  }

  /** Optimistically drops the deleted event's occurrences before the round
   * trip, and restores them if the server refuses. A create or an edit is
   * not patched optimistically: the server decides the occurrence set, and
   * guessing it for a recurring event would show occurrences that do not
   * exist. */
  function optimisticallyRemoveEvent(eventId: string): () => void {
    const before = occurrences();
    setOccurrences(
      before.filter((occurrence) => occurrence.event.id !== eventId),
    );
    return () => setOccurrences(before);
  }

  return {
    calendars,
    hiddenCalendarIds,
    occurrences,
    visibleOccurrences: () => {
      const hidden = hiddenCalendarIds();
      return occurrences().filter(
        (occurrence) => !hidden.has(occurrence.event.calendarId),
      );
    },
    truncated,
    loading,
    mode,
    anchor,
    range,
    caldavAccounts,
    caldavCalendars,

    setMode(next) {
      setModeSignal(next);
    },
    setAnchor(date) {
      setAnchorSignal(startOfDay(date));
    },
    goToday() {
      setAnchorSignal(startOfDay(new Date()));
    },
    goPrevious() {
      setAnchorSignal((current) =>
        mode() === "MONTH" ? addMonths(current, -1) : addDays(current, -7),
      );
    },
    goNext() {
      setAnchorSignal((current) =>
        mode() === "MONTH" ? addMonths(current, 1) : addDays(current, 7),
      );
    },
    toggleCalendarVisible(calendarId) {
      setHiddenCalendarIds((current) => {
        const next = new Set(current);
        if (next.has(calendarId)) {
          next.delete(calendarId);
        } else {
          next.add(calendarId);
        }
        return next;
      });
    },

    loadCalendars,
    loadRange,

    async createCalendar(input) {
      const result = await graphqlRequest<
        { createCalendar: CalendarView },
        { input: Record<string, unknown> }
      >(CREATE_CALENDAR_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCalendars((current) => [...current, result.data.createCalendar]);
      return result.data.createCalendar;
    },

    async updateCalendar(id, input) {
      const result = await graphqlRequest<
        { updateCalendar: CalendarView },
        { id: string; input: Record<string, unknown> }
      >(UPDATE_CALENDAR_MUTATION, { id, input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCalendars((current) =>
        current.map((calendar) =>
          calendar.id === id ? result.data.updateCalendar : calendar,
        ),
      );
      return result.data.updateCalendar;
    },

    async deleteCalendar(id) {
      const result = await graphqlRequest<
        { deleteCalendar: boolean },
        { id: string }
      >(DELETE_CALENDAR_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      setCalendars((current) =>
        current.filter((calendar) => calendar.id !== id),
      );
      await refresh();
      return result.data.deleteCalendar;
    },

    async createEvent(input) {
      const result = await graphqlRequest<
        { createCalendarEvent: CalendarEventView },
        { input: CreateCalendarEventInput }
      >(CREATE_CALENDAR_EVENT_MUTATION, { input });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.createCalendarEvent;
    },

    async updateEvent(id, input) {
      const result = await graphqlRequest<
        { updateCalendarEvent: CalendarEventView },
        { id: string; input: UpdateCalendarEventInput }
      >(UPDATE_CALENDAR_EVENT_MUTATION, { id, input });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.updateCalendarEvent;
    },

    async deleteEvent(id, options = {}) {
      const rollback = optimisticallyRemoveEvent(id);
      const result = await graphqlRequest<
        { deleteCalendarEvent: boolean },
        { id: string; input: Record<string, unknown> }
      >(DELETE_CALENDAR_EVENT_MUTATION, {
        id,
        input: {
          ...(options.editScope === undefined
            ? {}
            : { editScope: options.editScope }),
          ...(options.occurrenceStart === undefined
            ? {}
            : { occurrenceStart: options.occurrenceStart }),
        },
      });
      if (!result.ok) {
        rollback();
        reportFailure(result);
        return false;
      }
      await refresh();
      return result.data.deleteCalendarEvent;
    },

    async addMention(eventId, address) {
      const result = await graphqlRequest<
        { addEventMention: CalendarEventView },
        { eventId: string; address: string }
      >(ADD_EVENT_MENTION_MUTATION, { eventId, address });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.addEventMention;
    },

    async removeMention(eventId, address) {
      const result = await graphqlRequest<
        { removeEventMention: CalendarEventView },
        { eventId: string; address: string }
      >(REMOVE_EVENT_MENTION_MUTATION, { eventId, address });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.removeEventMention;
    },

    async addLink(eventId, input) {
      const result = await graphqlRequest<
        { addEventLink: CalendarEventView },
        { eventId: string; input: EventLinkInput }
      >(ADD_EVENT_LINK_MUTATION, { eventId, input });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.addEventLink;
    },

    async removeLink(eventId, linkId) {
      const result = await graphqlRequest<
        { removeEventLink: CalendarEventView },
        { eventId: string; linkId: string }
      >(REMOVE_EVENT_LINK_MUTATION, { eventId, linkId });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.removeEventLink;
    },

    async attachFile(eventId, attachmentId) {
      const result = await graphqlRequest<
        { attachFileToEvent: readonly EventAttachmentView[] },
        { eventId: string; attachmentId: string }
      >(ATTACH_FILE_TO_EVENT_MUTATION, { eventId, attachmentId });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.attachFileToEvent;
    },

    async detachFile(eventId, attachmentId) {
      const result = await graphqlRequest<
        { detachFileFromEvent: boolean },
        { eventId: string; attachmentId: string }
      >(DETACH_FILE_FROM_EVENT_MUTATION, { eventId, attachmentId });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      await refresh();
      return result.data.detachFileFromEvent;
    },

    async loadCaldavAccounts() {
      const result = await graphqlRequest<{
        caldavAccounts: readonly CaldavAccountView[];
      }>(CALDAV_ACCOUNTS_QUERY);
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setCaldavAccounts(result.data.caldavAccounts);
    },

    async loadCaldavCalendars(accountId) {
      const result = await graphqlRequest<
        { caldavCalendars: readonly CaldavCalendarView[] },
        { accountId: string }
      >(CALDAV_CALENDARS_QUERY, { accountId });
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setCaldavCalendars(result.data.caldavCalendars);
    },

    async connectCaldavAccount(input) {
      const result = await graphqlRequest<
        { connectCaldavAccount: ConnectCaldavAccountResultView },
        { input: Record<string, unknown> }
      >(CONNECT_CALDAV_ACCOUNT_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCaldavAccounts((current) => [
        ...current,
        result.data.connectCaldavAccount.account,
      ]);
      return result.data.connectCaldavAccount;
    },

    async linkCaldavCalendar(input) {
      const result = await graphqlRequest<
        { linkCaldavCalendar: CaldavCalendarView },
        { input: Record<string, unknown> }
      >(LINK_CALDAV_CALENDAR_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCaldavCalendars((current) => [
        ...current.filter(
          (link) => link.id !== result.data.linkCaldavCalendar.id,
        ),
        result.data.linkCaldavCalendar,
      ]);
      await loadCalendars();
      await refresh();
      return result.data.linkCaldavCalendar;
    },

    async syncCalendar(calendarId) {
      const result = await graphqlRequest<
        { syncCalendar: SyncCalendarResultView },
        { calendarId: string }
      >(SYNC_CALENDAR_MUTATION, { calendarId });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await refresh();
      return result.data.syncCalendar;
    },

    async deleteCaldavAccount(id) {
      const result = await graphqlRequest<
        { deleteCaldavAccount: boolean },
        { id: string }
      >(DELETE_CALDAV_ACCOUNT_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      setCaldavAccounts((current) =>
        current.filter((account) => account.id !== id),
      );
      setCaldavCalendars([]);
      return result.data.deleteCaldavAccount;
    },
  };
}
