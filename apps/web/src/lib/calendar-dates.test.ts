import { describe, expect, test } from "vitest";
import type {
  CalendarEventView,
  EventOccurrenceView,
} from "../api/calendar-types";
import {
  addDays,
  addMonths,
  buildMonthMatrix,
  buildWeekDays,
  fromDateAndTime,
  fromIsoDate,
  layoutDayOccurrences,
  monthGridRange,
  occurrenceCoversDay,
  occurrencesForDay,
  startOfWeek,
  toIsoDate,
  visibleRange,
  weekGridRange,
} from "./calendar-dates";

/** Local-time helper: the grid works in the browser's zone, so fixtures are
 * built the same way rather than through `Date.parse` of a UTC string. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute);
}

function occurrence(
  start: Date,
  end: Date,
  options: { readonly allDay?: boolean; readonly id?: string } = {},
): EventOccurrenceView {
  const event = {
    id: options.id ?? "evt",
    calendarId: "cal-1",
    uid: "uid",
    title: "Event",
    description: null,
    location: null,
    time: {
      allDay: options.allDay ?? false,
      startsAt: options.allDay === true ? null : start.toISOString(),
      endsAt: options.allDay === true ? null : end.toISOString(),
      timeZone: options.allDay === true ? null : "UTC",
      startDate: options.allDay === true ? toIsoDate(start) : null,
      endDateExclusive: options.allDay === true ? toIsoDate(end) : null,
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
  } satisfies CalendarEventView;
  return {
    event,
    occurrenceStart: start.toISOString(),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    isOverride: false,
  };
}

describe("date arithmetic", () => {
  test("addMonths does not roll a 31st into the month after next", () => {
    expect(toIsoDate(addMonths(local(2026, 1, 31), 1))).toBe("2026-02-01");
    expect(toIsoDate(addMonths(local(2026, 12, 15), 1))).toBe("2027-01-01");
  });

  test("startOfWeek honors the configured first day", () => {
    // 2026-09-02 is a Wednesday.
    expect(toIsoDate(startOfWeek(local(2026, 9, 2), 0))).toBe("2026-08-30");
    expect(toIsoDate(startOfWeek(local(2026, 9, 2), 1))).toBe("2026-08-31");
  });

  test("fromIsoDate parses into local midnight, not UTC", () => {
    const parsed = fromIsoDate("2026-09-01");
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(8);
    expect(parsed.getDate()).toBe(1);
    expect(parsed.getHours()).toBe(0);
  });

  test("fromDateAndTime combines the two input values", () => {
    const combined = fromDateAndTime("2026-09-01", "09:30");
    expect(combined.getHours()).toBe(9);
    expect(combined.getMinutes()).toBe(30);
    expect(toIsoDate(combined)).toBe("2026-09-01");
  });
});

describe("grid ranges", () => {
  test("a month grid is six whole weeks starting on the configured day", () => {
    const range = monthGridRange(local(2026, 9, 15), 0);
    expect(toIsoDate(range.start)).toBe("2026-08-30");
    expect(toIsoDate(range.end)).toBe("2026-10-11");
    expect(
      Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000),
    ).toBe(42);
  });

  test("a week grid is exactly seven days", () => {
    const range = weekGridRange(local(2026, 9, 2), 1);
    expect(toIsoDate(range.start)).toBe("2026-08-31");
    expect(toIsoDate(range.end)).toBe("2026-09-07");
  });

  test("visibleRange dispatches on the view mode", () => {
    expect(toIsoDate(visibleRange("MONTH", local(2026, 9, 15), 0).start)).toBe(
      "2026-08-30",
    );
    expect(toIsoDate(visibleRange("WEEK", local(2026, 9, 15), 0).start)).toBe(
      "2026-09-13",
    );
  });

  test("the month matrix is always six rows of seven and marks today", () => {
    const matrix = buildMonthMatrix(local(2026, 9, 1), local(2026, 9, 3), 0);
    expect(matrix).toHaveLength(6);
    for (const row of matrix) {
      expect(row).toHaveLength(7);
    }
    expect(matrix[0]?.[0]?.inMonth).toBe(false);
    expect(matrix[0]?.[2]?.inMonth).toBe(true);
    const today = matrix.flat().filter((cell) => cell.isToday);
    expect(today).toHaveLength(1);
    expect(toIsoDate(today[0]?.date ?? new Date(0))).toBe("2026-09-03");
  });

  test("buildWeekDays returns seven consecutive days", () => {
    const days = buildWeekDays(local(2026, 9, 2), 0);
    expect(days.map(toIsoDate)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });
});

describe("day bucketing", () => {
  test("an occurrence ending exactly at midnight belongs to the earlier day", () => {
    const entry = occurrence(local(2026, 9, 1, 22), local(2026, 9, 2, 0));
    expect(occurrenceCoversDay(entry, local(2026, 9, 1))).toBe(true);
    expect(occurrenceCoversDay(entry, local(2026, 9, 2))).toBe(false);
  });

  test("a multi-day occurrence appears on every day it spans", () => {
    const entry = occurrence(local(2026, 9, 1, 22), local(2026, 9, 3, 2));
    for (const day of [1, 2, 3]) {
      expect(occurrenceCoversDay(entry, local(2026, 9, day))).toBe(true);
    }
    expect(occurrenceCoversDay(entry, local(2026, 9, 4))).toBe(false);
  });

  test("a day's occurrences are all-day first, then by start", () => {
    const allDay = occurrence(local(2026, 9, 1), local(2026, 9, 2), {
      allDay: true,
      id: "all-day",
    });
    const late = occurrence(local(2026, 9, 1, 15), local(2026, 9, 1, 16), {
      id: "late",
    });
    const early = occurrence(local(2026, 9, 1, 9), local(2026, 9, 1, 10), {
      id: "early",
    });
    expect(
      occurrencesForDay([late, allDay, early], local(2026, 9, 1)).map(
        (entry) => entry.event.id,
      ),
    ).toEqual(["all-day", "early", "late"]);
  });
});

describe("layoutDayOccurrences", () => {
  test("places a single event by fraction of the day", () => {
    const [placed] = layoutDayOccurrences(
      [occurrence(local(2026, 9, 1, 6), local(2026, 9, 1, 12))],
      local(2026, 9, 1),
    );
    expect(placed?.top).toBeCloseTo(0.25, 5);
    expect(placed?.height).toBeCloseTo(0.25, 5);
    expect(placed?.columns).toBe(1);
    expect(placed?.column).toBe(0);
  });

  test("splits overlapping events into columns", () => {
    const placed = layoutDayOccurrences(
      [
        occurrence(local(2026, 9, 1, 9), local(2026, 9, 1, 11), { id: "a" }),
        occurrence(local(2026, 9, 1, 10), local(2026, 9, 1, 12), { id: "b" }),
      ],
      local(2026, 9, 1),
    );
    expect(placed.map((entry) => entry.column)).toEqual([0, 1]);
    expect(placed.every((entry) => entry.columns === 2)).toBe(true);
  });

  test("reuses a column once the previous event has ended", () => {
    const placed = layoutDayOccurrences(
      [
        occurrence(local(2026, 9, 1, 9), local(2026, 9, 1, 10), { id: "a" }),
        occurrence(local(2026, 9, 1, 10), local(2026, 9, 1, 11), { id: "b" }),
      ],
      local(2026, 9, 1),
    );
    expect(placed.map((entry) => entry.column)).toEqual([0, 0]);
    expect(placed.every((entry) => entry.columns === 1)).toBe(true);
  });

  test("clamps a multi-day event to the day it is rendered on", () => {
    const [placed] = layoutDayOccurrences(
      [occurrence(local(2026, 9, 1, 22), local(2026, 9, 3, 2))],
      local(2026, 9, 2),
    );
    expect(placed?.top).toBeCloseTo(0, 5);
    expect(placed?.height).toBeCloseTo(1, 5);
  });

  test("excludes all-day events from the timed layout", () => {
    expect(
      layoutDayOccurrences(
        [occurrence(local(2026, 9, 1), local(2026, 9, 2), { allDay: true })],
        local(2026, 9, 1),
      ),
    ).toEqual([]);
  });

  test("gives a zero-length event a visible minimum height", () => {
    const [placed] = layoutDayOccurrences(
      [occurrence(local(2026, 9, 1, 9), local(2026, 9, 1, 9))],
      local(2026, 9, 1),
    );
    expect(placed?.height).toBeGreaterThan(0);
  });

  test("addDays crosses a month boundary", () => {
    expect(toIsoDate(addDays(local(2026, 8, 31), 1))).toBe("2026-09-01");
  });
});
