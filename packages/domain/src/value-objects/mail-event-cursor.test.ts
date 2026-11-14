import { describe, expect, test } from "vitest";
import {
  formatMailEventCursor,
  parseMailEventCursor,
} from "./mail-event-cursor";

describe("formatMailEventCursor", () => {
  test("formats the epoch and sequence with a dot separator", () => {
    expect(formatMailEventCursor("9f2c4e1a7b3d5f60", 1842)).toBe(
      "9f2c4e1a7b3d5f60.1842",
    );
  });
});

describe("parseMailEventCursor", () => {
  test.each([
    ["9f2c4e1a7b3d5f60.1842", "9f2c4e1a7b3d5f60", 1842],
    ["0000000000000000.0", "0000000000000000", 0],
    ["ffffffffffffffff.9007199254740991", "ffffffffffffffff", 9007199254740991],
  ])("parses canonical cursor %s", (raw, epoch, seq) => {
    expect(parseMailEventCursor(raw)).toEqual({ epoch, seq });
  });

  test.each([
    "",
    "9F2C4E1A7B3D5F60.1842",
    "9f2c4e1a7b3d5f6.1842",
    "9f2c4e1a7b3d5f600.1842",
    "9f2c4e1a7b3d5f60.-1",
    "9f2c4e1a7b3d5f60.+1",
    "9f2c4e1a7b3d5f60.01",
    "9f2c4e1a7b3d5f60.1.0",
    "9f2c4e1a7b3d5f60.9007199254740992",
    "9f2c4e1a7b3d5f60.999999999999999999999999",
  ])("rejects invalid cursor %s", (raw) => {
    expect(parseMailEventCursor(raw)).toBeNull();
  });

  test("never throws for non-string runtime input", () => {
    expect(() => parseMailEventCursor(null as unknown as string)).not.toThrow();
    expect(parseMailEventCursor(null as unknown as string)).toBeNull();
  });
});
