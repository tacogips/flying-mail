import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createMessageEventId, createMessageId } from "../value-objects/ids";
import {
  createMessageEvent,
  MessageEventKind,
  setMessageEventCompleted,
  updateMessageEvent,
} from "./message-event";

const NOW = "2026-08-23T00:00:00.000Z";

function event(
  overrides: Partial<Parameters<typeof createMessageEvent>[0]> = {},
) {
  return createMessageEvent({
    id: createMessageEventId("evt-1"),
    messageId: createMessageId("msg-1"),
    kind: MessageEventKind.Deadline,
    dueAt: "2026-10-01T00:00:00.000Z",
    title: "reply",
    note: null,
    createdAt: NOW,
    ...overrides,
  });
}

describe("createMessageEvent", () => {
  test('models "limit, 10/1 reply": a deadline with a due date', () => {
    const deadline = event();
    expect(deadline.kind).toBe(MessageEventKind.Deadline);
    expect(deadline.dueAt).toBe("2026-10-01T00:00:00.000Z");
    expect(deadline.completedAt).toBeNull();
  });

  test("a DEADLINE without a due date is invalid, other kinds allow it", () => {
    expect(() => event({ dueAt: null })).toThrow(ValidationError);
    expect(
      event({ kind: MessageEventKind.FollowUp, dueAt: null }).dueAt,
    ).toBeNull();
  });

  test("rejects an unparseable due date and an empty title", () => {
    expect(() => event({ dueAt: "next tuesday" })).toThrow(ValidationError);
    expect(() => event({ title: "  " })).toThrow(ValidationError);
  });

  test("a blank note collapses to null", () => {
    expect(event({ note: "   " }).note).toBeNull();
  });
});

describe("transitions", () => {
  test("completion is idempotent both ways", () => {
    const open = event();
    const done = setMessageEventCompleted(
      open,
      true,
      "2026-09-01T00:00:00.000Z",
    );
    expect(done.completedAt).toBe("2026-09-01T00:00:00.000Z");
    // Completing again keeps the original completion time.
    expect(
      setMessageEventCompleted(done, true, "2026-09-02T00:00:00.000Z"),
    ).toBe(done);
    expect(
      setMessageEventCompleted(done, false, "2026-09-03T00:00:00.000Z")
        .completedAt,
    ).toBeNull();
  });

  test("an update cannot strip the due date from a deadline", () => {
    expect(() => updateMessageEvent(event(), { dueAt: null }, NOW)).toThrow(
      ValidationError,
    );
    const moved = updateMessageEvent(
      event(),
      { dueAt: "2026-10-15T00:00:00.000Z", title: "reply with quote" },
      NOW,
    );
    expect(moved.dueAt).toBe("2026-10-15T00:00:00.000Z");
    expect(moved.title).toBe("reply with quote");
  });
});
