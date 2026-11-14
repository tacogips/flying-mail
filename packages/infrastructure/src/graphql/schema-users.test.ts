import { createFakeDependencies } from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
  viewerViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness as Harness,
} from "./graphql-test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

async function createHarness(): Promise<Harness> {
  const fake = createFakeDependencies({ now: NOW });

  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "secret-token",
        createdAt: NOW,
      }),
      NOW,
    ),
  );

  return createGraphQLHarness(fake);
}

/** Persists a real `User` row for `adminViewer()`'s default id.
 * `adminViewer()` alone is a synthetic `Viewer`; the last-active-admin
 * invariant counts real `userRepository` rows, so a test that relies on
 * the calling admin itself counting toward that total must seed it. */
async function seedCallingAdmin(harness: Harness): Promise<void> {
  await harness.deps.userRepository.save(
    createUser({
      id: createUserId("usr-admin"),
      email: createEmailAddress("usr-admin@example.com"),
      name: "Calling Admin",
      role: UserRole.Admin,
      createdAt: NOW,
    }),
  );
}

interface CreatedUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly active: boolean;
  readonly permissions: readonly unknown[];
}

const CREATE_USER_MUTATION = `
  mutation Create($input: CreateUserInput!) {
    createUser(input: $input) {
      id email name role active createdAt updatedAt
      permissions { id }
    }
  }
`;

async function createUserViaApi(
  harness: Harness,
  input: {
    readonly email: string;
    readonly name: string;
    readonly role: string;
  },
): Promise<CreatedUser> {
  const result = await harness.run(CREATE_USER_MUTATION, adminViewer(), {
    input,
  });
  expect(result.errors).toBeUndefined();
  return result.data?.["createUser"] as CreatedUser;
}

