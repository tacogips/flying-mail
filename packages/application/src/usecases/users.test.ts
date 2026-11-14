import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createUser,
  isUserActive,
  UserRole,
} from "@mailcal/domain/entities/user";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createUserId,
  createUserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import {
  createAddUserMailPermissionUseCase,
  createCreateUserUseCase,
  createGetUserUseCase,
  createListUsersUseCase,
  createRemoveUserMailPermissionUseCase,
  createSetUserActiveUseCase,
  createSetUserRoleUseCase,
} from "./users";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const adminId = createUserId("usr-admin");

/** Persists an admin `User` row matching `adminViewer()`'s default id, so
 * the last-active-admin invariant has something real to count against --
 * `adminViewer()` alone is a synthetic `Viewer`, not a stored row. */
async function seedAdmin(fake: FakeDependencies, id = adminId): Promise<void> {
  await fake.deps.userRepository.save(
    createUser({
      id,
      email: createEmailAddress(`${id}@example.com`),
      name: "Admin",
      role: UserRole.Admin,
      createdAt: NOW,
    }),
  );
}

describe("user administration: admin-only gate", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
  });

  test("a MEMBER, a VIEWER and an API key (even with KEY_ADMIN) are all rejected", async () => {
    const list = createListUsersUseCase(fake.deps);
    const create = createCreateUserUseCase(fake.deps);
    const keyAdmin = apiKeyViewer([{ capability: Capability.KeyAdmin }]);
    for (const viewer of [memberViewer(), viewerViewer(), keyAdmin]) {
      await expect(list(viewer)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        create(viewer, {
          email: "new@example.com",
          name: "New",
          role: UserRole.Member,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  test("an admin may list and get users", async () => {
    const list = createListUsersUseCase(fake.deps);
    const result = await list(adminViewer(adminId));
    expect(result.map((entry) => entry.user.id)).toEqual([adminId]);
    expect(result[0]?.permissions).toEqual([]);

    const get = createGetUserUseCase(fake.deps);
    expect((await get(adminViewer(adminId), adminId))?.user.id).toBe(adminId);
    expect(await get(adminViewer(adminId), createUserId("nope"))).toBeNull();
  });

  test("getUser, setUserRole, and setUserActive reject a MEMBER, a VIEWER, and an API key (even with KEY_ADMIN)", async () => {
    const memberId = createUserId("usr-member-1");
    await fake.deps.userRepository.save(
      createUser({
        id: memberId,
        email: createEmailAddress("member@example.com"),
        name: "Member",
        role: UserRole.Member,
        createdAt: NOW,
      }),
    );
    const get = createGetUserUseCase(fake.deps);
    const setRole = createSetUserRoleUseCase(fake.deps);
    const setActive = createSetUserActiveUseCase(fake.deps);
    const keyAdmin = apiKeyViewer([{ capability: Capability.KeyAdmin }]);
    for (const viewer of [memberViewer(), viewerViewer(), keyAdmin]) {
      await expect(get(viewer, memberId)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(
        setRole(viewer, memberId, UserRole.Viewer),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setActive(viewer, memberId, false)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    // Rejection happens before any mutation: the target is untouched.
    const untouched = await fake.deps.userRepository.findById(memberId);
    expect(untouched?.role).toBe(UserRole.Member);
    expect(untouched !== null && isUserActive(untouched)).toBe(true);
  });
});

describe("createUser", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
  });

  test("creates a user with no password, ready for the passwordless flow", async () => {
    const create = createCreateUserUseCase(fake.deps);
    const result = await create(adminViewer(adminId), {
      email: "new.member@example.com",
      name: "New Member",
      role: UserRole.Member,
    });
    expect(result.user.role).toBe(UserRole.Member);
    expect(isUserActive(result.user)).toBe(true);
    expect(result.permissions).toEqual([]);
    // No credential of any kind is stored alongside the user row.
    expect(result.user).not.toHaveProperty("password");
    expect(result.user).not.toHaveProperty("passwordHash");
  });

  test("rejects a duplicate email", async () => {
    const create = createCreateUserUseCase(fake.deps);
    await create(adminViewer(adminId), {
      email: "dup@example.com",
      name: "First",
      role: UserRole.Viewer,
    });
    await expect(
      create(adminViewer(adminId), {
        email: "DUP@example.com",
        name: "Second",
        role: UserRole.Viewer,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects a malformed email", async () => {
    const create = createCreateUserUseCase(fake.deps);
    await expect(
      create(adminViewer(adminId), {
        email: "not-an-address",
        name: "Bad",
        role: UserRole.Viewer,
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });
});

describe("setUserRole / setUserActive: last-active-admin invariant", () => {
  let fake: FakeDependencies;
  const secondAdminId = createUserId("usr-admin-2");
  const memberId = createUserId("usr-member-1");

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
    await fake.deps.userRepository.save(
      createUser({
        id: memberId,
        email: createEmailAddress("member@example.com"),
        name: "Member",
        role: UserRole.Member,
        createdAt: NOW,
      }),
    );
  });

  test("demoting the sole active admin is rejected", async () => {
    const setRole = createSetUserRoleUseCase(fake.deps);
    await expect(
      setRole(adminViewer(adminId), adminId, UserRole.Member),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("deactivating the sole active admin is rejected", async () => {
    const setActive = createSetUserActiveUseCase(fake.deps);
    await expect(
      setActive(adminViewer(adminId), adminId, false),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("demoting/deactivating a non-admin never trips the invariant", async () => {
    const setRole = createSetUserRoleUseCase(fake.deps);
    const promoted = await setRole(
      adminViewer(adminId),
      memberId,
      UserRole.Viewer,
    );
    expect(promoted.user.role).toBe(UserRole.Viewer);

    const setActive = createSetUserActiveUseCase(fake.deps);
    const deactivated = await setActive(adminViewer(adminId), memberId, false);
    expect(isUserActive(deactivated.user)).toBe(false);
  });

  test("with two active admins, demoting or deactivating one succeeds", async () => {
    await seedAdmin(fake, secondAdminId);
    const setRole = createSetUserRoleUseCase(fake.deps);
    const demoted = await setRole(
      adminViewer(adminId),
      secondAdminId,
      UserRole.Member,
    );
    expect(demoted.user.role).toBe(UserRole.Member);

    // Restore two admins, then exercise deactivation instead.
    const setActive = createSetUserActiveUseCase(fake.deps);
    await setRole(adminViewer(adminId), secondAdminId, UserRole.Admin);
    const deactivated = await setActive(
      adminViewer(adminId),
      secondAdminId,
      false,
    );
    expect(isUserActive(deactivated.user)).toBe(false);
    // The remaining admin is untouched and still active.
    const remaining = await fake.deps.userRepository.findById(adminId);
    expect(remaining !== null && isUserActive(remaining)).toBe(true);
  });

  test("an already-inactive admin can be demoted without tripping the invariant", async () => {
    await seedAdmin(fake, secondAdminId);
    const setActive = createSetUserActiveUseCase(fake.deps);
    await setActive(adminViewer(adminId), secondAdminId, false);

    // Only one *active* admin remains (adminId); demoting the inactive one
    // does not reduce the active-admin count any further.
    const setRole = createSetUserRoleUseCase(fake.deps);
    const demoted = await setRole(
      adminViewer(adminId),
      secondAdminId,
      UserRole.Member,
    );
    expect(demoted.user.role).toBe(UserRole.Member);
  });

  test("reactivating never trips the invariant, even for the only user", async () => {
    const setActive = createSetUserActiveUseCase(fake.deps);
    // Reactivating an already-active admin is a no-op, not a rejection.
    const result = await setActive(adminViewer(adminId), adminId, true);
    expect(isUserActive(result.user)).toBe(true);
  });

  test("setUserRole/setUserActive reject an unknown user id", async () => {
    const setRole = createSetUserRoleUseCase(fake.deps);
    const setActive = createSetUserActiveUseCase(fake.deps);
    const unknown = createUserId("nope");
    await expect(
      setRole(adminViewer(adminId), unknown, UserRole.Member),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setActive(adminViewer(adminId), unknown, false),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("user mail permissions", () => {
  let fake: FakeDependencies;
  const memberId = createUserId("usr-member-1");

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
    await fake.deps.userRepository.save(
      createUser({
        id: memberId,
        email: createEmailAddress("member@example.com"),
        name: "Member",
        role: UserRole.Member,
        createdAt: NOW,
      }),
    );
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: domainId,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "tok",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  });

  test("an admin adds an ALLOW rule to a MEMBER", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    const permission = await add(adminViewer(adminId), memberId, {
      effect: UserPermissionEffect.Allow,
      domainId,
      addressPattern: "support@example.com",
    });
    expect(permission.userId).toBe(memberId);
    expect(permission.createdByUserId).toBe(adminId);

    const listed =
      await fake.deps.userMailPermissionRepository.listByUserId(memberId);
    expect(listed).toEqual([permission]);
  });

  test("an admin may add a mailbox DENY to itself without tripping any invariant", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    const permission = await add(adminViewer(adminId), adminId, {
      effect: UserPermissionEffect.Deny,
      domainId,
      addressPattern: "*",
    });
    expect(permission.userId).toBe(adminId);
    // The admin remains a fully active admin; only its mailbox reach
    // narrowed, not its administrative authority.
    const admin = await fake.deps.userRepository.findById(adminId);
    expect(admin?.role).toBe(UserRole.Admin);
    expect(admin !== null && isUserActive(admin)).toBe(true);
  });

  test("rejects an unknown target user", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    await expect(
      add(adminViewer(adminId), createUserId("nope"), {
        effect: UserPermissionEffect.Allow,
        domainId,
        addressPattern: "*",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects an unknown domain", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    await expect(
      add(adminViewer(adminId), memberId, {
        effect: UserPermissionEffect.Allow,
        domainId: createDomainId("nope"),
        addressPattern: "*",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects a malformed address pattern", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    await expect(
      add(adminViewer(adminId), memberId, {
        effect: UserPermissionEffect.Allow,
        domainId,
        addressPattern: "a*b*c@example.com",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("a non-admin cannot add or remove a mail permission", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    await expect(
      add(memberViewer(), memberId, {
        effect: UserPermissionEffect.Allow,
        domainId,
        addressPattern: "*",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const remove = createRemoveUserMailPermissionUseCase(fake.deps);
    const keyAdmin = apiKeyViewer([{ capability: Capability.KeyAdmin }]);
    await expect(
      remove(keyAdmin, createUserMailPermissionId("ump-nope")),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("removes an existing rule and rejects an unknown one", async () => {
    const add = createAddUserMailPermissionUseCase(fake.deps);
    const permission = await add(adminViewer(adminId), memberId, {
      effect: UserPermissionEffect.Allow,
      domainId,
      addressPattern: "support@example.com",
    });

    const remove = createRemoveUserMailPermissionUseCase(fake.deps);
    await expect(remove(adminViewer(adminId), permission.id)).resolves.toBe(
      true,
    );
    expect(
      await fake.deps.userMailPermissionRepository.findById(permission.id),
    ).toBeNull();

    await expect(
      remove(adminViewer(adminId), permission.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
