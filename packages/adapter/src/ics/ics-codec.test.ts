import {
  type CalendarEvent,
  createCalendarEvent,
} from "@mailcal/domain/entities/calendar-event";
import {
  createCalendarEventId,
  createCalendarId,
  createEventLinkId,
} from "@mailcal/domain/value-objects/ids";
import { createIsoDate } from "@mailcal/domain/value-objects/iso-date";
import { createRecurrenceRule } from "@mailcal/domain/value-objects/recurrence";
import { createTimeZoneId } from "@mailcal/domain/value-objects/time-zone";
import { describe, expect, test } from "vitest";
import { createIcsCodec } from "./ics-codec";

const codec = createIcsCodec();
const DTSTAMP = new Date("2026-08-24T10:00:00.000Z");
const TOKYO = createTimeZoneId("Asia/Tokyo");

function timedEvent(
  overrides: Partial<Parameters<typeof createCalendarEvent>[0]> = {},
): CalendarEvent {
  return createCalendarEvent({
    id: createCalendarEventId("evt-1"),
    calendarId: createCalendarId("cal-1"),
    uid: "uid-1@mailcal",
    title: "Standup",
    time: {
      kind: "TIMED",
      // 2026-09-01 09:00 Asia/Tokyo
      startsAt: Date.parse("2026-09-01T00:00:00.000Z"),
      endsAt: Date.parse("2026-09-01T00:30:00.000Z"),
      timeZone: TOKYO,
    },
    createdAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  });
}

function lines(ics: string): readonly string[] {
  return ics.split("\r\n");
}

/** Unfolds before matching, so assertions are about properties rather than
 * about where the 75-octet fold happened to land. */
function unfolded(ics: string): readonly string[] {
  const result: string[] = [];
  for (const line of ics.split("\r\n")) {
    if (line.startsWith(" ") && result.length > 0) {
      result[result.length - 1] += line.slice(1);
      continue;
    }
    if (line.length > 0) {
      result.push(line);
    }
  }
  return result;
}

