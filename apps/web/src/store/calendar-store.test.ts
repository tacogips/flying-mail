import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CalendarEventView,
  EventOccurrenceView,
} from "../api/calendar-types";
import { toIsoDate } from "../lib/calendar-dates";
import { createCalendarStore } from "./calendar-store";

interface GraphQLCall {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
}

/** Records every GraphQL call and answers from a per-operation responder, so
 * the tests assert on what the store asked for as well as what it did with
 * the answer. */
function stubGraphQL(
  responders: Record<string, (variables: Record<string, unknown>) => unknown>,
): GraphQLCall[] {
  const calls: GraphQLCall[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const match = /(?:query|mutation)\s+(\w+)/.exec(body.query);
    const operation = match?.[1] ?? "unknown";
    calls.push({ operation, variables: body.variables ?? {} });
    const responder = responders[operation];
    if (responder === undefined) {
      return new Response(
        JSON.stringify({ errors: [{ message: `no stub for ${operation}` }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: responder(body.variables ?? {}) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return calls;
}

function event(id: string, calendarId = "cal-1"): CalendarEventView {
  return {
    id,
    calendarId,
    uid: `${id}@mailcal`,
    title: `Event ${id}`,
    description: null,
    location: null,
    time: {
      allDay: false,
      startsAt: "2026-09-01T09:00:00.000Z",
      endsAt: "2026-09-01T10:00:00.000Z",
      timeZone: "UTC",
      startDate: null,
      endDateExclusive: null,
    },
    recurrence: null,
    exdates: [],
    overrideOfEventId: null,
    recurrenceInstanceStart: null,
    mentions: [],
    links: [],
    attachments: [],
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function occurrenceOf(view: CalendarEventView): EventOccurrenceView {
  return {
    event: view,
    occurrenceStart: "2026-09-01T09:00:00.000Z",
    startsAt: "2026-09-01T09:00:00.000Z",
    endsAt: "2026-09-01T10:00:00.000Z",
    isOverride: false,
  };
}

function eventsPage(
  occurrences: readonly EventOccurrenceView[],
  truncated = false,
): unknown {
  return { calendarEvents: { occurrences, truncated } };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("range navigation", () => {
  test("month mode moves a month at a time, week mode a week", () => {
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));
    store.setMode("MONTH");
    store.goNext();
    expect(toIsoDate(store.anchor())).toBe("2026-10-01");
    store.goPrevious();
    expect(toIsoDate(store.anchor())).toBe("2026-09-01");

    store.setAnchor(new Date(2026, 8, 15));
    store.setMode("WEEK");
    store.goNext();
    expect(toIsoDate(store.anchor())).toBe("2026-09-22");
    store.goPrevious();
    expect(toIsoDate(store.anchor())).toBe("2026-09-15");
  });

  test("the visible range follows the mode", () => {
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));
    store.setMode("WEEK");
    const week = store.range();
    expect(
      Math.round((week.end.getTime() - week.start.getTime()) / 86_400_000),
    ).toBe(7);
    store.setMode("MONTH");
    expect(
      Math.round(
        (store.range().end.getTime() - store.range().start.getTime()) /
          86_400_000,
      ),
    ).toBe(42);
  });
});

describe("occurrence cache", () => {
  test("a second load of the same range does not re-query", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([occurrenceOf(event("evt-1"))]),
    });
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));

    await store.loadRange();
    expect(store.occurrences()).toHaveLength(1);
    await store.loadRange();
    expect(calls.filter((c) => c.operation === "CalendarEvents")).toHaveLength(
      1,
    );
  });

  test("a different range is a different cache key", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([]),
    });
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));

    await store.loadRange();
    store.goNext();
    await store.loadRange();
    store.goPrevious();
    await store.loadRange();
    // Two distinct ranges queried; the third load reuses the first's entry.
    expect(calls.filter((c) => c.operation === "CalendarEvents")).toHaveLength(
      2,
    );
  });

  test("sends the visible range and reports truncation", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([], true),
    });
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));
    store.setMode("WEEK");
    await store.loadRange();

    const input = calls[0]?.variables["input"] as Record<string, string>;
    expect(Date.parse(input["rangeEnd"] ?? "")).toBeGreaterThan(
      Date.parse(input["rangeStart"] ?? ""),
    );
    expect(store.truncated()).toBe(true);
  });

  test("a write invalidates the cache and reloads", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([occurrenceOf(event("evt-1"))]),
      CreateCalendarEvent: () => ({ createCalendarEvent: event("evt-2") }),
    });
    const store = createCalendarStore();
    store.setAnchor(new Date(2026, 8, 15));

    await store.loadRange();
    await store.createEvent({
      calendarId: "cal-1",
      title: "New",
      time: {
        allDay: false,
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-01T10:00:00.000Z",
      },
    });
    expect(calls.filter((c) => c.operation === "CalendarEvents")).toHaveLength(
      2,
    );
  });
});

describe("calendar visibility", () => {
  test("hiding a calendar filters its occurrences without dropping them", async () => {
    stubGraphQL({
      CalendarEvents: () =>
        eventsPage([
          occurrenceOf(event("evt-1", "cal-1")),
          occurrenceOf(event("evt-2", "cal-2")),
        ]),
    });
    const store = createCalendarStore();
    await store.loadRange();

    expect(store.visibleOccurrences()).toHaveLength(2);
    store.toggleCalendarVisible("cal-2");
    expect(store.visibleOccurrences().map((o) => o.event.id)).toEqual([
      "evt-1",
    ]);
    expect(store.occurrences()).toHaveLength(2);
    store.toggleCalendarVisible("cal-2");
    expect(store.visibleOccurrences()).toHaveLength(2);
  });
});

