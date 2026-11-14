import { Capability } from "@mailcal/domain/entities/api-key";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createUserCalendarPermissionId,
  createUserId,
  type UserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  authorizesCalendarRead,
  authorizesCalendarWrite,
} from "../policies/authorization";
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
const ADMIN_ID = createUserId("usr-admin");
const MEMBER_ID = createUserId("usr-member");
const OWNER_ID = createUserId("usr-owner");
const ADMIN = adminViewer(ADMIN_ID);

function ownerRef(userId: UserId) {
  return {
    userId,
    email: createEmailAddress(`${userId}@example.com`),
    domainId: null,
  };
}

describe("user calendar permissions", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    usecases = createUseCases(fake.deps);
    for (const id of [ADMIN_ID, MEMBER_ID, OWNER_ID]) {
      await fake.deps.userRepository.save(
        createUser({
          id,
          email: createEmailAddress(`${id}@example.com`),
          name: id,
          role: id === ADMIN_ID ? UserRole.Admin : UserRole.Member,
          createdAt: NOW,
        }),
      );
    }
  });

  /** Rebuilds a viewer with whatever rules are currently stored, the way
   * `resolveViewerFromToken` does on each request. */
  async function reload(
    userId: UserId,
    role: "ADMIN" | "MEMBER",
  ): Promise<ReturnType<typeof adminViewer>> {
    const rules =
      await fake.deps.userCalendarPermissionRepository.listByUserId(userId);
    return role === "ADMIN"
      ? adminViewer(userId, [], [], rules)
      : memberViewer(userId, [], [], rules);
  }

  test("an admin grants a member read on another owner's calendars", async () => {
    await usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Allow,
      ownerUserId: OWNER_ID,
    });
    const member = await reload(MEMBER_ID, "MEMBER");
    expect(authorizesCalendarRead(member, ownerRef(OWNER_ID))).toBe(true);
    // The grant is read-only and owner-scoped.
    expect(authorizesCalendarWrite(member, ownerRef(OWNER_ID))).toBe(false);
    expect(
      authorizesCalendarRead(member, ownerRef(createUserId("usr-third"))),
    ).toBe(false);
  });

  test("an admin can deny itself a calendar it still administers", async () => {
    await usecases.addUserCalendarPermission(ADMIN, ADMIN_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Deny,
      ownerUserId: OWNER_ID,
    });
    const restricted = await reload(ADMIN_ID, "ADMIN");
    expect(authorizesCalendarRead(restricted, ownerRef(OWNER_ID))).toBe(false);

    // The point of the separation: having given up the data, the admin
    // keeps the power to grant that same calendar to somebody else.
    await expect(
      usecases.addUserCalendarPermission(restricted, MEMBER_ID, {
        capability: Capability.CalendarRead,
        effect: UserPermissionEffect.Allow,
        ownerUserId: OWNER_ID,
      }),
    ).resolves.toMatchObject({ effect: UserPermissionEffect.Allow });
    const member = await reload(MEMBER_ID, "MEMBER");
    expect(authorizesCalendarRead(member, ownerRef(OWNER_ID))).toBe(true);
  });

  test("an admin can give up write while keeping read", async () => {
    await usecases.addUserCalendarPermission(ADMIN, ADMIN_ID, {
      capability: Capability.CalendarWrite,
      effect: UserPermissionEffect.Deny,
      ownerUserId: null,
    });
    const restricted = await reload(ADMIN_ID, "ADMIN");
    expect(authorizesCalendarRead(restricted, ownerRef(OWNER_ID))).toBe(true);
    expect(authorizesCalendarWrite(restricted, ownerRef(OWNER_ID))).toBe(false);
  });

  test("removing the rule restores the default", async () => {
    const rule = await usecases.addUserCalendarPermission(ADMIN, ADMIN_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Deny,
      ownerUserId: OWNER_ID,
    });
    expect(
      authorizesCalendarRead(
        await reload(ADMIN_ID, "ADMIN"),
        ownerRef(OWNER_ID),
      ),
    ).toBe(false);

    await expect(
      usecases.removeUserCalendarPermission(ADMIN, rule.id),
    ).resolves.toBe(true);
    expect(
      authorizesCalendarRead(
        await reload(ADMIN_ID, "ADMIN"),
        ownerRef(OWNER_ID),
      ),
    ).toBe(true);
  });

  test("re-issuing a rule for the same target replaces it", async () => {
    const allowed = await usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Allow,
      ownerUserId: OWNER_ID,
    });
    const denied = await usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Deny,
      ownerUserId: OWNER_ID,
    });
    expect(denied.id).toBe(allowed.id);
    await expect(
      usecases.listUserCalendarPermissions(ADMIN, [MEMBER_ID]),
    ).resolves.toEqual(new Map([[MEMBER_ID as string, [denied]]]));
  });

  test("an all-owners rule and an owner-specific rule are separate rows", async () => {
    await usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Allow,
      ownerUserId: null,
    });
    await usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
      capability: Capability.CalendarRead,
      effect: UserPermissionEffect.Deny,
      ownerUserId: OWNER_ID,
    });
    const member = await reload(MEMBER_ID, "MEMBER");
    // Broad allow, one hole punched in it.
    expect(
      authorizesCalendarRead(member, ownerRef(createUserId("usr-third"))),
    ).toBe(true);
    expect(authorizesCalendarRead(member, ownerRef(OWNER_ID))).toBe(false);
  });

  test("reports an unknown grantee or owner", async () => {
    await expect(
      usecases.addUserCalendarPermission(ADMIN, createUserId("ghost"), {
        capability: Capability.CalendarRead,
        effect: UserPermissionEffect.Allow,
        ownerUserId: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      usecases.addUserCalendarPermission(ADMIN, MEMBER_ID, {
        capability: Capability.CalendarRead,
        effect: UserPermissionEffect.Allow,
        ownerUserId: createUserId("ghost"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      usecases.removeUserCalendarPermission(
        ADMIN,
        createUserCalendarPermissionId("missing"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a member cannot grant itself access", async () => {
    await expect(
      usecases.addUserCalendarPermission(memberViewer(MEMBER_ID), MEMBER_ID, {
        capability: Capability.CalendarRead,
        effect: UserPermissionEffect.Allow,
        ownerUserId: OWNER_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an api key cannot manage calendar permissions, whatever it holds", async () => {
    const key = apiKeyViewer([
      { capability: Capability.CalendarRead, domainId: null },
      { capability: Capability.CalendarWrite, domainId: null },
      { capability: Capability.KeyAdmin, domainId: null },
    ]);
    await expect(
      usecases.addUserCalendarPermission(key, MEMBER_ID, {
        capability: Capability.CalendarRead,
        effect: UserPermissionEffect.Allow,
        ownerUserId: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      usecases.listUserCalendarPermissions(key, [MEMBER_ID]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
