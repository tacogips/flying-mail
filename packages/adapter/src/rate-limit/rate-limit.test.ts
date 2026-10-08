import { afterEach, describe, expect, test, vi } from "vitest";
import type { Clock } from "@flying-mail/application/ports/runtime-ports";
import { createInMemoryRateLimiter, AUTH_RATE_LIMIT } from "./in-memory";
import {
  createWorkersRateLimiter,
  type RateLimitBindingLike,
} from "./workers-binding";

function mutableClock(
  start = 0,
): Clock & { advance(milliseconds: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("createWorkersRateLimiter", () => {
  afterEach(() => vi.restoreAllMocks());

  test("returns the binding success value and passes the key through", async () => {
    const calls: { readonly key: string }[] = [];
    const binding: RateLimitBindingLike = {
      async limit(options) {
        calls.push(options);
        return { success: true };
      },
    };
    const limiter = createWorkersRateLimiter(binding);

    await expect(
      limiter.limit("auth:requestEmailAuth:203.0.113.4"),
    ).resolves.toBe(true);
    expect(calls).toEqual([{ key: "auth:requestEmailAuth:203.0.113.4" }]);
  });

  test("returns false when the binding denies the key", async () => {
    const limiter = createWorkersRateLimiter({
      async limit() {
        return { success: false };
      },
    });
    await expect(
      limiter.limit("auth:verifyEmailAuthToken:unknown"),
    ).resolves.toBe(false);
  });

  test("logs binding failures and fails open", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("binding unavailable");
    const limiter = createWorkersRateLimiter({
      async limit() {
        throw failure;
      },
    });

    await expect(limiter.limit("auth:bootstrapAdmin:unknown")).resolves.toBe(
      true,
    );
    expect(log).toHaveBeenCalledWith("Rate limiter binding failed", failure);
  });
});

describe("createInMemoryRateLimiter", () => {
  test("uses the pinned auth limit of ten requests per sixty seconds", async () => {
    const clock = mutableClock();
    const limiter = createInMemoryRateLimiter({ ...AUTH_RATE_LIMIT, clock });

    for (let call = 0; call < 10; call += 1) {
      await expect(limiter.limit("auth:requestEmailAuth:ip")).resolves.toBe(
        true,
      );
    }
    await expect(limiter.limit("auth:requestEmailAuth:ip")).resolves.toBe(
      false,
    );

    clock.advance(60_000);
    await expect(limiter.limit("auth:requestEmailAuth:ip")).resolves.toBe(true);
  });

  test("keeps different keys independent", async () => {
    const clock = mutableClock();
    const limiter = createInMemoryRateLimiter({
      limit: 1,
      periodSeconds: 60,
      clock,
    });

    await expect(limiter.limit("ip-a")).resolves.toBe(true);
    await expect(limiter.limit("ip-a")).resolves.toBe(false);
    await expect(limiter.limit("ip-b")).resolves.toBe(true);
  });

  test("prunes expired windows before inserting a new key at the maxKeys threshold", async () => {
    const clock = mutableClock();
    const limiter = createInMemoryRateLimiter({
      limit: 1,
      periodSeconds: 10,
      clock,
      maxKeys: 2,
    });

    await expect(limiter.limit("expired-a")).resolves.toBe(true);
    await expect(limiter.limit("expired-b")).resolves.toBe(true);
    clock.advance(10_000);

    await expect(limiter.limit("new-c")).resolves.toBe(true);
    await expect(limiter.limit("new-c")).resolves.toBe(false);
  });

  test("evicts the oldest active key when the tracked-key cap is full", async () => {
    const clock = mutableClock();
    const limiter = createInMemoryRateLimiter({
      limit: 1,
      periodSeconds: 60,
      clock,
      maxKeys: 2,
    });

    await expect(limiter.limit("oldest")).resolves.toBe(true);
    await expect(limiter.limit("next")).resolves.toBe(true);
    await expect(limiter.limit("newest")).resolves.toBe(true);
    await expect(limiter.limit("oldest")).resolves.toBe(true);
    await expect(limiter.limit("next")).resolves.toBe(true);
  });
});
