import { describe, expect, test } from "vitest";
import { createFrameRateLimiter } from "./frame-rate-limiter";
import type { ConnectionState } from "./host";

function stateFor(connId: string): ConnectionState {
  return {
    v: 1,
    connId,
    clientIp: null,
    cookieTokenHash: null,
    openedAt: 0,
    initDeadline: 0,
    acked: false,
    principal: null,
    lastMessageAt: 0,
    subscriptions: [],
  };
}

describe("frame rate limiter", () => {
  test("allows a burst up to capacity and then refuses", () => {
    const limiter = createFrameRateLimiter(5, 10_000);
    const state = stateFor("a");
    const results = Array.from({ length: 7 }, () => limiter.consume(state, 0));
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  test("refills proportionally to elapsed time", () => {
    const limiter = createFrameRateLimiter(10, 10_000);
    const state = stateFor("a");
    for (let index = 0; index < 10; index += 1) limiter.consume(state, 0);
    expect(limiter.consume(state, 500)).toBe(false);
    expect(limiter.consume(state, 1_000)).toBe(true);
    expect(limiter.consume(state, 1_000)).toBe(false);
  });

  test("never refills beyond capacity", () => {
    const limiter = createFrameRateLimiter(2, 1_000);
    const state = stateFor("a");
    limiter.consume(state, 0);
    const results = Array.from({ length: 3 }, () =>
      limiter.consume(state, 1_000_000),
    );
    expect(results).toEqual([true, true, false]);
  });

  test("tracks connections independently and tolerates clock regression", () => {
    const limiter = createFrameRateLimiter(1, 10_000);
    const first = stateFor("a");
    const second = stateFor("b");
    expect(limiter.consume(first, 1_000)).toBe(true);
    expect(limiter.consume(first, 0)).toBe(false);
    expect(limiter.consume(second, 0)).toBe(true);
  });
});
