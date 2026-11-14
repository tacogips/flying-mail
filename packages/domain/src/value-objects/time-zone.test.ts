import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createTimeZoneId, parseTimeZoneId, UTC_TIME_ZONE } from "./time-zone";

describe("parseTimeZoneId", () => {
  it("accepts IANA zones", () => {
    expect(parseTimeZoneId("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(parseTimeZoneId("America/New_York")).toBe("America/New_York");
    expect(parseTimeZoneId("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("canonicalizes casing so equal zones compare equal", () => {
    expect(parseTimeZoneId("utc")).toBe("UTC");
    expect(parseTimeZoneId("  UTC  ")).toBe("UTC");
  });

  it("rejects garbage, empty values and fixed offsets", () => {
    expect(parseTimeZoneId("")).toBeNull();
    expect(parseTimeZoneId("   ")).toBeNull();
    expect(parseTimeZoneId("Not/AZone")).toBeNull();
    expect(parseTimeZoneId("+09:00")).toBeNull();
  });
});

describe("createTimeZoneId", () => {
  it("returns the canonical zone", () => {
    expect(createTimeZoneId("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(UTC_TIME_ZONE).toBe("UTC");
  });

  it("throws ValidationError with the field name", () => {
    expect(() => createTimeZoneId("Nope/Nope", "eventTimeZone")).toThrow(
      ValidationError,
    );
    try {
      createTimeZoneId("Nope/Nope", "eventTimeZone");
    } catch (error) {
      expect((error as ValidationError).field).toBe("eventTimeZone");
    }
  });
});
