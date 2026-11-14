import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import {
  createRecurrenceRule,
  formatIcsUtcDateTime,
  formatRecurrenceRule,
  parseIcsDateTime,
  parseRecurrenceRule,
} from "./recurrence";

describe("parseRecurrenceRule", () => {
  it("parses the supported parts", () => {
    const rule = parseRecurrenceRule(
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=SU",
    );
    expect(rule).not.toBeNull();
    expect(rule?.freq).toBe("WEEKLY");
    expect(rule?.interval).toBe(2);
    expect(rule?.byDay).toEqual(["MO", "WE"]);
    expect(rule?.weekStart).toBe("SU");
  });

  it("defaults interval to 1 and weekStart to MO", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY");
    expect(rule?.interval).toBe(1);
    expect(rule?.weekStart).toBe("MO");
    expect(rule?.count).toBeUndefined();
    expect(rule?.untilUtc).toBeUndefined();
  });

  it("parses COUNT and UNTIL", () => {
    expect(parseRecurrenceRule("FREQ=DAILY;COUNT=5")?.count).toBe(5);
    expect(
      parseRecurrenceRule("FREQ=DAILY;UNTIL=20260401T000000Z")?.untilUtc,
    ).toBe(Date.UTC(2026, 3, 1));
  });

  it("parses BYMONTHDAY and BYMONTH", () => {
    const rule = parseRecurrenceRule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15");
    expect(rule?.byMonth).toEqual([3]);
    expect(rule?.byMonthDay).toEqual([15]);
  });

  it.each([
    ["unsupported frequency", "FREQ=SECONDLY"],
    ["BYSETPOS", "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR"],
    ["BYWEEKNO", "FREQ=YEARLY;BYWEEKNO=20"],
    ["BYHOUR", "FREQ=DAILY;BYHOUR=9"],
    ["ordinal BYDAY", "FREQ=MONTHLY;BYDAY=-1SU"],
    ["negative BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=-1"],
    ["out-of-range BYMONTH", "FREQ=YEARLY;BYMONTH=13"],
    ["COUNT and UNTIL together", "FREQ=DAILY;COUNT=2;UNTIL=20260401T000000Z"],
    ["interval zero", "FREQ=DAILY;INTERVAL=0"],
    ["missing FREQ", "INTERVAL=2"],
    ["malformed part", "FREQ=DAILY;NONSENSE"],
    ["empty", ""],
  ])("returns null for %s", (_label, rrule) => {
    expect(parseRecurrenceRule(rrule)).toBeNull();
  });
});

describe("formatRecurrenceRule", () => {
  it.each([
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=3;COUNT=10",
    "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=SU",
    "FREQ=MONTHLY;BYMONTHDAY=1,15",
    "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
    "FREQ=DAILY;UNTIL=20260401T090000Z",
  ])("round-trips %s", (rrule) => {
    const rule = parseRecurrenceRule(rrule);
    expect(rule).not.toBeNull();
    if (rule === null) {
      return;
    }
    expect(formatRecurrenceRule(rule)).toBe(rrule);
    expect(formatRecurrenceRule(parseRecurrenceRule(rrule) ?? rule)).toBe(
      rrule,
    );
  });

  it("normalizes BYDAY order and drops duplicates", () => {
    const rule = parseRecurrenceRule("FREQ=WEEKLY;BYDAY=FR,MO,MO");
    expect(
      formatRecurrenceRule(
        rule ??
          createRecurrenceRule({
            freq: "WEEKLY",
          }),
      ),
    ).toBe("FREQ=WEEKLY;BYDAY=MO,FR");
  });
});

describe("createRecurrenceRule", () => {
  it("rejects COUNT together with UNTIL", () => {
    expect(() =>
      createRecurrenceRule({ freq: "DAILY", count: 2, untilUtc: 1 }),
    ).toThrow(ValidationError);
  });

  it("rejects a non-positive interval", () => {
    expect(() => createRecurrenceRule({ freq: "DAILY", interval: 0 })).toThrow(
      ValidationError,
    );
  });

  it("rejects negative byMonthDay", () => {
    expect(() =>
      createRecurrenceRule({ freq: "MONTHLY", byMonthDay: [-1] }),
    ).toThrow(ValidationError);
  });

  it("rejects an out-of-range byMonth", () => {
    expect(() =>
      createRecurrenceRule({ freq: "YEARLY", byMonth: [0] }),
    ).toThrow(ValidationError);
  });
});

describe("ICS date-time helpers", () => {
  it("round-trips UTC date-times", () => {
    const epoch = Date.UTC(2026, 2, 8, 6, 30, 0);
    expect(formatIcsUtcDateTime(epoch)).toBe("20260308T063000Z");
    expect(parseIcsDateTime("20260308T063000Z")).toBe(epoch);
  });

  it("reads a floating date-time as UTC and a bare date as midnight", () => {
    expect(parseIcsDateTime("20260308T063000")).toBe(
      Date.UTC(2026, 2, 8, 6, 30, 0),
    );
    expect(parseIcsDateTime("20260308")).toBe(Date.UTC(2026, 2, 8));
  });

  it("returns null for garbage", () => {
    expect(parseIcsDateTime("nope")).toBeNull();
  });
});
