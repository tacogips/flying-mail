import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
  type MessageId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  ServiceUnavailableError,
} from "../errors";
import { authorizesAnyMailManage } from "../policies/authorization";
import { RateLimiterUnavailableError } from "../ports/rate-limiter";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { createCreateApiKeyUseCase } from "./api-keys";
import { enforceAuthRateLimit } from "./auth-guards";
import { MAX_IDS_PER_REQUEST } from "./mail-limits";
import { createDeleteMessagesUseCase, createMarkReadUseCase } from "./messages";
import {
  createMarkSpamUseCase,
  createTagMessagesUseCase,
  createUntagMessagesUseCase,
} from "./tagging";
import { createTrashMessagesUseCase } from "./trash";
import { createCreateTagUseCase } from "./tags";
import { createSetUserActiveUseCase, createSetUserRoleUseCase } from "./users";
import {
  createMarkMessagesFetchedUseCase,
  createMarkMessagesNotFetchedUseCase,
} from "./fetch-state";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

function seedInbound(fake: FakeDependencies, id: string): MessageId {
  const messageId = createMessageId(id);
  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId,
      threadId: createThreadId(id),
      rfcMessageId: `${id}@other.com`,
      inReplyTo: null,
      references: [],
      subject: id,
      fromAddress: createEmailAddress("sender@other.com"),
      fromName: null,
      textBody: "body",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    }),
  );
  fake.messageStores.recipients.set(messageId, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("support@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(messageId, new Set());
  return messageId;
}

async function seedUser(
  fake: FakeDependencies,
  id: string,
  role: UserRole,
): Promise<void> {
  await fake.deps.userRepository.save(
    createUser({
      id: createUserId(id),
      email: createEmailAddress(`${id}@example.com`),
      name: id,
      role,
      createdAt: NOW,
    }),
  );
}

describe("tag management authorization", () => {
  const fake = createFakeDependencies({ now: NOW });
  const create = createCreateTagUseCase(fake.deps);
  const member = (rules: Parameters<typeof buildMailPermissions>[1]) =>
    memberViewer(
      "usr-member",
      buildMailPermissions(createUserId("usr-member"), rules),
    );

  test("an admin, a member with an ALLOW rule and a MAIL_MANAGE key may create tags", async () => {
    await expect(create(adminViewer(), "a", null)).resolves.toMatchObject({
      name: "a",
    });
    await expect(
      create(member([{ effect: "ALLOW", addressPattern: "*" }]), "b", null),
    ).resolves.toMatchObject({ name: "b" });
    await expect(
      create(
        apiKeyViewer([{ capability: Capability.MailManage, domainId }]),
        "c",
        null,
      ),
    ).resolves.toMatchObject({ name: "c" });
  });

  test("a VIEWER, a member without an ALLOW rule and a read-only key are refused", async () => {
    for (const viewer of [
      viewerViewer(),
      viewerViewer(
        "usr-viewer",
        buildMailPermissions(createUserId("usr-viewer"), [
          { effect: "ALLOW", addressPattern: "*" },
        ]),
      ),
      memberViewer(),
      member([{ effect: "DENY", addressPattern: "*" }]),
      apiKeyViewer([{ capability: Capability.MailRead, domainId }]),
    ]) {
      await expect(create(viewer, "nope", null)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  test("authorizesAnyMailManage mirrors the same rule", () => {
    expect(authorizesAnyMailManage(adminViewer())).toBe(true);
    expect(authorizesAnyMailManage(viewerViewer())).toBe(false);
    expect(authorizesAnyMailManage(memberViewer())).toBe(false);
  });
});

describe("api key expiresAt validation", () => {
  const scopes = [
    { capability: Capability.MailRead, domainId: null, addressPattern: "*" },
  ];

  async function expectInvalid(expiresAt: string): Promise<void> {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    const create = createCreateApiKeyUseCase(fake.deps);
    await expect(
      create(adminViewer(), { name: "k", scopes, expiresAt }),
    ).rejects.toMatchObject({ code: "BAD_USER_INPUT", field: "expiresAt" });
    expect(fake.stores.apiKeys.size).toBe(0);
  }

  test("rejects unparseable and past values", async () => {
    await expectInvalid("not-a-date");
    await expectInvalid("");
    await expectInvalid("2026-08-22T00:00:00.000Z");
    await expectInvalid(NOW);
  });

  test("stores a canonical ISO string for a future value", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    const issued = await createCreateApiKeyUseCase(fake.deps)(adminViewer(), {
      name: "k",
      scopes,
      expiresAt: "2026-09-01T09:00:00+09:00",
    });
    expect(issued.apiKey.expiresAt).toBe("2026-09-01T00:00:00.000Z");
  });

  test("null still means never expires", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    const issued = await createCreateApiKeyUseCase(fake.deps)(adminViewer(), {
      name: "k",
      scopes,
      expiresAt: null,
    });
    expect(issued.apiKey.expiresAt).toBeNull();
  });
});

describe("last active admin", () => {
  test("a concurrent demotion that empties the admin set loses the race", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    await seedUser(fake, "usr-other", UserRole.Admin);
    const repository = fake.deps.userRepository;
    const original = repository.saveUnlessLastActiveAdmin.bind(repository);
    repository.saveUnlessLastActiveAdmin = async (user) => {
      // The other admin is deactivated between the pre-check and the write.
      const other = fake.stores.users.get("usr-other");
      if (other !== undefined) {
        fake.stores.users.set("usr-other", { ...other, deactivatedAt: NOW });
      }
      return original(user);
    };

    await expect(
      createSetUserRoleUseCase(fake.deps)(
        adminViewer(),
        createUserId("usr-admin"),
        UserRole.Member,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fake.stores.users.get("usr-admin")?.role).toBe(UserRole.Admin);

    await expect(
      createSetUserActiveUseCase(fake.deps)(
        adminViewer(),
        createUserId("usr-admin"),
        false,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fake.stores.users.get("usr-admin")?.deactivatedAt).toBeNull();
  });

  test("demoting one of two admins still works", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    await seedUser(fake, "usr-other", UserRole.Admin);
    const result = await createSetUserRoleUseCase(fake.deps)(
      adminViewer(),
      createUserId("usr-other"),
      UserRole.Member,
    );
    expect(result.user.role).toBe(UserRole.Member);
  });
});

describe("deactivating a user revokes their API keys", () => {
  test("revokes keys the user created and leaves everyone else's alone", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    await seedUser(fake, "usr-second", UserRole.Admin);
    const create = createCreateApiKeyUseCase(fake.deps);
    const scopes = [
      { capability: Capability.MailRead, domainId: null, addressPattern: "*" },
    ];
    const mine = await create(adminViewer("usr-admin"), {
      name: "mine",
      scopes,
      expiresAt: null,
    });
    const theirs = await create(adminViewer("usr-second"), {
      name: "theirs",
      scopes,
      expiresAt: null,
    });
    const theirsToo = await create(adminViewer("usr-second"), {
      name: "theirs-too",
      scopes,
      expiresAt: null,
    });

    await createSetUserActiveUseCase(fake.deps)(
      adminViewer("usr-admin"),
      createUserId("usr-second"),
      false,
    );

    expect(fake.stores.apiKeys.get(theirs.apiKey.id)?.revokedAt).toBe(NOW);
    expect(fake.stores.apiKeys.get(theirsToo.apiKey.id)?.revokedAt).toBe(NOW);
    expect(fake.stores.apiKeys.get(mine.apiKey.id)?.revokedAt).toBeNull();
  });

  test("a refused deactivation revokes nothing", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedUser(fake, "usr-admin", UserRole.Admin);
    const issued = await createCreateApiKeyUseCase(fake.deps)(
      adminViewer("usr-admin"),
      {
        name: "mine",
        scopes: [
          {
            capability: Capability.MailRead,
            domainId: null,
            addressPattern: "*",
          },
        ],
        expiresAt: null,
      },
    );
    await expect(
      createSetUserActiveUseCase(fake.deps)(
        adminViewer("usr-admin"),
        createUserId("usr-admin"),
        false,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(fake.stores.apiKeys.get(issued.apiKey.id)?.revokedAt).toBeNull();
  });
});

describe("delete without a Trash tag", () => {
  test("fails with SERVICE_UNAVAILABLE instead of hard-deleting", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const id = seedInbound(fake, "msg-1");
    fake.stores.tags.clear();

    await expect(
      createDeleteMessagesUseCase(fake.deps)(adminViewer(), [id]),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(fake.messageStores.messages.has(id)).toBe(true);
  });
});

describe("id array cap", () => {
  const tooMany = Array.from({ length: MAX_IDS_PER_REQUEST + 1 }, (_, i) =>
    createMessageId(`m-${i}`),
  );
  const atCap = tooMany.slice(0, MAX_IDS_PER_REQUEST);
  const keyViewer = () =>
    apiKeyViewer([
      { capability: Capability.MailRead, domainId, addressPattern: "*" },
      { capability: Capability.MailManage, domainId, addressPattern: "*" },
    ]);

  test("every id-array mutation rejects more than the cap with BAD_USER_INPUT", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const tagId = [...fake.stores.tags.keys()][0];
    if (tagId === undefined) {
      throw new Error("expected seeded system tags");
    }
    const tag = (await fake.deps.tagRepository.findByIds([tagId as never]))[0];
    const calls: readonly (() => Promise<unknown>)[] = [
      () => createMarkReadUseCase(fake.deps)(adminViewer(), tooMany, true),
      () => createDeleteMessagesUseCase(fake.deps)(adminViewer(), tooMany),
      () => createTrashMessagesUseCase(fake.deps)(adminViewer(), tooMany),
      () => createMarkSpamUseCase(fake.deps)(adminViewer(), tooMany),
      () =>
        createTagMessagesUseCase(fake.deps)(
          adminViewer(),
          tooMany,
          tag === undefined ? [] : [tag.id],
        ),
      () =>
        createUntagMessagesUseCase(fake.deps)(
          adminViewer(),
          tooMany,
          tag === undefined ? [] : [tag.id],
        ),
      () => createMarkMessagesFetchedUseCase(fake.deps)(keyViewer(), tooMany),
      () =>
        createMarkMessagesNotFetchedUseCase(fake.deps)(keyViewer(), tooMany),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toBeInstanceOf(BadUserInputError);
    }
  });

  test("exactly the cap, and an empty array, are still accepted", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await expect(
      createMarkReadUseCase(fake.deps)(adminViewer(), atCap, true),
    ).resolves.toEqual([]);
    await expect(
      createMarkReadUseCase(fake.deps)(adminViewer(), [], true),
    ).resolves.toEqual([]);
    await expect(
      createDeleteMessagesUseCase(fake.deps)(adminViewer(), []),
    ).resolves.toBe(0);
  });
});

describe("auth rate limiter failure semantics", () => {
  function throwingLimiter() {
    return {
      async limit(): Promise<boolean> {
        throw new Error("binding unavailable");
      },
    };
  }

  test("bootstrapAdmin and verifyEmailAuthToken fail closed", async () => {
    const fake = createFakeDependencies({
      now: NOW,
      rateLimiter: throwingLimiter(),
    });
    for (const operation of [
      "bootstrapAdmin",
      "verifyEmailAuthToken",
    ] as const) {
      await expect(
        enforceAuthRateLimit(fake.deps, operation, "203.0.113.9"),
      ).rejects.toBeInstanceOf(RateLimitedError);
    }
  });

  test("requestEmailAuth fails open", async () => {
    const fake = createFakeDependencies({
      now: NOW,
      rateLimiter: throwingLimiter(),
    });
    await expect(
      enforceAuthRateLimit(fake.deps, "requestEmailAuth", null),
    ).resolves.toBeUndefined();
  });

  test("an unavailable-limiter error from the adapter is handled the same way", async () => {
    const fake = createFakeDependencies({
      now: NOW,
      rateLimiter: {
        async limit(): Promise<boolean> {
          throw new RateLimiterUnavailableError("down");
        },
      },
    });
    await expect(
      enforceAuthRateLimit(fake.deps, "bootstrapAdmin", null),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      enforceAuthRateLimit(fake.deps, "requestEmailAuth", null),
    ).resolves.toBeUndefined();
  });
});
