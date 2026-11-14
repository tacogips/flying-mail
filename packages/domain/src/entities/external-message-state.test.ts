import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createExternalAccountId, createMessageId } from "../value-objects/ids";
import {
  createExternalMessageState,
  createSkippedExternalMessageState,
  ExternalMessageSkipReason,
} from "./external-message-state";

const NOW = "2026-08-24T00:00:00.000Z";

describe("createExternalMessageState", () => {
  test("records the ledger row", () => {
    const state = createExternalMessageState({
      accountId: createExternalAccountId("ext-1"),
      remoteId: "uidl-123",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    expect(state.remoteId).toBe("uidl-123");
    expect(state.fetchedAt).toBe(NOW);
  });

  test("trims the remoteId", () => {
    const state = createExternalMessageState({
      accountId: createExternalAccountId("ext-1"),
      remoteId: "  uidl-123  ",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    expect(state.remoteId).toBe("uidl-123");
  });

  test("rejects an empty remoteId", () => {
    expect(() =>
      createExternalMessageState({
        accountId: createExternalAccountId("ext-1"),
        remoteId: "   ",
        messageId: createMessageId("msg-1"),
        fetchedAt: NOW,
      }),
    ).toThrow(ValidationError);
  });
});

describe("createSkippedExternalMessageState", () => {
  test("records a skip with no message", () => {
    const state = createSkippedExternalMessageState({
      accountId: createExternalAccountId("ext-1"),
      remoteId: " uidl-big ",
      skipReason: ExternalMessageSkipReason.TooLarge,
      fetchedAt: NOW,
    });
    expect(state).toEqual({
      accountId: "ext-1",
      remoteId: "uidl-big",
      messageId: null,
      fetchedAt: NOW,
      skipReason: "TOO_LARGE",
    });
  });

  test("rejects an empty remoteId", () => {
    expect(() =>
      createSkippedExternalMessageState({
        accountId: createExternalAccountId("ext-1"),
        remoteId: "",
        skipReason: ExternalMessageSkipReason.TooLarge,
        fetchedAt: NOW,
      }),
    ).toThrow(ValidationError);
  });
});
