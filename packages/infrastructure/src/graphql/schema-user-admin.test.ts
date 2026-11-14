import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import { apiKeyViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import {
  Capability,
  createApiKey,
  createApiKeyScope,
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
import { describe, expect, test } from "vitest";
import { createGraphQLHarness, errorCodes } from "./graphql-test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const CREATOR_ID = createUserId("usr-creator");
const TARGET_ID = createUserId("usr-target");
const KEY_ID = createApiKeyId("key-ua");

async function createHarness() {
  const fake = createFakeDependencies({ now: NOW });
  const creator = createUser({
    id: CREATOR_ID,
    email: createEmailAddress("creator@example.com"),
    name: "Creator",
    role: UserRole.Admin,
    createdAt: NOW,
  });
  const target = createUser({
    id: TARGET_ID,
    email: createEmailAddress("target@example.com"),
    name: "Target",
    role: UserRole.Member,
    createdAt: NOW,
  });
  await fake.deps.userRepository.save(creator);
  await fake.deps.userRepository.save(target);
  await fake.deps.apiKeyRepository.save(
    createApiKey({
      id: KEY_ID,
      name: "user admin",
      keyHash: "hash",
      keyPrefix: "prefix",
      createdByUserId: CREATOR_ID,
      expiresAt: null,
      createdAt: NOW,
    }),
  );
  await fake.deps.apiKeyRepository.saveScope(
    createApiKeyScope({
      id: createApiKeyScopeId("scope-user-admin"),
      apiKeyId: KEY_ID,
      capability: Capability.UserAdmin,
      domainId: null,
      addressPattern: MATCH_ALL_ADDRESSES,
    }),
  );
  return {
    harness: createGraphQLHarness(fake),
    fake,
    viewer: apiKeyViewer([{ capability: Capability.UserAdmin }], KEY_ID),
  };
}

describe("USER_ADMIN GraphQL authorization", () => {
  test("allows the assigned operations and records the creator as rule actor", async () => {
    const { harness, viewer } = await createHarness();
    const listed = await harness.run(
      "{ users { id email permissions { id } templatePermissions { id } } }",
      viewer,
    );
    expect(listed.errors).toBeUndefined();

    const setRole = await harness.run(
      "mutation SetRole($id: ID!) { setUserRole(id: $id, role: VIEWER) { id role } }",
      viewer,
      { id: TARGET_ID },
    );
    expect(setRole.errors).toBeUndefined();

    const addRule = await harness.run(
      `mutation Add($userId: ID!, $input: UserMailPermissionInput!) {
        addUserMailPermission(userId: $userId, input: $input) {
          id createdByUserId
        }
      }`,
      viewer,
      {
        userId: TARGET_ID,
        input: {
          effect: UserPermissionEffect.Allow,
          addressPattern: "*",
        },
      },
    );
    expect(addRule.errors).toBeUndefined();
    expect(addRule.data?.["addUserMailPermission"]).toMatchObject({
      createdByUserId: CREATOR_ID,
    });
  });

  test("keeps createUser and resendInvitation forbidden for a USER_ADMIN key", async () => {
    const { harness, viewer } = await createHarness();
    const create = await harness.run(
      `mutation Create($input: CreateUserInput!) {
        createUser(input: $input) { id }
      }`,
      viewer,
      { input: { email: "new@example.com", name: "New", role: "MEMBER" } },
    );
    expect(errorCodes(create)).toEqual(["FORBIDDEN"]);

    const resend = await harness.run(
      "mutation Resend($id: ID!) { resendInvitation(userId: $id) { id } }",
      viewer,
      { id: TARGET_ID },
    );
    expect(errorCodes(resend)).toEqual(["FORBIDDEN"]);
  });

  test("stops accepting the key after its creator is deactivated", async () => {
    const { harness, fake, viewer } = await createHarness();
    const creator = await fake.deps.userRepository.findById(CREATOR_ID);
    if (creator === null) throw new Error("seeded creator is missing");
    await fake.deps.userRepository.save(deactivateUser(creator, NOW));

    const result = await harness.run("{ users { id } }", viewer);
    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
  });
});
