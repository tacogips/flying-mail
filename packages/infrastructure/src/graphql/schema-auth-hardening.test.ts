import {
  createFakeDependencies,
  createFakeRateLimiter,
  createFakeTurnstileVerifier,
} from "@flying-mail/application/test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import {
  EmailAuthChallengePurpose,
  createEmailAuthChallenge,
} from "@flying-mail/domain/entities/email-auth-challenge";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createEmailAuthChallengeId } from "@flying-mail/domain/value-objects/ids";
import type { GraphQLObjectType } from "graphql";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";
import { buildGraphQLSchema } from "./schema";

const BOOTSTRAP_TOKEN = "bootstrap-test-token-with-at-least-32-chars";
const CLIENT_IP = "203.0.113.9";

function createHarness(
  options: Parameters<typeof createFakeDependencies>[0] = {},
) {
  return createGraphQLHarness(createFakeDependencies(options));
}

describe("GraphQL authentication hardening", () => {
  test("publicConfig is available without a viewer and reports the site key", async () => {
    const harness = createHarness({
      instanceConfig: { turnstileSiteKey: "site-key" },
    });
    const result = await harness.run(
      "{ publicConfig { turnstileSiteKey } }",
      null,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["publicConfig"]).toEqual({
      turnstileSiteKey: "site-key",
    });
  });

  test("publicConfig exposes no secret configuration fields", () => {
    const schema = buildGraphQLSchema();
    const publicConfig = schema.getType("PublicConfig") as GraphQLObjectType;

    expect(Object.keys(publicConfig.getFields())).toEqual(["turnstileSiteKey"]);
    expect(Object.keys(schema.getTypeMap())).not.toContain("BootstrapToken");
    expect(Object.keys(schema.getTypeMap())).not.toContain("TurnstileSecret");
  });

  test("publicConfig reports null while Turnstile is disabled", async () => {
    const result = await createHarness().run(
      "{ publicConfig { turnstileSiteKey } }",
      null,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["publicConfig"]).toEqual({ turnstileSiteKey: null });
  });

  test("bootstrapAdmin accepts a token variable and returns an accepted admin", async () => {
    const harness = createHarness({
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
    });
    const result = await harness.run(
      `mutation Bootstrap($token: String!) {
        bootstrapAdmin(email: "admin@example.com", name: "Admin", token: $token) {
          secret apiKey { keyPrefix }
          user { email invitationStatus }
        }
      }`,
      null,
      { token: BOOTSTRAP_TOKEN },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["bootstrapAdmin"]).toMatchObject({
      user: { email: "admin@example.com", invitationStatus: "ACCEPTED" },
      apiKey: { keyPrefix: expect.any(String) },
      secret: expect.any(String),
    });
  });

  test("bootstrapAdmin rejects a wrong token", async () => {
    const harness = createHarness({
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
    });
    const result = await harness.run(
      `mutation Bootstrap($token: String!) {
        bootstrapAdmin(email: "admin@example.com", name: "Admin", token: $token) { secret }
      }`,
      null,
      { token: "wrong-token" },
    );

    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
  });

  test("bootstrapAdmin reports disabled configuration", async () => {
    const result = await createHarness().run(
      `mutation Bootstrap($token: String!) {
        bootstrapAdmin(email: "admin@example.com", name: "Admin", token: $token) { secret }
      }`,
      null,
      { token: BOOTSTRAP_TOKEN },
    );

    expect(errorCodes(result)).toEqual(["SERVICE_UNAVAILABLE"]);
  });

  test("bootstrapAdmin requires the token before running a resolver", async () => {
    const rateLimiter = createFakeRateLimiter();
    const harness = createHarness({
      instanceConfig: { bootstrapToken: BOOTSTRAP_TOKEN },
      rateLimiter: rateLimiter.limiter,
    });
    const result = await harness.run(
      `mutation {
        bootstrapAdmin(email: "admin@example.com", name: "Admin") { secret }
      }`,
      null,
    );

    expect(result.errors?.[0]?.message).toContain("token");
    expect(result.data == null).toBe(true);
    expect(rateLimiter.keys).toEqual([]);
  });

  test("requestEmailAuth rate limits by client IP at HTTP 200", async () => {
    const rateLimiter = createFakeRateLimiter({
      deny: new Set([`auth:requestEmailAuth:${CLIENT_IP}`]),
    });
    const harness = createHarness({ rateLimiter: rateLimiter.limiter });
    const result = await harness.run(
      `mutation { requestEmailAuth(email: "person@example.com") }`,
      null,
      undefined,
      CLIENT_IP,
    );

    expect(result.httpStatus).toBe(200);
    expect(errorCodes(result)).toEqual(["RATE_LIMITED"]);
    expect(rateLimiter.keys).toEqual([`auth:requestEmailAuth:${CLIENT_IP}`]);
  });

  test("requestEmailAuth rejects a missing Turnstile token", async () => {
    const turnstile = createFakeTurnstileVerifier();
    const harness = createHarness({
      instanceConfig: { turnstileSiteKey: "site-key" },
      turnstileVerifier: turnstile.verifier,
    });
    const result = await harness.run(
      `mutation { requestEmailAuth(email: "person@example.com") }`,
      null,
      undefined,
      CLIENT_IP,
    );

    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
    expect(result.errors?.[0]?.message).toBe(
      "Verification failed. Please retry.",
    );
  });

  test("requestEmailAuth forwards the verified token and client IP", async () => {
    const turnstile = createFakeTurnstileVerifier();
    const harness = createHarness({
      instanceConfig: { turnstileSiteKey: "site-key" },
      turnstileVerifier: turnstile.verifier,
    });
    const result = await harness.run(
      `mutation Request($token: String) {
        requestEmailAuth(email: "unknown@example.com", turnstileToken: $token)
      }`,
      null,
      { token: "turnstile-ok" },
      CLIENT_IP,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data?.["requestEmailAuth"]).toBe(true);
    expect(turnstile.calls).toEqual([
      { token: "turnstile-ok", remoteIp: CLIENT_IP, action: "login" },
    ]);
  });

  test("verifyEmailAuthToken passes the client IP to rate limiting", async () => {
    const rateLimiter = createFakeRateLimiter({
      deny: new Set([`auth:verifyEmailAuthToken:${CLIENT_IP}`]),
    });
    const harness = createHarness({ rateLimiter: rateLimiter.limiter });
    const result = await harness.run(
      `mutation { verifyEmailAuthToken(token: "invalid") { expiresAt } }`,
      null,
      undefined,
      CLIENT_IP,
    );

    expect(result.httpStatus).toBe(200);
    expect(errorCodes(result)).toEqual(["RATE_LIMITED"]);
    expect(rateLimiter.keys).toEqual([
      `auth:verifyEmailAuthToken:${CLIENT_IP}`,
    ]);
  });

  describe("user invitations", () => {
    let harness: GraphQLHarness;

    beforeEach(() => {
      harness = createHarness();
    });

    test("createUser returns PENDING and resendInvitation sends a second mail", async () => {
      const created = await harness.run(
        `mutation Create($input: CreateUserInput!) {
          createUser(input: $input) { id invitationStatus }
        }`,
        adminViewer(),
        {
          input: {
            email: "invitee@example.com",
            name: "Invitee",
            role: "MEMBER",
          },
        },
      );
      expect(created.errors).toBeUndefined();
      expect(created.data?.["createUser"]).toMatchObject({
        invitationStatus: "PENDING",
      });
      expect(harness.fake.mailSender.sent).toHaveLength(1);
      const user = created.data?.["createUser"] as { readonly id: string };

      const resent = await harness.run(
        `mutation Resend($userId: ID!) {
          resendInvitation(userId: $userId) { id invitationStatus }
        }`,
        adminViewer(),
        { userId: user.id },
      );
      expect(resent.errors).toBeUndefined();
      expect(resent.data?.["resendInvitation"]).toMatchObject({
        id: user.id,
        invitationStatus: "PENDING",
      });
      expect(harness.fake.mailSender.sent).toHaveLength(2);
    });

    test("resendInvitation returns RATE_LIMITED after three recent invitations", async () => {
      const created = await harness.run(
        `mutation Create($input: CreateUserInput!) {
          createUser(input: $input) { id }
        }`,
        adminViewer(),
        {
          input: {
            email: "invitee@example.com",
            name: "Invitee",
            role: "MEMBER",
          },
        },
      );
      const user = created.data?.["createUser"] as { readonly id: string };
      const now = harness.fake.clock.now();
      for (let index = 0; index < 2; index += 1) {
        const challenge = createEmailAuthChallenge({
          id: createEmailAuthChallengeId(`seed-invitation-${index}`),
          email: createEmailAddress("invitee@example.com"),
          purpose: EmailAuthChallengePurpose.Invitation,
          tokenHash: `seed-token-${index}`,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        });
        harness.fake.stores.challenges.set(challenge.id, challenge);
      }

      const result = await harness.run(
        `mutation Resend($userId: ID!) {
          resendInvitation(userId: $userId) { id }
        }`,
        adminViewer(),
        { userId: user.id },
      );

      expect(result.httpStatus).toBe(200);
      expect(errorCodes(result)).toEqual(["RATE_LIMITED"]);
    });

    test("an API key with every capability cannot create or resend invitations", async () => {
      const created = await harness.run(
        `mutation Create($input: CreateUserInput!) {
          createUser(input: $input) { id }
        }`,
        adminViewer(),
        {
          input: {
            email: "invitee@example.com",
            name: "Invitee",
            role: "MEMBER",
          },
        },
      );
      const user = created.data?.["createUser"] as { readonly id: string };
      const rootKeyViewer = apiKeyViewer(
        Object.values(Capability).map((capability) => ({ capability })),
      );

      const createResult = await harness.run(
        `mutation Create($input: CreateUserInput!) {
          createUser(input: $input) { id }
        }`,
        rootKeyViewer,
        {
          input: {
            email: "another-invitee@example.com",
            name: "Another Invitee",
            role: "MEMBER",
          },
        },
      );
      const resendResult = await harness.run(
        `mutation Resend($userId: ID!) {
          resendInvitation(userId: $userId) { id }
        }`,
        rootKeyViewer,
        { userId: user.id },
      );

      expect(errorCodes(createResult)).toEqual(["FORBIDDEN"]);
      expect(errorCodes(resendResult)).toEqual(["FORBIDDEN"]);
    });

    test.each([memberViewer(), apiKeyViewer([])])(
      "resendInvitation rejects non-admin viewers",
      async (viewer) => {
        const created = await harness.run(
          `mutation Create($input: CreateUserInput!) {
            createUser(input: $input) { id }
          }`,
          adminViewer(),
          {
            input: {
              email: "invitee@example.com",
              name: "Invitee",
              role: "MEMBER",
            },
          },
        );
        const createdUser = created.data?.["createUser"] as {
          readonly id: string;
        };
        const result = await harness.run(
          `mutation Resend($userId: ID!) { resendInvitation(userId: $userId) { id } }`,
          viewer,
          { userId: createdUser.id },
        );
        expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
      },
    );
  });
});
