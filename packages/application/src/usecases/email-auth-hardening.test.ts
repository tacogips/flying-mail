import {
  EmailAuthChallengePurpose,
  createEmailAuthChallenge,
} from "@flying-mail/domain/entities/email-auth-challenge";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createEmailAuthChallengeId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  createFakeRateLimiter,
  createFakeTurnstileVerifier,
} from "../test-support/auth-hardening-fakes";
import {
  createBootstrapAdminUseCase,
  createRequestEmailAuthUseCase,
  createVerifyEmailAuthTokenUseCase,
} from "./email-auth";

const NOW = "2026-08-23T00:00:00.000Z";
const BOOTSTRAP_TOKEN = "test-bootstrap-token";

function seedUser(fake: FakeDependencies, acceptedAt: string | null = NOW) {
  const user = createUser({
    id: createUserId("auth-user"),
    email: createEmailAddress("known@example.com"),
    name: "Known",
    role: UserRole.Member,
    invitationAcceptedAt: acceptedAt,
    createdAt: NOW,
  });
  fake.stores.users.set(user.id, user);
  return user;
}

describe("requestEmailAuth hardening", () => {
  test("requires a Turnstile token when enabled and makes no mail or challenge", async () => {
    const turnstile = createFakeTurnstileVerifier();
    const fake = createFakeDependencies({
      turnstileVerifier: turnstile.verifier,
    });
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await expect(
      request({
        email: "known@example.com",
        turnstileToken: null,
        clientIp: "192.0.2.1",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.stores.challenges.size).toBe(0);
    expect(fake.mailSender.sent).toHaveLength(0);
    expect(turnstile.calls[0]).toEqual({
      token: "",
      remoteIp: "192.0.2.1",
      action: "login",
    });
  });

  test("invalid tokens yield the same error for known and unknown addresses", async () => {
    const turnstile = createFakeTurnstileVerifier({ accept: () => false });
    const fake = createFakeDependencies({
      turnstileVerifier: turnstile.verifier,
    });
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    const outcomes = await Promise.all([
      request({
        email: "known@example.com",
        turnstileToken: "bad",
        clientIp: null,
      }).catch((error: unknown) => error),
      request({
        email: "unknown@example.com",
        turnstileToken: "bad",
        clientIp: null,
      }).catch((error: unknown) => error),
    ]);
    expect(outcomes.map((error) => (error as ForbiddenError).code)).toEqual([
      "FORBIDDEN",
      "FORBIDDEN",
    ]);
    expect(outcomes.map((error) => (error as Error).message)).toEqual([
      "Verification failed. Please retry.",
      "Verification failed. Please retry.",
    ]);
    expect(fake.mailSender.sent).toHaveLength(0);
  });

  test("valid token passes remote IP and login action to the verifier", async () => {
    const turnstile = createFakeTurnstileVerifier();
    const fake = createFakeDependencies({
      turnstileVerifier: turnstile.verifier,
    });
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await expect(
      request({
        email: "known@example.com",
        turnstileToken: "turnstile-ok",
        clientIp: "198.51.100.5",
      }),
    ).resolves.toBe(true);
    expect(turnstile.calls).toEqual([
      { token: "turnstile-ok", remoteIp: "198.51.100.5", action: "login" },
    ]);
  });

  test("ignores the token when Turnstile is disabled", async () => {
    const fake = createFakeDependencies();
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await expect(
      request({
        email: "known@example.com",
        turnstileToken: "ignored",
        clientIp: null,
      }),
    ).resolves.toBe(true);
    expect(fake.mailSender.sent).toHaveLength(1);
  });

  test("rate limiting runs before verification and address lookup", async () => {
    const limiter = createFakeRateLimiter({
      deny: new Set(["auth:requestEmailAuth:192.0.2.7"]),
    });
    const turnstile = createFakeTurnstileVerifier();
    const fake = createFakeDependencies({
      rateLimiter: limiter.limiter,
      turnstileVerifier: turnstile.verifier,
    });
    const findByEmail = vi.spyOn(fake.deps.userRepository, "findByEmail");
    const request = createRequestEmailAuthUseCase(fake.deps);
    const errors = await Promise.all([
      request({
        email: "known@example.com",
        turnstileToken: "x",
        clientIp: "192.0.2.7",
      }).catch((error: unknown) => error),
      request({
        email: "unknown@example.com",
        turnstileToken: "x",
        clientIp: "192.0.2.7",
      }).catch((error: unknown) => error),
    ]);
    expect(errors.map((error) => (error as RateLimitedError).code)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(turnstile.calls).toHaveLength(0);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  test("invitation challenges do not count against the LOGIN throttle", async () => {
    const fake = createFakeDependencies();
    const user = seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request({
      email: "known@example.com",
      turnstileToken: null,
      clientIp: null,
    });
    await request({
      email: "known@example.com",
      turnstileToken: null,
      clientIp: null,
    });
    for (let index = 0; index < 3; index += 1) {
      const id = createEmailAuthChallengeId(`invite-${index}`);
      await fake.deps.emailAuthChallengeRepository.save(
        createEmailAuthChallenge({
          id,
          email: user.email,
          purpose: EmailAuthChallengePurpose.Invitation,
          tokenHash: `invite-hash-${index}`,
          expiresAt: "2026-08-30T00:00:00.000Z",
          createdAt: NOW,
        }),
      );
    }
    await expect(
      request({
        email: "known@example.com",
        turnstileToken: null,
        clientIp: null,
      }),
    ).resolves.toBe(true);
    expect(fake.mailSender.sent).toHaveLength(3);
  });
});

describe("verifyEmailAuthToken hardening", () => {
  test("concurrent uses of one link create exactly one session", async () => {
    const fake = createFakeDependencies();
    const user = seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request({
      email: "known@example.com",
      turnstileToken: null,
      clientIp: null,
    });
    const token = decodeURIComponent(
      (fake.mailSender.sent[0]?.text.split("token=")[1] ?? "").split(/\s/)[0] ??
        "",
    );
    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    const results = await Promise.allSettled([
      verify(token, null),
      verify(token, null),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(fake.stores.sessions.size).toBe(1);
    expect(
      (await fake.deps.userRepository.findById(user.id))?.invitationAcceptedAt,
    ).toBe(NOW);
  });

  test("an invitation accepts a pending user and cannot be reused afterward", async () => {
    const fake = createFakeDependencies();
    const user = seedUser(fake, null);
    const token = "invite-login-token";
    const challenge = createEmailAuthChallenge({
      id: createEmailAuthChallengeId("invite-login"),
      email: user.email,
      purpose: EmailAuthChallengePurpose.Invitation,
      tokenHash: await fake.deps.tokenHasher.hash(token),
      expiresAt: "2026-08-30T00:00:00.000Z",
      createdAt: NOW,
    });
    await fake.deps.emailAuthChallengeRepository.save(challenge);
    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    const result = await verify(token, null);
    expect(result.user.invitationAcceptedAt).toBe(NOW);
    const secondToken = "second-invitation-token";
    await fake.deps.emailAuthChallengeRepository.save(
      createEmailAuthChallenge({
        id: createEmailAuthChallengeId("invite-login-second"),
        email: user.email,
        purpose: EmailAuthChallengePurpose.Invitation,
        tokenHash: await fake.deps.tokenHasher.hash(secondToken),
        expiresAt: "2026-08-30T00:00:00.000Z",
        createdAt: NOW,
      }),
    );
    await expect(verify(secondToken, null)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(verify(token, null)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  test("a LOGIN link also accepts a pending user", async () => {
    const fake = createFakeDependencies();
    const user = seedUser(fake, null);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request({
      email: "known@example.com",
      turnstileToken: null,
      clientIp: null,
    });
    const token = decodeURIComponent(
      (fake.mailSender.sent[0]?.text.split("token=")[1] ?? "").split(/\s/)[0] ??
        "",
    );
    const result = await createVerifyEmailAuthTokenUseCase(fake.deps)(
      token,
      null,
    );
    expect(result.user.invitationAcceptedAt).toBe(NOW);
    expect(
      (await fake.deps.userRepository.findById(user.id))?.invitationAcceptedAt,
    ).toBe(NOW);
  });

  test("rate limiting returns RATE_LIMITED", async () => {
    const limiter = createFakeRateLimiter({
      deny: new Set(["auth:verifyEmailAuthToken:unknown"]),
    });
    const fake = createFakeDependencies({ rateLimiter: limiter.limiter });
    await expect(
      createVerifyEmailAuthTokenUseCase(fake.deps)("token", null),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("bootstrapAdmin hardening", () => {
  test("is disabled without a configured token", async () => {
    const fake = createFakeDependencies();
    const bootstrap = createBootstrapAdminUseCase(fake.deps);
    await expect(
      bootstrap({
        email: "first@example.com",
        name: "First",
        token: BOOTSTRAP_TOKEN,
        clientIp: null,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fake.stores.users.size).toBe(0);
  });

  test.each(["wrong", ""])(
    "rejects %j without creating a user",
    async (token) => {
      const fake = createFakeDependencies({
        instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
      });
      await expect(
        createBootstrapAdminUseCase(fake.deps)({
          email: "first@example.com",
          name: "First",
          token,
          clientIp: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(fake.stores.users.size).toBe(0);
    },
  );

  test("checks the token before createFirstUser even on a non-empty instance", async () => {
    const fake = createFakeDependencies({
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
    });
    seedUser(fake);
    const createFirstUser = vi.spyOn(
      fake.deps.userRepository,
      "createFirstUser",
    );
    await expect(
      createBootstrapAdminUseCase(fake.deps)({
        email: "first@example.com",
        name: "First",
        token: "wrong",
        clientIp: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(createFirstUser).not.toHaveBeenCalled();
  });

  test("creates an accepted admin with the correct token and refuses reuse", async () => {
    const fake = createFakeDependencies({
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
    });
    const bootstrap = createBootstrapAdminUseCase(fake.deps);
    const result = await bootstrap({
      email: "first@example.com",
      name: "First",
      token: BOOTSTRAP_TOKEN,
      clientIp: null,
    });
    expect(result.user.invitationAcceptedAt).toBe(NOW);
    await expect(
      bootstrap({
        email: "second@example.com",
        name: "Second",
        token: BOOTSTRAP_TOKEN,
        clientIp: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rate limiting happens before token hashing or user creation", async () => {
    const limiter = createFakeRateLimiter({
      deny: new Set(["auth:bootstrapAdmin:unknown"]),
    });
    const fake = createFakeDependencies({
      rateLimiter: limiter.limiter,
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
    });
    const hash = vi.spyOn(fake.deps.tokenHasher, "hash");
    const createFirstUser = vi.spyOn(
      fake.deps.userRepository,
      "createFirstUser",
    );
    await expect(
      createBootstrapAdminUseCase(fake.deps)({
        email: "first@example.com",
        name: "First",
        token: BOOTSTRAP_TOKEN,
        clientIp: null,
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(hash).not.toHaveBeenCalled();
    expect(createFirstUser).not.toHaveBeenCalled();
  });
});