describe("admin user administration over GraphQL", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  test("an admin can create, list, and read back a user", async () => {
    const created = await createUserViaApi(harness, {
      email: "member@example.com",
      name: "Member One",
      role: "MEMBER",
    });
    expect(created.email).toBe("member@example.com");
    expect(created.role).toBe("MEMBER");
    // No password is ever set: the created user must sign in through the
    // existing passwordless email flow, same as every other user.
    expect(created.active).toBe(true);
    expect(created.permissions).toEqual([]);

    const listed = await harness.run(
      "{ users { id email role } }",
      adminViewer(),
    );
    expect(listed.errors).toBeUndefined();
    const users = listed.data?.["users"] as { id: string; email: string }[];
    expect(users.some((entry) => entry.id === created.id)).toBe(true);

    const single = await harness.run(
      `query Get($id: ID!) { user(id: $id) { id email role active } }`,
      adminViewer(),
      { id: created.id },
    );
    expect(single.errors).toBeUndefined();
    expect(single.data?.["user"]).toMatchObject({
      id: created.id,
      email: "member@example.com",
      role: "MEMBER",
      active: true,
    });
  });

  test("a duplicate email on createUser is a CONFLICT", async () => {
    await createUserViaApi(harness, {
      email: "dup@example.com",
      name: "First",
      role: "MEMBER",
    });
    const again = await harness.run(CREATE_USER_MUTATION, adminViewer(), {
      input: { email: "dup@example.com", name: "Second", role: "MEMBER" },
    });
    expect(errorCodes(again)).toEqual(["CONFLICT"]);
  });

  test("a nonexistent user id reads as null, not an error", async () => {
    const result = await harness.run(
      `query Get($id: ID!) { user(id: $id) { id } }`,
      adminViewer(),
      { id: "nope" },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.["user"]).toBeNull();
  });

  test("users, createUser and addUserMailPermission are FORBIDDEN for a member, a viewer, and an api key holding KEY_ADMIN", async () => {
    const created = await createUserViaApi(harness, {
      email: "target@example.com",
      name: "Target",
      role: "MEMBER",
    });

    const keyAdmin = apiKeyViewer([{ capability: Capability.KeyAdmin }]);
    // User administration is deliberately outside the API-key scope system,
    // so KEY_ADMIN never grants it -- unlike every other admin surface.
    for (const viewer of [memberViewer(), viewerViewer(), keyAdmin]) {
      const listResult = await harness.run("{ users { id } }", viewer);
      expect(errorCodes(listResult)).toEqual(["FORBIDDEN"]);

      const createResult = await harness.run(CREATE_USER_MUTATION, viewer, {
        input: { email: "new@example.com", name: "New", role: "MEMBER" },
      });
      expect(errorCodes(createResult)).toEqual(["FORBIDDEN"]);

      const permissionResult = await harness.run(
        `mutation Add($userId: ID!, $input: UserMailPermissionInput!) {
           addUserMailPermission(userId: $userId, input: $input) { id }
         }`,
        viewer,
        {
          userId: created.id,
          input: { effect: "ALLOW", addressPattern: "*" },
        },
      );
      expect(errorCodes(permissionResult)).toEqual(["FORBIDDEN"]);
    }
  });

  test("setUserRole and setUserActive reject changing the last active admin, but allow it once a second admin exists", async () => {
    // `adminViewer()` is a synthetic caller; persist it as a real row so
    // it is the one and only admin to start with.
    await seedCallingAdmin(harness);
    const callerId = "usr-admin";

    // With only "usr-admin" as an active admin, demoting or deactivating
    // it must be rejected -- there would be nothing left to administer
    // the instance.
    const demoteSoleAdmin = await harness.run(
      `mutation SetRole($id: ID!) {
         setUserRole(id: $id, role: MEMBER) { id }
       }`,
      adminViewer(),
      { id: callerId },
    );
    expect(errorCodes(demoteSoleAdmin)).toEqual(["CONFLICT"]);

    const deactivateSoleAdmin = await harness.run(
      `mutation SetActive($id: ID!) {
         setUserActive(id: $id, active: false) { id }
       }`,
      adminViewer(),
      { id: callerId },
    );
    expect(errorCodes(deactivateSoleAdmin)).toEqual(["CONFLICT"]);

    const second = await createUserViaApi(harness, {
      email: "second-admin@example.com",
      name: "Second Admin",
      role: "ADMIN",
    });

    // Two active admins now exist ("usr-admin" plus "second"): demoting
    // "usr-admin" is safe because "second" remains to administer.
    const demoted = await harness.run(
      `mutation SetRole($id: ID!) {
         setUserRole(id: $id, role: MEMBER) { id role }
       }`,
      adminViewer(),
      { id: callerId },
    );
    expect(demoted.errors).toBeUndefined();
    const demotedUser = demoted.data?.["setUserRole"] as { role: string };
    expect(demotedUser.role).toBe("MEMBER");

    // "second" is now the sole active admin: demoting or deactivating it
    // must be rejected as a CONFLICT.
    const demoteRejected = await harness.run(
      `mutation SetRole($id: ID!) {
         setUserRole(id: $id, role: MEMBER) { id }
       }`,
      adminViewer(),
      { id: second.id },
    );
    expect(errorCodes(demoteRejected)).toEqual(["CONFLICT"]);

    const deactivateRejected = await harness.run(
      `mutation SetActive($id: ID!) {
         setUserActive(id: $id, active: false) { id }
       }`,
      adminViewer(),
      { id: second.id },
    );
    expect(errorCodes(deactivateRejected)).toEqual(["CONFLICT"]);

    // Reactivating an already-active user, and deactivating a non-admin
    // (the now-demoted "usr-admin"), are never blocked by the invariant.
    const reactivateOk = await harness.run(
      `mutation SetActive($id: ID!) {
         setUserActive(id: $id, active: true) { id active }
       }`,
      adminViewer(),
      { id: second.id },
    );
    expect(reactivateOk.errors).toBeUndefined();

    const memberToggle = await harness.run(
      `mutation SetActive($id: ID!) {
         setUserActive(id: $id, active: false) { id active }
       }`,
      adminViewer(),
      { id: callerId },
    );
    expect(memberToggle.errors).toBeUndefined();
    expect(
      (memberToggle.data?.["setUserActive"] as { active: boolean })?.active,
    ).toBe(false);
  });

  test("addUserMailPermission and removeUserMailPermission round-trip the (effect, domainId, addressPattern) tuple", async () => {
    const target = await createUserViaApi(harness, {
      email: "agent@example.com",
      name: "Agent",
      role: "MEMBER",
    });

    const added = await harness.run(
      `mutation Add($userId: ID!, $input: UserMailPermissionInput!) {
         addUserMailPermission(userId: $userId, input: $input) {
           id effect addressPattern createdByUserId createdAt
           domain { id name }
         }
       }`,
      adminViewer(),
      {
        userId: target.id,
        input: {
          effect: "DENY",
          domainId,
          addressPattern: "support@example.com",
        },
      },
    );
    expect(added.errors).toBeUndefined();
    const permission = added.data?.["addUserMailPermission"] as {
      id: string;
      effect: string;
      addressPattern: string;
      createdByUserId: string;
      domain: { id: string; name: string } | null;
    };
    expect(permission.effect).toBe("DENY");
    expect(permission.addressPattern).toBe("support@example.com");
    expect(permission.domain?.name).toBe("example.com");

    // A second, domain-wide ALLOW rule for the same user must not be
    // conflated with the DENY above: both tuples must round-trip
    // independently, proving domain/pattern pairs stay correlated per rule
    // rather than flattening into a cross-product.
    const addedWildcard = await harness.run(
      `mutation Add($userId: ID!, $input: UserMailPermissionInput!) {
         addUserMailPermission(userId: $userId, input: $input) {
           id effect addressPattern domain { id }
         }
       }`,
      adminViewer(),
      {
        userId: target.id,
        input: { effect: "ALLOW", addressPattern: "*" },
      },
    );
    expect(addedWildcard.errors).toBeUndefined();
    const wildcard = addedWildcard.data?.["addUserMailPermission"] as {
      effect: string;
      addressPattern: string;
      domain: { id: string } | null;
    };
    expect(wildcard.effect).toBe("ALLOW");
    expect(wildcard.addressPattern).toBe("*");
    expect(wildcard.domain).toBeNull();

    const fetched = await harness.run(
      `query Get($id: ID!) {
         user(id: $id) {
           permissions { id effect addressPattern domain { name } }
         }
       }`,
      adminViewer(),
      { id: target.id },
    );
    const permissions =
      (
        fetched.data?.["user"] as {
          permissions: {
            readonly id: string;
            readonly effect: string;
            readonly addressPattern: string;
            readonly domain: { readonly name: string } | null;
          }[];
        }
      )?.permissions ?? [];
    expect(permissions).toHaveLength(2);
    expect(permissions).toContainEqual(
      expect.objectContaining({
        effect: "DENY",
        addressPattern: "support@example.com",
        domain: { name: "example.com" },
      }),
    );
    expect(permissions).toContainEqual(
      expect.objectContaining({
        effect: "ALLOW",
        addressPattern: "*",
        domain: null,
      }),
    );

    const removed = await harness.run(
      `mutation Remove($id: ID!) { removeUserMailPermission(id: $id) }`,
      adminViewer(),
      { id: permission.id },
    );
    expect(removed.errors).toBeUndefined();
    expect(removed.data?.["removeUserMailPermission"]).toBe(true);

    const afterRemoval = await harness.run(
      `query Get($id: ID!) { user(id: $id) { permissions { id } } }`,
      adminViewer(),
      { id: target.id },
    );
    expect(
      (afterRemoval.data?.["user"] as { permissions: unknown[] })?.permissions,
    ).toHaveLength(1);

    // Removing an already-removed rule is NOT_FOUND, not a silent success.
    const removedAgain = await harness.run(
      `mutation Remove($id: ID!) { removeUserMailPermission(id: $id) }`,
      adminViewer(),
      { id: permission.id },
    );
    expect(errorCodes(removedAgain)).toEqual(["NOT_FOUND"]);
  });

  test("an admin may add a mailbox deny against itself without losing administrative authority", async () => {
    const selfViewer = adminViewer("usr-self");
    const admin = await createUserViaApi(harness, {
      email: "self-admin@example.com",
      name: "Self Admin",
      role: "ADMIN",
    });

    const denied = await harness.run(
      `mutation Add($userId: ID!, $input: UserMailPermissionInput!) {
         addUserMailPermission(userId: $userId, input: $input) { effect }
       }`,
      selfViewer,
      {
        userId: admin.id,
        input: { effect: "DENY", addressPattern: "*" },
      },
    );
    expect(denied.errors).toBeUndefined();
    expect(
      (denied.data?.["addUserMailPermission"] as { effect: string })?.effect,
    ).toBe("DENY");

    // The admin's role is untouched: a self-deny only removes mailbox
    // access, never administrative authority.
    const stillAdmin = await harness.run(
      `query Get($id: ID!) { user(id: $id) { role active } }`,
      selfViewer,
      { id: admin.id },
    );
    expect(stillAdmin.data?.["user"]).toMatchObject({
      role: "ADMIN",
      active: true,
    });
  });
});
