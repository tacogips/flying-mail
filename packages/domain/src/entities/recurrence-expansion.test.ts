import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createIsoDate } from "../value-objects/iso-date";
import { createCalendarEventId, createCalendarId } from "../value-objects/ids";
import { parseRecurrenceRule } from "../value-objects/recurrence";
import { createTimeZoneId } from "../value-objects/time-zone";
import {
  type CalendarEvent,
  createCalendarEvent,
  type EventTime,
} from "./calendar-event";
import {
  applyOverrides,
  expandOccurrences,
  MAX_EXPANSION_RANGE_DAYS,
  wallClockToUtc,
} from "./recurrence-expansion";

const DAY_MS = 86_400_000;

function event(options: {
  readonly time: EventTime;
  readonly rrule?: string;
  readonly exdates?: readonly (number | string)[];
  readonly id?: string;
}): CalendarEvent {
  const rule =
    options.rrule === undefined ? null : parseRecurrenceRule(options.rrule);
  if (options.rrule !== undefined && rule === null) {
    throw new Error(`test rrule not supported: ${options.rrule}`);
  }
  return createCalendarEvent({
    id: createCalendarEventId(options.id ?? "evt-1"),
    calendarId: createCalendarId("cal-1"),
    uid: "uid-1",
    title: "Standup",
    time: options.time,
    recurrence: rule,
    ...(options.exdates === undefined
      ? {}
      : { exdates: options.exdates as readonly never[] }),
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function timed(
  startIso: string,
  durationMinutes: number,
  zone: string,
): EventTime {
  const startsAt = Date.parse(startIso);
  return {
    kind: "TIMED",
    startsAt,
    endsAt: startsAt + durationMinutes * 60_000,
    timeZone: createTimeZoneId(zone),
  };
}

function allDay(start: string, endExclusive: string): EventTime {
  return {
    kind: "ALL_DAY",
    startDate: createIsoDate(start),
    endDateExclusive: createIsoDate(endExclusive),
  };
}

function starts(result: {
  readonly occurrences: readonly { readonly startUtc: number }[];
}): readonly string[] {
  return result.occurrences.map((occurrence) =>
    new Date(occurrence.startUtc).toISOString(),
  );
}

describe("expandOccurrences - non-recurring", () => {
  it("returns the single occurrence when it overlaps the range", () => {
    const single = event({ time: timed("2026-03-10T09:00:00Z", 60, "UTC") });
    const result = expandOccurrences(
      single,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-04-01T00:00:00Z"),
    );
    expect(starts(result)).toEqual(["2026-03-10T09:00:00.000Z"]);
    expect(result.truncated).toBe(false);
  });

  it("returns nothing outside the range", () => {
    const single = event({ time: timed("2026-03-10T09:00:00Z", 60, "UTC") });
    const result = expandOccurrences(
      single,
      Date.parse("2026-04-01T00:00:00Z"),
      Date.parse("2026-05-01T00:00:00Z"),
    );
    expect(result.occurrences).toHaveLength(0);
  });

  it("includes an event that merely overlaps the range boundary", () => {
    const long = event({ time: timed("2026-03-10T09:00:00Z", 60 * 48, "UTC") });
    const result = expandOccurrences(
      long,
      Date.parse("2026-03-11T00:00:00Z"),
      Date.parse("2026-03-12T00:00:00Z"),
    );
    expect(result.occurrences).toHaveLength(1);
  });
});

describe("expandOccurrences - frequencies", () => {
  it("expands DAILY with INTERVAL", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;INTERVAL=2",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-09T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-04T09:00:00.000Z",
      "2026-03-06T09:00:00.000Z",
      "2026-03-08T09:00:00.000Z",
    ]);
  });

  it("expands WEEKLY with BYDAY", () => {
    // 2026-03-02 is a Monday.
    const weekly = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
    });
    const result = expandOccurrences(
      weekly,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-15T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-04T09:00:00.000Z",
      "2026-03-09T09:00:00.000Z",
      "2026-03-11T09:00:00.000Z",
    ]);
  });

  it("honors WEEKLY INTERVAL alignment", () => {
    const biweekly = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    });
    const result = expandOccurrences(
      biweekly,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-04-05T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-16T09:00:00.000Z",
      "2026-03-30T09:00:00.000Z",
    ]);
  });

  it("expands WEEKLY without BYDAY on the seed weekday only", () => {
    const weekly = event({
      time: timed("2026-03-04T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=WEEKLY",
    });
    const result = expandOccurrences(
      weekly,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-20T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-03-04T09:00:00.000Z",
      "2026-03-11T09:00:00.000Z",
      "2026-03-18T09:00:00.000Z",
    ]);
  });

  it("expands MONTHLY on the seed day of month", () => {
    const monthly = event({
      time: timed("2026-01-15T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=MONTHLY",
    });
    const result = expandOccurrences(
      monthly,
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-05-01T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-01-15T09:00:00.000Z",
      "2026-02-15T09:00:00.000Z",
      "2026-03-15T09:00:00.000Z",
      "2026-04-15T09:00:00.000Z",
    ]);
  });

  it("skips months without the requested BYMONTHDAY", () => {
    const monthly = event({
      time: timed("2026-01-31T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
    });
    const result = expandOccurrences(
      monthly,
      Date.parse("2026-01-01T00:00:00Z"),
      Date.parse("2026-05-01T00:00:00Z"),
    );
    // February has no 31st, so it is skipped entirely -- never rolled into
    // March 3rd, which is what naive date arithmetic would do.
    expect(starts(result)).toEqual([
      "2026-01-31T09:00:00.000Z",
      "2026-03-31T09:00:00.000Z",
    ]);
  });

  it("expands YEARLY with BYMONTH and BYMONTHDAY", () => {
    const yearly = event({
      time: timed("2026-03-15T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
    });
    const result = expandOccurrences(
      yearly,
      Date.parse("2027-01-01T00:00:00Z"),
      Date.parse("2027-12-31T00:00:00Z"),
    );
    expect(starts(result)).toEqual(["2027-03-15T09:00:00.000Z"]);
  });
});