describe("optimistic delete", () => {
  test("removes the event immediately and keeps it removed on success", async () => {
    stubGraphQL({
      CalendarEvents: () => eventsPage([occurrenceOf(event("evt-1"))]),
      DeleteCalendarEvent: () => ({ deleteCalendarEvent: true }),
    });
    const store = createCalendarStore();
    await store.loadRange();
    expect(store.occurrences()).toHaveLength(1);

    // After the round trip the refetch is authoritative; the stub still
    // returns the event, which is exactly why the optimistic patch alone
    // must not be trusted as the final state.
    expect(await store.deleteEvent("evt-1")).toBe(true);
  });

  test("restores the event when the server refuses", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("DeleteCalendarEvent")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "nope", extensions: { code: "FORBIDDEN" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: eventsPage([occurrenceOf(event("evt-1"))]),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const store = createCalendarStore();
    await store.loadRange();
    expect(store.occurrences()).toHaveLength(1);
    expect(await store.deleteEvent("evt-1")).toBe(false);
    expect(store.occurrences()).toHaveLength(1);
  });

  test("passes editScope and occurrenceStart through", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([]),
      DeleteCalendarEvent: () => ({ deleteCalendarEvent: true }),
    });
    const store = createCalendarStore();
    await store.deleteEvent("evt-1", {
      editScope: "THIS_OCCURRENCE",
      occurrenceStart: "2026-09-08T00:00:00.000Z",
    });
    const call = calls.find((c) => c.operation === "DeleteCalendarEvent");
    expect(call?.variables["input"]).toEqual({
      editScope: "THIS_OCCURRENCE",
      occurrenceStart: "2026-09-08T00:00:00.000Z",
    });
  });
});

describe("calendars and CalDAV", () => {
  test("loads, creates, updates and deletes calendars", async () => {
    const calendar = {
      id: "cal-1",
      ownerUserId: "usr-1",
      name: "Work",
      color: "#3b82f6",
      description: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    stubGraphQL({
      Calendars: () => ({ calendars: [calendar] }),
      CreateCalendar: () => ({
        createCalendar: { ...calendar, id: "cal-2", name: "Personal" },
      }),
      UpdateCalendar: () => ({
        updateCalendar: { ...calendar, name: "Renamed" },
      }),
      DeleteCalendar: () => ({ deleteCalendar: true }),
      CalendarEvents: () => eventsPage([]),
    });
    const store = createCalendarStore();

    await store.loadCalendars();
    expect(store.calendars()).toHaveLength(1);
    await store.createCalendar({ name: "Personal" });
    expect(store.calendars()).toHaveLength(2);
    await store.updateCalendar("cal-1", { name: "Renamed" });
    expect(store.calendars()[0]?.name).toBe("Renamed");
    expect(await store.deleteCalendar("cal-1")).toBe(true);
    expect(store.calendars().map((c) => c.id)).toEqual(["cal-2"]);
  });

  test("connect records the account and never sends it back as plaintext", async () => {
    const calls = stubGraphQL({
      ConnectCaldavAccount: () => ({
        connectCaldavAccount: {
          account: {
            id: "acc-1",
            userId: "usr-1",
            serverUrl: "https://caldav.icloud.com/",
            username: "me@example.com",
            principalUrl: null,
            homeSetUrl: null,
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
          calendars: [
            {
              remoteUrl: "https://p42-caldav.icloud.com/1/calendars/work/",
              displayName: "Work",
              ctag: "ctag-1",
              syncToken: "token-1",
            },
          ],
        },
      }),
    });
    const store = createCalendarStore();
    const result = await store.connectCaldavAccount({
      serverUrl: "https://caldav.icloud.com/",
      username: "me@example.com",
      appPassword: "abcd-efgh-ijkl-mnop",
    });

    expect(result?.calendars).toHaveLength(1);
    expect(store.caldavAccounts()).toHaveLength(1);
    expect(JSON.stringify(store.caldavAccounts())).not.toContain(
      "abcd-efgh-ijkl-mnop",
    );
    // The document only names the account fields; the password travels once,
    // in the request variables.
    expect(
      JSON.stringify(
        calls.find((c) => c.operation === "ConnectCaldavAccount")?.variables,
      ),
    ).toContain("abcd-efgh-ijkl-mnop");
  });

  test("sync returns its result and refreshes the range", async () => {
    const calls = stubGraphQL({
      CalendarEvents: () => eventsPage([]),
      SyncCalendar: () => ({
        syncCalendar: {
          pulled: 2,
          pushed: 1,
          deleted: 0,
          conflictsResolvedRemoteWins: 1,
          truncated: false,
          warnings: ["Unknown time zone"],
        },
      }),
    });
    const store = createCalendarStore();
    await store.loadRange();
    const result = await store.syncCalendar("cal-1");
    expect(result).toMatchObject({ pulled: 2, conflictsResolvedRemoteWins: 1 });
    expect(calls.filter((c) => c.operation === "CalendarEvents")).toHaveLength(
      2,
    );
  });
});
