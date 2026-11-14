import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import {
  addIsoDateDays,
  compareIsoDates,
  createIsoDate,
  isoDateToUtcMs,
  parseIsoDate,
  utcMsToIsoDate,
} from "./iso-date";

describe("parseIsoDate", () => {
  it("accepts valid dates", () => {
    expect(parseIsoDate("2026-03-08")).toBe("2026-03-08");
    expect(parseIsoDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects impossible and malformed dates", () => {
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("2025-02-29")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("20260308")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });

  it("throws through the create variant", () => {
    expect(() => createIsoDate("nope", "startDate")).toThrow(ValidationError);
  });
});

describe("date arithmetic", () => {
  it("adds days across a month boundary", () => {
    expect(addIsoDateDays(createIsoDate("2026-01-31"), 1)).toBe("2026-02-01");
    expect(addIsoDateDays(createIsoDate("2026-03-01"), -1)).toBe("2026-02-28");
  });

  it("round-trips through epoch milliseconds", () => {
    const date = createIsoDate("2026-03-08");
    expect(utcMsToIsoDate(isoDateToUtcMs(date))).toBe("2026-03-08");
  });

  it("orders dates", () => {
    expect(
      compareIsoDates(createIsoDate("2026-01-01"), createIsoDate("2026-01-02")),
    ).toBeLessThan(0);
  });
});