describe("expandOccurrences - COUNT, UNTIL and EXDATE", () => {
  it("stops after COUNT occurrences", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-30T00:00:00Z"),
    );
    expect(starts(result)).toHaveLength(3);
  });

  it("consumes COUNT before EXDATE filtering", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;COUNT=3",
      exdates: [Date.parse("2026-03-03T09:00:00Z")],
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-30T00:00:00Z"),
    );
    // An EXDATE shortens the series; it never extends it to a 4th day.
    expect(starts(result)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-04T09:00:00.000Z",
    ]);
  });

  it("stops at UNTIL inclusive", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;UNTIL=20260304T090000Z",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-30T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      "2026-03-02T09:00:00.000Z",
      "2026-03-03T09:00:00.000Z",
      "2026-03-04T09:00:00.000Z",
    ]);
  });
});

describe("expandOccurrences - DST", () => {
  it("shifts a nonexistent spring-forward local time forward by the gap", () => {
    // 2026-03-08 02:00 -> 03:00 in America/New_York.
    const daily = event({
      time: timed("2026-03-07T07:30:00Z", 60, "America/New_York"),
      rrule: "FREQ=DAILY",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-07T00:00:00Z"),
      Date.parse("2026-03-10T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      // 02:30 EST
      "2026-03-07T07:30:00.000Z",
      // 02:30 does not exist; shifted to 03:30 EDT
      "2026-03-08T07:30:00.000Z",
      // 02:30 EDT
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("takes the earlier offset for an ambiguous fall-back local time", () => {
    // 2026-11-01 02:00 -> 01:00 in America/New_York.
    const daily = event({
      time: timed("2026-10-31T05:30:00Z", 60, "America/New_York"),
      rrule: "FREQ=DAILY",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-10-31T00:00:00Z"),
      Date.parse("2026-11-03T00:00:00Z"),
    );
    expect(starts(result)).toEqual([
      // 01:30 EDT
      "2026-10-31T05:30:00.000Z",
      // 01:30 occurs twice; the earlier (EDT) instant is used
      "2026-11-01T05:30:00.000Z",
      // 01:30 EST
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("keeps a Asia/Tokyo series stable across the year (no DST)", () => {
    const weekly = event({
      time: timed("2026-03-02T00:00:00Z", 60, "Asia/Tokyo"),
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    const result = expandOccurrences(
      weekly,
      Date.parse("2026-06-01T00:00:00Z"),
      Date.parse("2026-06-22T00:00:00Z"),
    );
    // 09:00 JST every Monday, i.e. 00:00 UTC.
    expect(starts(result)).toEqual([
      "2026-06-01T00:00:00.000Z",
      "2026-06-08T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    ]);
  });

  it("preserves duration across a DST transition", () => {
    const daily = event({
      time: timed("2026-03-07T07:30:00Z", 60, "America/New_York"),
      rrule: "FREQ=DAILY",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-07T00:00:00Z"),
      Date.parse("2026-03-10T00:00:00Z"),
    );
    for (const occurrence of result.occurrences) {
      expect(occurrence.endUtc - occurrence.startUtc).toBe(60 * 60_000);
    }
  });
});

describe("wallClockToUtc", () => {
  it("round-trips an ordinary local time", () => {
    expect(
      wallClockToUtc(
        { year: 2026, month: 6, day: 1, hour: 9, minute: 0, second: 0 },
        createTimeZoneId("Asia/Tokyo"),
      ),
    ).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });
});

describe("expandOccurrences - all-day", () => {
  it("expands a multi-day all-day series without time-zone math", () => {
    const series = event({
      time: allDay("2026-03-02", "2026-03-05"),
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    });
    const result = expandOccurrences(
      series,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-20T00:00:00Z"),
    );
    expect(
      result.occurrences.map((occurrence) => [
        occurrence.startDate,
        occurrence.endDateExclusive,
      ]),
    ).toEqual([
      ["2026-03-02", "2026-03-05"],
      ["2026-03-09", "2026-03-12"],
      ["2026-03-16", "2026-03-19"],
    ]);
  });

  it("excludes all-day occurrences by ISO date EXDATE", () => {
    const series = event({
      time: allDay("2026-03-02", "2026-03-03"),
      rrule: "FREQ=DAILY;COUNT=3",
      exdates: ["2026-03-03"],
    });
    const result = expandOccurrences(
      series,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-10T00:00:00Z"),
    );
    expect(
      result.occurrences.map((occurrence) => occurrence.startDate),
    ).toEqual(["2026-03-02", "2026-03-04"]);
  });
});

describe("expandOccurrences - limits", () => {
  it("rejects a range wider than the hard cap", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY",
    });
    expect(() =>
      expandOccurrences(
        daily,
        Date.parse("2026-01-01T00:00:00Z"),
        Date.parse("2026-01-01T00:00:00Z") +
          (MAX_EXPANSION_RANGE_DAYS + 1) * DAY_MS,
      ),
    ).toThrow(ValidationError);
  });

  it("rejects an inverted range", () => {
    const daily = event({ time: timed("2026-03-02T09:00:00Z", 30, "UTC") });
    expect(() =>
      expandOccurrences(daily, Date.parse("2026-03-02T00:00:00Z"), 0),
    ).toThrow(ValidationError);
  });

  it("truncates and reports when the occurrence cap is hit", () => {
    const daily = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-04-01T00:00:00Z"),
      { maxOccurrences: 5 },
    );
    expect(result.occurrences).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("reaches a range far after a long-running series start", () => {
    const daily = event({
      time: timed("1998-01-01T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;INTERVAL=7",
    });
    const result = expandOccurrences(
      daily,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-31T00:00:00Z"),
    );
    expect(result.occurrences.length).toBeGreaterThan(0);
    for (const occurrence of result.occurrences) {
      const days = Math.round(
        (occurrence.startUtc - Date.parse("1998-01-01T09:00:00Z")) / DAY_MS,
      );
      expect(days % 7).toBe(0);
    }
  });
});

describe("applyOverrides", () => {
  it("substitutes an override for its instance", () => {
    const master = event({
      time: timed("2026-03-02T09:00:00Z", 30, "UTC"),
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const override = createCalendarEvent({
      id: createCalendarEventId("evt-override"),
      calendarId: createCalendarId("cal-1"),
      uid: "uid-1",
      title: "Standup (moved)",
      time: timed("2026-03-03T15:00:00Z", 30, "UTC"),
      overrideOf: {
        parentEventId: master.id,
        recurrenceInstanceStart: Date.parse("2026-03-03T09:00:00Z"),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const expansion = expandOccurrences(
      master,
      Date.parse("2026-03-01T00:00:00Z"),
      Date.parse("2026-03-10T00:00:00Z"),
    );
    const applied = applyOverrides(master, [override], expansion.occurrences);
    expect(applied.map((entry) => entry.event.title)).toEqual([
      "Standup",
      "Standup (moved)",
      "Standup",
    ]);
    expect(new Date(applied[1]?.occurrence.startUtc ?? 0).toISOString()).toBe(
      "2026-03-03T15:00:00.000Z",
    );
  });
});
