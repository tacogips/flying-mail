import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createIsoDate } from "../value-objects/iso-date";
import {
  createCalendarEventId,
  createCalendarId,
  createEventLinkId,
} from "../value-objects/ids";
import { createRecurrenceRule } from "../value-objects/recurrence";
import { createTimeZoneId } from "../value-objects/time-zone";
import {
  createCalendarEvent,
  eventTimeBoundsUtc,
  isOverrideEvent,
  isRecurringMaster,
  MAX_EVENT_TITLE_LENGTH,
} from "./calendar-event";

const base = {
  id: createCalendarEventId("evt-1"),
  calendarId: createCalendarId("cal-1"),
  uid: "uid-1",
  title: "Design review",
  createdAt: "2026-08-24T00:00:00.000Z",
};

const timed = {
  kind: "TIMED",
  startsAt: Date.parse("2026-09-01T09:00:00Z"),
  endsAt: Date.parse("2026-09-01T10:00:00Z"),
  timeZone: createTimeZoneId("Asia/Tokyo"),
} as const;

const allDay = {
  kind: "ALL_DAY",
  startDate: createIsoDate("2026-09-01"),
  endDateExclusive: createIsoDate("2026-09-03"),
} as const;

describe("createCalendarEvent", () => {
  it("normalizes text fields", () => {
    const event = createCalendarEvent({
      ...base,
      title: "  Design review  ",
      description: "   ",
      location: " Room 1 ",
      time: timed,
    });
    expect(event.title).toBe("Design review");
    expect(event.description).toBeNull();
    expect(event.location).toBe("Room 1");
    expect(event.recurrence).toBeNull();
    expect(event.overrideOf).toBeNull();
  });

  it("rejects an empty or over-long title", () => {
    expect(() =>
      createCalendarEvent({ ...base, title: "  ", time: timed }),
    ).toThrow(ValidationError);
    expect(() =>
      createCalendarEvent({
        ...base,
        title: "a".repeat(MAX_EVENT_TITLE_LENGTH + 1),
        time: timed,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an end at or before the start", () => {
    expect(() =>
      createCalendarEvent({
        ...base,
        time: { ...timed, endsAt: timed.startsAt },
      }),
    ).toThrow(ValidationError);
  });

  it("rejects an all-day end date at or before the start date", () => {
    expect(() =>
      createCalendarEvent({
        ...base,
        time: {
          kind: "ALL_DAY",
          startDate: createIsoDate("2026-09-03"),
          endDateExclusive: createIsoDate("2026-09-03"),
        },
      }),
    ).toThrow(ValidationError);
  });

  it("accepts a valid all-day range", () => {
    const event = createCalendarEvent({ ...base, time: allDay });
    expect(event.time.kind).toBe("ALL_DAY");
  });

  it("rejects an override that also carries a recurrence rule", () => {
    expect(() =>
      createCalendarEvent({
        ...base,
        time: timed,
        recurrence: createRecurrenceRule({ freq: "DAILY" }),
        overrideOf: {
          parentEventId: createCalendarEventId("evt-master"),
          recurrenceInstanceStart: timed.startsAt,
        },
      }),
    ).toThrow(ValidationError);
  });

  it("requires the override instance start to match the time kind", () => {
    expect(() =>
      createCalendarEvent({
        ...base,
        time: allDay,
        overrideOf: {
          parentEventId: createCalendarEventId("evt-master"),
          recurrenceInstanceStart: 12345,
        },
      }),
    ).toThrow(ValidationError);
  });

  it("deduplicates and normalizes mentions, with no status field", () => {
    const event = createCalendarEvent({
      ...base,
      time: timed,
      mentions: ["Taco@Example.com", "taco@example.com", "other@example.com"],
    });
    expect(event.mentions).toEqual(["taco@example.com", "other@example.com"]);
    for (const mention of event.mentions) {
      expect(typeof mention).toBe("string");
    }
  });

  it("rejects a malformed mention", () => {
    expect(() =>
      createCalendarEvent({ ...base, time: timed, mentions: ["not-an-email"] }),
    ).toThrow(ValidationError);
  });

  it("rejects non-http(s) link urls", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "/relative",
    ]) {
      expect(() =>
        createCalendarEvent({
          ...base,
          time: timed,
          links: [{ id: createEventLinkId("lnk-1"), url }],
        }),
      ).toThrow(ValidationError);
    }
  });

  it("renumbers link positions from array order", () => {
    const event = createCalendarEvent({
      ...base,
      time: timed,
      links: [
        { id: createEventLinkId("lnk-1"), url: "https://example.com/a" },
        {
          id: createEventLinkId("lnk-2"),
          url: "https://example.com/b",
          title: " Spec ",
        },
      ],
    });
    expect(event.links.map((link) => link.position)).toEqual([0, 1]);
    expect(event.links[1]?.title).toBe("Spec");
  });

  it("sorts and deduplicates exdates", () => {
    const event = createCalendarEvent({
      ...base,
      time: timed,
      recurrence: createRecurrenceRule({ freq: "DAILY" }),
      exdates: [3000, 1000, 3000],
    });
    expect(event.exdates).toEqual([1000, 3000]);
  });

  it("rejects exdates of the wrong kind", () => {
    expect(() =>
      createCalendarEvent({ ...base, time: allDay, exdates: [1000] }),
    ).toThrow(ValidationError);
    expect(() =>
      createCalendarEvent({
        ...base,
        time: timed,
        exdates: [createIsoDate("2026-09-01")],
      }),
    ).toThrow(ValidationError);
  });
});

describe("event helpers", () => {
  it("reports UTC bounds for both time kinds", () => {
    expect(eventTimeBoundsUtc(timed)).toEqual({
      startUtc: timed.startsAt,
      endUtc: timed.endsAt,
    });
    expect(eventTimeBoundsUtc(allDay)).toEqual({
      startUtc: Date.parse("2026-09-01T00:00:00Z"),
      endUtc: Date.parse("2026-09-03T00:00:00Z"),
    });
  });

  it("classifies masters and overrides", () => {
    const master = createCalendarEvent({
      ...base,
      time: timed,
      recurrence: createRecurrenceRule({ freq: "DAILY" }),
    });
    expect(isRecurringMaster(master)).toBe(true);
    expect(isOverrideEvent(master)).toBe(false);

    const override = createCalendarEvent({
      ...base,
      id: createCalendarEventId("evt-2"),
      time: timed,
      overrideOf: {
        parentEventId: master.id,
        recurrenceInstanceStart: timed.startsAt,
      },
    });
    expect(isOverrideEvent(override)).toBe(true);
  });
});