describe("ics codec serialization", () => {
  test("writes a timed event with TZID-qualified local times", () => {
    const ics = codec.serializeEvent(timedEvent(), { dtstamp: DTSTAMP });
    expect(unfolded(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mailcal//calendar//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:uid-1@mailcal",
      "DTSTAMP:20260824T100000Z",
      "DTSTART;TZID=Asia/Tokyo:20260901T090000",
      "DTEND;TZID=Asia/Tokyo:20260901T093000",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  test("writes an all-day event with VALUE=DATE bounds", () => {
    const event = timedEvent({
      time: {
        kind: "ALL_DAY",
        startDate: createIsoDate("2026-09-01"),
        endDateExclusive: createIsoDate("2026-09-03"),
      },
    });
    const ics = codec.serializeEvent(event, { dtstamp: DTSTAMP });
    expect(unfolded(ics)).toContain("DTSTART;VALUE=DATE:20260901");
    expect(unfolded(ics)).toContain("DTEND;VALUE=DATE:20260903");
  });

  test("never emits ATTENDEE, PARTSTAT or RSVP for mentions", () => {
    const ics = codec.serializeEvent(
      timedEvent({ mentions: ["Taco@Example.com", "ops@example.com"] }),
      { dtstamp: DTSTAMP },
    );
    expect(ics).not.toMatch(/ATTENDEE/);
    expect(ics).not.toMatch(/PARTSTAT/);
    expect(ics).not.toMatch(/RSVP/);
    expect(unfolded(ics)).toContain(
      "X-MAILCAL-MENTION:mailto:taco@example.com",
    );
    expect(unfolded(ics)).toContain("X-MAILCAL-MENTION:mailto:ops@example.com");
  });

  test("emits URL for the first link and X-MAILCAL-LINK for every link", () => {
    const ics = codec.serializeEvent(
      timedEvent({
        links: [
          {
            id: createEventLinkId("lnk-1"),
            url: "https://example.com/agenda",
            title: "Agenda",
          },
          { id: createEventLinkId("lnk-2"), url: "https://example.com/notes" },
        ],
      }),
      { dtstamp: DTSTAMP },
    );
    const properties = unfolded(ics);
    expect(properties).toContain("URL:https://example.com/agenda");
    expect(properties).toContain(
      "X-MAILCAL-LINK;X-TITLE=Agenda:https://example.com/agenda",
    );
    expect(properties).toContain("X-MAILCAL-LINK:https://example.com/notes");
  });

  test("escapes TEXT values and folds at 75 octets", () => {
    const ics = codec.serializeEvent(
      timedEvent({
        description: "line one\nline; two, with \\ backslash",
        location: "x".repeat(200),
      }),
      { dtstamp: DTSTAMP },
    );
    expect(unfolded(ics)).toContain(
      "DESCRIPTION:line one\\nline\\; two\\, with \\\\ backslash",
    );
    for (const line of lines(ics)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  test("writes RRULE, EXDATE and RECURRENCE-ID in the event time zone", () => {
    const master = timedEvent({
      recurrence: createRecurrenceRule({ freq: "WEEKLY", byDay: ["TU"] }),
      exdates: [Date.parse("2026-09-08T00:00:00.000Z")],
    });
    const properties = unfolded(
      codec.serializeEvent(master, { dtstamp: DTSTAMP }),
    );
    expect(properties).toContain("RRULE:FREQ=WEEKLY;BYDAY=TU");
    expect(properties).toContain("EXDATE;TZID=Asia/Tokyo:20260908T090000");

    const override = timedEvent({
      id: createCalendarEventId("evt-2"),
      overrideOf: {
        parentEventId: createCalendarEventId("evt-1"),
        recurrenceInstanceStart: Date.parse("2026-09-15T00:00:00.000Z"),
      },
    });
    expect(
      unfolded(codec.serializeEvent(override, { dtstamp: DTSTAMP })),
    ).toContain("RECURRENCE-ID;TZID=Asia/Tokyo:20260915T090000");
  });
});

describe("ics codec parsing", () => {
  test("round-trips a timed recurring event through its own output", () => {
    const event = timedEvent({
      description: "Daily sync; with, punctuation",
      location: "Room 1",
      recurrence: createRecurrenceRule({
        freq: "WEEKLY",
        interval: 2,
        byDay: ["TU", "TH"],
      }),
      exdates: [Date.parse("2026-09-15T00:00:00.000Z")],
      mentions: ["taco@example.com"],
      links: [
        {
          id: createEventLinkId("lnk-1"),
          url: "https://example.com/agenda",
          title: "Agenda",
        },
      ],
    });
    const parsed = codec.parseCalendarObject(
      codec.serializeEvent(event, { dtstamp: DTSTAMP }),
    );
    expect(parsed).toHaveLength(1);
    const first = parsed[0];
    if (first === undefined) {
      throw new Error("expected one parsed event");
    }
    expect(first.uid).toBe(event.uid);
    expect(first.title).toBe(event.title);
    expect(first.description).toBe(event.description);
    expect(first.location).toBe(event.location);
    expect(first.time).toEqual(event.time);
    expect(first.recurrence).toEqual(event.recurrence);
    expect(first.exdates).toEqual(event.exdates);
    expect(first.mentions).toEqual(["taco@example.com"]);
    expect(first.links).toEqual([
      { url: "https://example.com/agenda", title: "Agenda" },
    ]);
    expect(first.recurrenceUnsupported).toBe(false);
    expect(first.warnings).toEqual([]);
  });

  test("round-trips an all-day event", () => {
    const event = timedEvent({
      time: {
        kind: "ALL_DAY",
        startDate: createIsoDate("2026-09-01"),
        endDateExclusive: createIsoDate("2026-09-03"),
      },
      exdates: [createIsoDate("2026-09-08")],
      recurrence: createRecurrenceRule({ freq: "WEEKLY" }),
    });
    const parsed = codec.parseCalendarObject(
      codec.serializeEvent(event, { dtstamp: DTSTAMP }),
    );
    expect(parsed[0]?.time).toEqual(event.time);
    expect(parsed[0]?.exdates).toEqual(["2026-09-08"]);
  });

  test("maps iCloud ATTENDEE lines to mentions and drops PARTSTAT/RSVP/CN", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Apple Inc.//iOS 18.0//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Tokyo",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0900",
      "TZOFFSETTO:+0900",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:remote-1",
      "DTSTAMP:20260824T090000Z",
      "DTSTART;TZID=Asia/Tokyo:20260901T090000",
      "DTEND;TZID=Asia/Tokyo:20260901T100000",
      "SUMMARY:Remote meeting",
      'ATTENDEE;CN="Taco";PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:tac',
      " o@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:ops@example.com",
      "ORGANIZER:mailto:organizer@example.com",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const parsed = codec.parseCalendarObject(ics);
    expect(parsed).toHaveLength(1);
    const event = parsed[0];
    if (event === undefined) {
      throw new Error("expected one parsed event");
    }
    expect(event.mentions).toEqual(["taco@example.com", "ops@example.com"]);
    expect(event.time).toEqual({
      kind: "TIMED",
      startsAt: Date.parse("2026-09-01T00:00:00.000Z"),
      endsAt: Date.parse("2026-09-01T01:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    expect(JSON.stringify(event)).not.toMatch(/PARTSTAT|RSVP|Taco/);
  });

  test("parses a master plus its override from one calendar object", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-1",
      "DTSTART;TZID=Asia/Tokyo:20260901T090000",
      "DTEND;TZID=Asia/Tokyo:20260901T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
      "EXDATE;TZID=Asia/Tokyo:20260922T090000,20260929T090000",
      "SUMMARY:Series",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series-1",
      "RECURRENCE-ID;TZID=Asia/Tokyo:20260908T090000",
      "DTSTART;TZID=Asia/Tokyo:20260908T100000",
      "DTEND;TZID=Asia/Tokyo:20260908T103000",
      "SUMMARY:Moved instance",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const parsed = codec.parseCalendarObject(ics);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.recurrenceInstanceStart).toBeNull();
    expect(parsed[0]?.exdates).toEqual([
      Date.parse("2026-09-22T00:00:00.000Z"),
      Date.parse("2026-09-29T00:00:00.000Z"),
    ]);
    expect(parsed[1]?.recurrenceInstanceStart).toBe(
      Date.parse("2026-09-08T00:00:00.000Z"),
    );
    expect(parsed[1]?.title).toBe("Moved instance");
  });

  test("flags an unsupported RRULE and imports the event as non-recurring", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:odd-1",
      "DTSTART:20260901T000000Z",
      "DTEND:20260901T003000Z",
      "RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR",
      "SUMMARY:Last Friday",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const event = codec.parseCalendarObject(ics)[0];
    expect(event?.recurrence).toBeNull();
    expect(event?.recurrenceUnsupported).toBe(true);
    expect(event?.warnings).toEqual([
      {
        kind: "RECURRENCE_UNSUPPORTED",
        uid: "odd-1",
        value: "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR",
      },
    ]);
  });

  test("falls back to UTC and warns for an unknown TZID", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:zone-1",
      "DTSTART;TZID=Mars/Olympus:20260901T090000",
      "DTEND;TZID=Mars/Olympus:20260901T100000",
      "SUMMARY:Off world",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const event = codec.parseCalendarObject(ics)[0];
    expect(event?.time).toEqual({
      kind: "TIMED",
      startsAt: Date.parse("2026-09-01T09:00:00.000Z"),
      endsAt: Date.parse("2026-09-01T10:00:00.000Z"),
      timeZone: "UTC",
    });
    expect(event?.warnings).toEqual([
      { kind: "UNKNOWN_TIME_ZONE", uid: "zone-1", value: "Mars/Olympus" },
    ]);
  });

  test("derives an end from DURATION and from RFC defaults", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:dur-1",
      "DTSTART:20260901T090000Z",
      "DURATION:PT1H30M",
      "SUMMARY:With duration",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:dur-2",
      "DTSTART;VALUE=DATE:20260901",
      "SUMMARY:Bare all day",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const parsed = codec.parseCalendarObject(ics);
    expect(parsed[0]?.time).toEqual({
      kind: "TIMED",
      startsAt: Date.parse("2026-09-01T09:00:00.000Z"),
      endsAt: Date.parse("2026-09-01T10:30:00.000Z"),
      timeZone: "UTC",
    });
    expect(parsed[1]?.time).toEqual({
      kind: "ALL_DAY",
      startDate: "2026-09-01",
      endDateExclusive: "2026-09-02",
    });
  });

  test("skips objects without a UID or DTSTART", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260901T090000Z",
      "SUMMARY:No uid",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:no-start",
      "SUMMARY:No start",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(codec.parseCalendarObject(ics)).toEqual([]);
  });
});

describe("serializeCalendarObject", () => {
  test("emits one VCALENDAR with a VEVENT per component, master first", () => {
    const master = timedEvent({
      uid: "series-1",
      recurrence: createRecurrenceRule({ freq: "WEEKLY" }),
    });
    const override = timedEvent({
      id: createCalendarEventId("evt-2"),
      uid: "series-1",
      title: "Moved instance",
      overrideOf: {
        parentEventId: createCalendarEventId("evt-1"),
        recurrenceInstanceStart: Date.parse("2026-09-08T00:00:00.000Z"),
      },
    });

    // Deliberately out of order: RFC 4791 lets a server return components in
    // any order, and an override can only be attached to a series that has
    // already been read.
    const ics = codec.serializeCalendarObject([override, master], {
      dtstamp: DTSTAMP,
    });
    const properties = unfolded(ics);

    expect(
      properties.filter((line) => line === "BEGIN:VCALENDAR"),
    ).toHaveLength(1);
    expect(properties.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(
      2,
    );
    expect(properties.filter((line) => line === "END:VEVENT")).toHaveLength(2);
    expect(properties.indexOf("RRULE:FREQ=WEEKLY")).toBeLessThan(
      properties.indexOf("RECURRENCE-ID;TZID=Asia/Tokyo:20260908T090000"),
    );

    // Round-trips back to both components, in master-first order.
    const parsed = codec.parseCalendarObject(ics);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.recurrenceInstanceStart).toBeNull();
    expect(parsed[1]?.recurrenceInstanceStart).toBe(
      Date.parse("2026-09-08T00:00:00.000Z"),
    );
    expect(parsed.every((event) => event.uid === "series-1")).toBe(true);
  });

  test("a lone event serializes identically to serializeEvent", () => {
    const event = timedEvent();
    expect(codec.serializeCalendarObject([event], { dtstamp: DTSTAMP })).toBe(
      codec.serializeEvent(event, { dtstamp: DTSTAMP }),
    );
  });

  test("still emits no ATTENDEE for a grouped resource", () => {
    const ics = codec.serializeCalendarObject(
      [timedEvent({ mentions: ["taco@example.com"] })],
      { dtstamp: DTSTAMP },
    );
    expect(ics).not.toMatch(/ATTENDEE|PARTSTAT|RSVP/);
  });
});
