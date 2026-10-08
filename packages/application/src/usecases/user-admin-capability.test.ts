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
import { UserPermissionEffect } from "@flying-mail/domain/entities/user-mail-permission";
import { MATCH_ALL_ADDRESSES } from "@flying-mail/domain/value-objects/address-pattern";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { ConflictError, ForbiddenError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const CREATOR_ID = createUserId("usr-creator");
const OTHER_ADMIN_ID = createUserId("usr-admin-two");
const TARGET_ID = createUserId("usr-target");
const KEY_ID = createApiKeyId("key-ua");
const USER_ADMIN_VIEWER = apiKeyViewer(
  [{ capability: Capability.UserAdmin }],
  KEY_ID,
);

async function seedUser(
  fake: FakeDependencies,
  id: ReturnType<typeof createUserId>,
  role: UserRole,
  name: string,
) {
  const user = createUser({
    id,
    email: createEmailAddress(`${id}@example.com`),
    name,
    role,
    createdAt: NOW,
  });
  await fake.deps.userRepository.save(user);
  return user;
}

async function seedUserAdminKey(
  fake: FakeDependencies,
  createdByUserId: ReturnType<typeof createUserId> | null = CREATOR_ID,
) {
  const key = createApiKey({
    id: KEY_ID,
    name: "user admin key",
    keyHash: "hash",
    keyPrefix: "prefix",
    createdByUserId,
    expiresAt: null,
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

async function seedAdminsAndTarget(fake: FakeDependencies): Promise<void> {
  await seedUser(fake, CREATOR_ID, UserRole.Admin, "Creator");
  await seedUser(fake, OTHER_ADMIN_ID, UserRole.Admin, "Other admin");
  await seedUser(fake, TARGET_ID, UserRole.Member, "Target");
  await seedUserAdminKey(fake);
}

describe("USER_ADMIN capability", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    usecases = createUseCases(fake.deps);
    await seedAdminsAndTarget(fake);
  });

  test("a live key can list, read, update users and manage mail and template rules", async () => {
    await expect(usecases.listUsers(USER_ADMIN_VIEWER)).resolves.toHaveLength(
      3,
    );
    await expect(
      usecases.getUser(USER_ADMIN_VIEWER, TARGET_ID),
    ).resolves.toMatchObject({ user: { id: TARGET_ID } });
    await expect(
      usecases.setUserRole(USER_ADMIN_VIEWER, TARGET_ID, UserRole.Viewer),
    ).resolves.toMatchObject({ user: { role: UserRole.Viewer } });
    await expect(
      usecases.setUserActive(USER_ADMIN_VIEWER, TARGET_ID, false),
    ).resolves.toMatchObject({ user: { deactivatedAt: NOW } });
    await expect(
      usecases.setUserActive(USER_ADMIN_VIEWER, TARGET_ID, true),
    ).resolves.toMatchObject({ user: { deactivatedAt: null } });

    const mailRule = await usecases.addUserMailPermission(
      USER_ADMIN_VIEWER,
      TARGET_ID,
      {
        effect: UserPermissionEffect.Allow,
        domainId: null,
        addressPattern: "*",
      },
    );
    expect(mailRule.createdByUserId).toBe(CREATOR_ID);
    await expect(
      usecases.removeUserMailPermission(USER_ADMIN_VIEWER, mailRule.id),
    ).resolves.toBe(true);

    const templateRule = await usecases.addUserTemplatePermission(
      USER_ADMIN_VIEWER,
      TARGET_ID,
      {
        capability: Capability.TemplateCreate,
        effect: UserPermissionEffect.Allow,
      },
    );
    expect(templateRule.createdByUserId).toBe(CREATOR_ID);
    await expect(
      usecases.listUserTemplatePermissions(USER_ADMIN_VIEWER, [TARGET_ID]),
    ).resolves.toMatchObject(
      new Map([[TARGET_ID as string, [{ id: templateRule.id }]]]),
    );
    await expect(
      usecases.removeUserTemplatePermission(USER_ADMIN_VIEWER, templateRule.id),
    ).resolves.toBe(true);
  });

  test("createUser and resendInvitation remain session-only", async () => {
    await expect(
      usecases.createUser(USER_ADMIN_VIEWER, {
        email: "new@example.com",
        name: "New user",
        role: UserRole.Member,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      usecases.resendInvitation(USER_ADMIN_VIEWER, TARGET_ID),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      usecases.createUser(memberViewer(), {
        email: "member-new@example.com",
        name: "New user",
        role: UserRole.Member,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a key without USER_ADMIN and a member session are refused", async () => {
    const keyAdmin = apiKeyViewer(
      [{ capability: Capability.KeyAdmin }],
      KEY_ID,
    );
    await expect(usecases.listUsers(keyAdmin)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(usecases.listUsers(memberViewer())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      usecases.getUser(keyAdmin, createUserId("missing-user")),
    ).rejects.toThrow("This API key lacks the USER_ADMIN capability");
  });

  test.each(["demoted", "deactivated", "deleted"] as const)(
    "a creator who is %s loses USER_ADMIN on the next call",
    async (state) => {
      const creator = await fake.deps.userRepository.findById(CREATOR_ID);
      if (creator === null) throw new Error("seeded creator is missing");
      if (state === "demoted") {
        await fake.deps.userRepository.save({
          ...creator,
          role: UserRole.Member,
        });
      } else if (state === "deactivated") {
        await fake.deps.userRepository.save(deactivateUser(creator, NOW));
      } else {
        fake.stores.users.delete(CREATOR_ID);
      }
      await expect(usecases.listUsers(USER_ADMIN_VIEWER)).rejects.toThrow(
        "no longer an active ADMIN",
      );
    },
  );

  test("revoking a key after viewer construction disables USER_ADMIN", async () => {
    const key = await fake.deps.apiKeyRepository.findById(KEY_ID);
    if (key === null) throw new Error("seeded key is missing");
    await fake.deps.apiKeyRepository.save(revokeApiKey(key, NOW));
    await expect(usecases.listUsers(USER_ADMIN_VIEWER)).rejects.toThrow(
      "this key is no longer usable",
    );
  });

  test("the last active admin cannot be demoted or deactivated", async () => {
    const soleAdmin = createFakeDependencies({ now: NOW });
    const soleUseCases = createUseCases(soleAdmin.deps);
    await seedUser(soleAdmin, CREATOR_ID, UserRole.Admin, "Creator");
    await seedUser(soleAdmin, TARGET_ID, UserRole.Member, "Target");
    await seedUserAdminKey(soleAdmin);
    await expect(
      soleUseCases.setUserRole(USER_ADMIN_VIEWER, CREATOR_ID, UserRole.Member),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      soleUseCases.setUserActive(USER_ADMIN_VIEWER, CREATOR_ID, false),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("a key may demote its creator only while another admin remains, then cannot restore them", async () => {
    await expect(
      usecases.setUserRole(USER_ADMIN_VIEWER, CREATOR_ID, UserRole.Member),
    ).resolves.toMatchObject({ user: { role: UserRole.Member } });
    await expect(usecases.listUsers(USER_ADMIN_VIEWER)).rejects.toThrow(
      "no longer an active ADMIN",
    );
    await expect(
      usecases.setUserRole(USER_ADMIN_VIEWER, CREATOR_ID, UserRole.Admin),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a live USER_ADMIN key with MAIL_READ keeps mail access independent", async () => {
    const mailReader = apiKeyViewer(
      [
        { capability: Capability.UserAdmin },
        { capability: Capability.MailRead },
      ],
      KEY_ID,
    );
    const creator = await fake.deps.userRepository.findById(CREATOR_ID);
    if (creator === null) throw new Error("seeded creator is missing");
    await fake.deps.userRepository.save(deactivateUser(creator, NOW));
    await expect(usecases.listUsers(mailReader)).rejects.toThrow(
      "no longer an active ADMIN",
    );
    await expect(usecases.listMessages(mailReader, {})).resolves.toMatchObject({
      nodes: [],
      totalCount: 0,
    });
  });

  test("only an admin session can create USER_ADMIN keys; adding it is creator-only", async () => {
    const createApiKeyUseCase = usecases.createApiKey;
    const issued = await createApiKeyUseCase(adminViewer(CREATOR_ID), {
      name: "new user admin key",
      scopes: [
        {
          capability: Capability.UserAdmin,
          domainId: null,
          addressPattern: "*",
        },
      ],
      expiresAt: null,
    });
    expect(issued.apiKey.createdByUserId).toBe(CREATOR_ID);
    expect(issued.scopes[0]?.domainId).toBeNull();

    const keyAdmin = apiKeyViewer(
      [{ capability: Capability.KeyAdmin }],
      "key-admin",
    );
    const combined = apiKeyViewer(
      [
        { capability: Capability.KeyAdmin },
        { capability: Capability.UserAdmin },
      ],
      KEY_ID,
    );
    for (const viewer of [keyAdmin, combined]) {
      await expect(
        createApiKeyUseCase(viewer, {
          name: "forbidden user admin key",
          scopes: [
            {
              capability: Capability.UserAdmin,
              domainId: null,
              addressPattern: "*",
            },
          ],
          expiresAt: null,
        }),
      ).rejects.toThrow("USER_ADMIN can only be granted by a signed-in admin");
    }

    const addScope = usecases.addApiKeyScope;
    const ownedKey = await createApiKeyUseCase(adminViewer(CREATOR_ID), {
      name: "owned key",
      scopes: [
        {
          capability: Capability.MailRead,
          domainId: null,
          addressPattern: "*",
        },
      ],
      expiresAt: null,
    });
    await expect(
      addScope(adminViewer(OTHER_ADMIN_ID), ownedKey.apiKey.id, {
        capability: Capability.UserAdmin,
        domainId: null,
        addressPattern: "*",
      }),
    ).rejects.toThrow("USER_ADMIN can only be added to a key you created");
    await expect(
      addScope(adminViewer(CREATOR_ID), ownedKey.apiKey.id, {
        capability: Capability.UserAdmin,
        domainId: null,
        addressPattern: "*",
      }),
    ).resolves.toHaveLength(2);
    await expect(
      addScope(keyAdmin, ownedKey.apiKey.id, {
        capability: Capability.UserAdmin,
        domainId: null,
        addressPattern: "*",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const orphanKey = createApiKey({
      id: createApiKeyId("key-orphan"),
      name: "orphaned key",
      keyHash: "hash-orphan",
      keyPrefix: "prefix-orphan",
      createdByUserId: null,
      expiresAt: null,
      createdAt: NOW,
    });
    await fake.deps.apiKeyRepository.save(orphanKey);
    await expect(
      addScope(adminViewer(CREATOR_ID), orphanKey.id, {
        capability: Capability.UserAdmin,
        domainId: null,
        addressPattern: "*",
      }),
    ).rejects.toThrow("USER_ADMIN can only be added to a key you created");
  });
});
