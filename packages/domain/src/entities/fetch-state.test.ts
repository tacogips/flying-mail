import { describe, expect, test } from "vitest";
import { createApiKeyId, createMessageId } from "../value-objects/ids";
import {
  FetchStatus,
  markFetched,
  markNotFetched,
  resolveFetchStatus,
} from "./fetch-state";

const messageId = createMessageId("msg-1");
const keyA = createApiKeyId("key-a");
const keyB = createApiKeyId("key-b");

describe("markFetched", () => {
  test("creates a FETCHED state from nothing", () => {
    const state = markFetched(
      null,
      messageId,
      keyA,
      "2026-08-23T00:00:00.000Z",
    );
    expect(state.status).toBe(FetchStatus.Fetched);
    expect(state.fetchedAt).toBe("2026-08-23T00:00:00.000Z");
  });

  test("is idempotent: re-acknowledging keeps the original fetchedAt", () => {
    const first = markFetched(
      null,
      messageId,
      keyA,
      "2026-08-23T00:00:00.000Z",
    );
    const second = markFetched(
      first,
      messageId,
      keyA,
      "2026-08-23T05:00:00.000Z",
    );
    expect(second.fetchedAt).toBe("2026-08-23T00:00:00.000Z");
    expect(second.updatedAt).toBe("2026-08-23T05:00:00.000Z");
  });

  test("re-acknowledging a NOT_FETCHED state sets a fresh fetchedAt", () => {
    const reset = markNotFetched(messageId, keyA, "2026-08-23T01:00:00.000Z");
    const again = markFetched(
      reset,
      messageId,
      keyA,
      "2026-08-23T02:00:00.000Z",
    );
    expect(again.fetchedAt).toBe("2026-08-23T02:00:00.000Z");
  });

  test("states for two keys are independent", () => {
    const a = markFetched(null, messageId, keyA, "2026-08-23T00:00:00.000Z");
    const b = markFetched(null, messageId, keyB, "2026-08-23T01:00:00.000Z");
    expect(a.apiKeyId).toBe(keyA);
    expect(b.apiKeyId).toBe(keyB);
    expect(a.fetchedAt).not.toBe(b.fetchedAt);
  });
});

describe("markNotFetched", () => {
  test("clears fetchedAt", () => {
    const state = markNotFetched(messageId, keyA, "2026-08-23T01:00:00.000Z");
    expect(state.status).toBe(FetchStatus.NotFetched);
    expect(state.fetchedAt).toBeNull();
  });
});

describe("resolveFetchStatus", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
  ])("treats a %s state as NOT_FETCHED", (_name, state) => {
    expect(resolveFetchStatus(state)).toBe(FetchStatus.NotFetched);
  });

  test("reads a stored status", () => {
    const state = markFetched(
      null,
      messageId,
      keyA,
      "2026-08-23T00:00:00.000Z",
    );
    expect(resolveFetchStatus(state)).toBe(FetchStatus.Fetched);
  });
});
