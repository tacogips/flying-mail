import { describe, expect, test } from "vitest";
import {
  assertEnumValue,
  boolToSql,
  buildInPlaceholders,
  decodeCursor,
  encodeCursor,
  escapeLikePattern,
  isForeignKeyConstraintViolation,
  isUniqueConstraintViolation,
  sqlToBool,
} from "./sql-helpers";

enum Colour {
  Red = "RED",
  Blue = "BLUE",
}

describe("buildInPlaceholders", () => {
  test.each([
    [0, "NULL"],
    [1, "?"],
    [3, "?,?,?"],
  ])("renders %i placeholders as %s", (count, expected) => {
    expect(buildInPlaceholders(count)).toBe(expected);
  });
});

describe("assertEnumValue", () => {
  test("returns a known member", () => {
    expect(assertEnumValue(Colour, "RED", "colour")).toBe(Colour.Red);
  });

  test("throws for an unknown value, naming the label", () => {
    expect(() => assertEnumValue(Colour, "GREEN", "colour")).toThrow(
      /Invalid colour value from database/,
    );
  });
});

describe("boolean conversion", () => {
  test("round-trips", () => {
    expect(boolToSql(true)).toBe(1);
    expect(boolToSql(false)).toBe(0);
    expect(sqlToBool(1)).toBe(true);
    expect(sqlToBool(0)).toBe(false);
    // libsql can hand back a real boolean depending on the driver.
    expect(sqlToBool(true)).toBe(true);
  });
});

describe("constraint detection", () => {
  test.each([
    "UNIQUE constraint failed: tags.name",
    "SQLITE_CONSTRAINT_UNIQUE: something",
    "PRIMARY KEY constraint failed",
  ])("recognises %j as a unique violation", (message) => {
    expect(isUniqueConstraintViolation(new Error(message))).toBe(true);
  });

  test("recognises a foreign key violation", () => {
    expect(
      isForeignKeyConstraintViolation(
        new Error("FOREIGN KEY constraint failed"),
      ),
    ).toBe(true);
  });

  test("follows the cause chain", () => {
    const inner = new Error("UNIQUE constraint failed: tags.name");
    const outer = new Error("write failed", { cause: inner });
    expect(isUniqueConstraintViolation(outer)).toBe(true);
  });

  test("reads a libsql-style code field", () => {
    const error = Object.assign(new Error("write failed"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    });
    expect(isUniqueConstraintViolation(error)).toBe(true);
  });

  test.each([
    ["an unrelated error", new Error("network down")],
    ["a non-error value", "not an error"],
  ])("does not match %s", (_label, value) => {
    expect(isUniqueConstraintViolation(value)).toBe(false);
    expect(isForeignKeyConstraintViolation(value)).toBe(false);
  });
});

describe("escapeLikePattern", () => {
  test.each([
    ["50%", "50\\%"],
    ["a_b", "a\\_b"],
    ["back\\slash", "back\\\\slash"],
    ["plain", "plain"],
  ])("escapes %j to %j", (input, expected) => {
    expect(escapeLikePattern(input)).toBe(expected);
  });

  test("escapes the backslash before the wildcards it introduces", () => {
    // Naive ordering would double-escape the backslashes added for `%`.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });
});

describe("cursors", () => {
  test("round-trips a timestamp and id", () => {
    const cursor = encodeCursor("2026-08-23T00:00:00.000Z", "msg-1");
    expect(decodeCursor(cursor)).toEqual({
      occurredAt: "2026-08-23T00:00:00.000Z",
      id: "msg-1",
    });
  });

  test("handles an id containing spaces", () => {
    const cursor = encodeCursor("2026-08-23T00:00:00.000Z", "msg with space");
    expect(decodeCursor(cursor)?.id).toBe("msg with space");
  });

  test("is url-safe", () => {
    const cursor = encodeCursor("2026-08-23T00:00:00.000Z", "msg-1");
    expect(cursor).not.toMatch(/[+/=]/);
  });

  test.each([
    ["garbage", "!!!not base64!!!"],
    ["valid base64 without a separator", btoa("nospace")],
    ["an empty string", ""],
  ])("returns null for %s", (_label, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});
