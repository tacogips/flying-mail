import { describe, expect, test } from "vitest";
import { MailEventType, normalizeEventAddresses } from "./mail-event";

describe("MailEventType", () => {
  test("contains the six persisted event values", () => {
    expect(Object.values(MailEventType)).toEqual([
      "MESSAGE_RECEIVED",
      "MESSAGE_SENT",
      "MESSAGE_UPDATED",
      "MESSAGE_DELETED",
      "DRAFT_SAVED",
      "DRAFT_DELETED",
    ]);
  });
});

describe("normalizeEventAddresses", () => {
  test("trims, lowercases, removes empty and duplicate values, and code-unit sorts", () => {
    expect(
      normalizeEventAddresses([
        " B@example.com ",
        "a@example.com",
        "b@EXAMPLE.com",
        "   ",
        "!@example.com",
      ]),
    ).toEqual(["!@example.com", "a@example.com", "b@example.com"]);
  });

  test("returns an empty array when no addresses remain", () => {
    expect(normalizeEventAddresses(["", "  "])).toEqual([]);
  });
});
