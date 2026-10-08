import { describe, expect, test } from "vitest";
import {
  Capability,
  createApiKey,
  createApiKeyScope,
  revokeApiKey,
} from "@flying-mail/domain/entities/api-key";
import {
  createUser,
  deactivateUser,
  UserRole,
} from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { MATCH_ALL_ADDRESSES } from "@flying-mail/domain/value-objects/address-pattern";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { ForbiddenError, RateLimitedError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import { createFakeRateLimiter } from "../test-support/auth-hardening-fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "../test-support/viewer-fixtures";
import {
  constantTimeEqual,
  enforceAuthRateLimit,
  requireAdminUser,
  requireUserAdministrator,
} from "./auth-guards";

const NOW = "2026-08-23T00:00:00.000Z";
const ADMIN_ID = createUserId("usr-creator");
const KEY_ID = createApiKeyId("key-ua");

async function seedCreator(fake: ReturnType<typeof createFakeDependencies>) {
  const creator = createUser({
    id: ADMIN_ID,
    email: createEmailAddress("creator@example.com"),
    name: "Creator",
    role: UserRole.Admin,
    createdAt: NOW,
  });
  await fake.deps.userRepository.save(creator);
  return creator;
}

async function seedKey(
  fake: ReturnType<typeof createFakeDependencies>,
  createdByUserId: typeof ADMIN_ID | null = ADMIN_ID,
  expiresAt: string | null = null,
) {
  const key = createApiKey({
    id: KEY_ID,
    name: "user admin",
    keyHash: "hash",
    keyPrefix: "prefix",
    createdByUserId,
    expiresAt,
    createdAt: NOW,
  });
  await fake.deps.apiKeyRepository.save(key);
  await fake.deps.apiKeyRepository.saveScope(
    createApiKeyScope({
      id: createApiKeyScopeId("scope-user-admin"),
      apiKeyId: KEY_ID,
      capability: Capability.UserAdmin,
      domainId: null,
      addressPattern: MATCH_ALL_ADDRESSES,
    }),
  );
  return key;
}

describe("requireUserAdministrator", () => {
  test("accepts an admin session and rejects other user roles with the legacy message", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await expect(
      requireUserAdministrator(fake.deps, adminViewer(ADMIN_ID)),
    ).resolves.toEqual({ actorUserId: ADMIN_ID });
    await expect(
      requireUserAdministrator(fake.deps, memberViewer()),
    ).rejects.toThrow("Only an admin user may administer users");
  });

  test("rejects a key without USER_ADMIN before looking up its record", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await expect(
      requireUserAdministrator(
        fake.deps,
        apiKeyViewer([{ capability: Capability.KeyAdmin }], KEY_ID),
      ),
    ).rejects.toThrow("This API key lacks the USER_ADMIN capability");
  });

  test("accepts a live key and returns its creating admin as the audit actor", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedCreator(fake);
    await seedKey(fake);
    await expect(
      requireUserAdministrator(
        fake.deps,
        apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
      ),
    ).resolves.toEqual({ actorUserId: ADMIN_ID });
  });

  test("rejects a missing or revoked key as unusable", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const viewer = apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID);
    await expect(requireUserAdministrator(fake.deps, viewer)).rejects.toThrow(
      "USER_ADMIN is inactive: this key is no longer usable",
    );
    const key = await seedKey(fake);
    await fake.deps.apiKeyRepository.save(revokeApiKey(key, NOW));
    await expect(requireUserAdministrator(fake.deps, viewer)).rejects.toThrow(
      "USER_ADMIN is inactive: this key is no longer usable",
    );
  });

  test("checks key expiry against deps.clock on each call", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedCreator(fake);
    await seedKey(fake, ADMIN_ID, "2026-08-24T00:00:00.000Z");
    const viewer = apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID);
    await expect(requireUserAdministrator(fake.deps, viewer)).resolves.toEqual({
      actorUserId: ADMIN_ID,
    });
    fake.clock.set("2026-08-24T00:00:00.000Z");
    await expect(requireUserAdministrator(fake.deps, viewer)).rejects.toThrow(
      "USER_ADMIN is inactive: this key is no longer usable",
    );
  });

  test("rejects keys without a creator and creators who are missing, inactive, or not ADMIN", async () => {
    const noCreator = createFakeDependencies({ now: NOW });
    await seedKey(noCreator, null);
    await expect(
      requireUserAdministrator(
        noCreator.deps,
        apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
      ),
    ).rejects.toThrow("USER_ADMIN is inactive: this key has no creating admin");

    const missingCreator = createFakeDependencies({ now: NOW });
    await seedKey(missingCreator);
    await expect(
      requireUserAdministrator(
        missingCreator.deps,
        apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
      ),
    ).rejects.toThrow(
      "USER_ADMIN is inactive: the admin who created this key is no longer an active ADMIN",
    );

    for (const state of ["inactive", "member"] as const) {
      const fake = createFakeDependencies({ now: NOW });
      let creator = await seedCreator(fake);
      await seedKey(fake);
      creator =
        state === "inactive"
          ? deactivateUser(creator, NOW)
          : { ...creator, role: UserRole.Member };
      await fake.deps.userRepository.save(creator);
      await expect(
        requireUserAdministrator(
          fake.deps,
          apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
        ),
      ).rejects.toThrow(
        "USER_ADMIN is inactive: the admin who created this key is no longer an active ADMIN",
      );
    }
  });

  test("requireAdminUser remains session-only", () => {
    expect(() =>
      requireAdminUser(
        apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
      ),
    ).toThrow(ForbiddenError);
  });
});

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
