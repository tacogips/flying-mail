import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createCalendarId, createUserId } from "../value-objects/ids";
import {
  createCalendar,
  DEFAULT_CALENDAR_COLOR,
  MAX_CALENDAR_NAME_LENGTH,
  updateCalendar,
} from "./calendar";

const base = {
  id: createCalendarId("cal-1"),
  ownerUserId: createUserId("usr-1"),
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("createCalendar", () => {
  it("trims the name and defaults the color", () => {
    const calendar = createCalendar({ ...base, name: "  Work  " });
    expect(calendar.name).toBe("Work");
    expect(calendar.color).toBe(DEFAULT_CALENDAR_COLOR);
    expect(calendar.description).toBeNull();
    expect(calendar.updatedAt).toBe(base.createdAt);
  });

  it("lower-cases the color", () => {
    expect(
      createCalendar({ ...base, name: "Work", color: "#AABBCC" }).color,
    ).toBe("#aabbcc");
  });

  it("rejects an empty name", () => {
    expect(() => createCalendar({ ...base, name: "   " })).toThrow(
      ValidationError,
    );
  });

  it("rejects an over-long name", () => {
    expect(() =>
      createCalendar({
        ...base,
        name: "a".repeat(MAX_CALENDAR_NAME_LENGTH + 1),
      }),
    ).toThrow(ValidationError);
  });

  it("rejects a malformed color", () => {
    expect(() =>
      createCalendar({ ...base, name: "Work", color: "red" }),
    ).toThrow(ValidationError);
  });
});

describe("updateCalendar", () => {
  it("applies only the supplied fields", () => {
    const calendar = createCalendar({
      ...base,
      name: "Work",
      description: "notes",
    });
    const updated = updateCalendar(
      calendar,
      { name: "Personal" },
      "2026-08-25T00:00:00.000Z",
    );
    expect(updated.name).toBe("Personal");
    expect(updated.description).toBe("notes");
    expect(updated.createdAt).toBe(calendar.createdAt);
    expect(updated.updatedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("clears the description with an explicit null", () => {
    const calendar = createCalendar({
      ...base,
      name: "Work",
      description: "x",
    });
    expect(
      updateCalendar(calendar, { description: null }, base.createdAt)
        .description,
    ).toBeNull();
  });
});
