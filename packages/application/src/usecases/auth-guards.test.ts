import { describe, expect, test } from "vitest";
import { RateLimitedError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import { createFakeRateLimiter } from "../test-support/auth-hardening-fakes";
import { constantTimeEqual, enforceAuthRateLimit } from "./auth-guards";

describe("enforceAuthRateLimit", () => {
  test("returns without calling a limiter when disabled", async () => {
    const fake = createFakeDependencies();
    await expect(
      enforceAuthRateLimit(fake.deps, "requestEmailAuth", null),
    ).resolves.toBeUndefined();
  });

  test("uses the operation and IP only, with unknown for a missing IP", async () => {
    const limiter = createFakeRateLimiter();
    const fake = createFakeDependencies({ rateLimiter: limiter.limiter });
    await enforceAuthRateLimit(fake.deps, "requestEmailAuth", "192.0.2.1");
    await enforceAuthRateLimit(fake.deps, "bootstrapAdmin", null);
    expect(limiter.keys).toEqual([
      "auth:requestEmailAuth:192.0.2.1",
      "auth:bootstrapAdmin:unknown",
    ]);
  });

  test("throws RATE_LIMITED when denied", async () => {
    const limiter = createFakeRateLimiter({
      deny: new Set(["auth:verifyEmailAuthToken:192.0.2.2"]),
    });
    const fake = createFakeDependencies({ rateLimiter: limiter.limiter });
    await expect(
      enforceAuthRateLimit(fake.deps, "verifyEmailAuthToken", "192.0.2.2"),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("constantTimeEqual", () => {
  test("compares equal strings and unequal strings", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "b")).toBe(false);
    expect(constantTimeEqual("a", "ab")).toBe(false);
  });
});
