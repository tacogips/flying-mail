import { Capability } from "@mailcal/domain/entities/api-key";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createUserId,
  createUserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors";
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
const TARGET = createUserId("usr-target");
const ADMIN = adminViewer();

describe("user template permissions", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    usecases = createUseCases(fake.deps);
    await fake.deps.userRepository.save(
      createUser({
        id: TARGET,
        email: createEmailAddress("member@example.com"),
        name: "Member",
        role: UserRole.Member,
        createdAt: NOW,
      }),
    );
  });

  test("an admin grants a capability to a user", async () => {
    const permission = await usecases.addUserTemplatePermission(ADMIN, TARGET, {
      capability: Capability.TemplateCreate,
      effect: UserPermissionEffect.Allow,
    });
    expect(permission).toMatchObject({
      userId: TARGET,
      capability: Capability.TemplateCreate,
      effect: UserPermissionEffect.Allow,
    });
    await expect(
      usecases.listUserTemplatePermissions(ADMIN, [TARGET]),
    ).resolves.toEqual(new Map([[TARGET as string, [permission]]]));
  });

  test("re-granting the same capability replaces rather than stacks", async () => {
    const allowed = await usecases.addUserTemplatePermission(ADMIN, TARGET, {
      capability: Capability.TemplateUpdate,
      effect: UserPermissionEffect.Allow,
    });
    const denied = await usecases.addUserTemplatePermission(ADMIN, TARGET, {
      capability: Capability.TemplateUpdate,
      effect: UserPermissionEffect.Deny,
    });
    // Same row, flipped effect: a rule list can never hold a contradictory
    // ALLOW/DENY pair whose outcome depends on evaluation order.
    expect(denied.id).toBe(allowed.id);
    expect(fake.templateStores.userTemplatePermissions.size).toBe(1);
    expect(denied.effect).toBe(UserPermissionEffect.Deny);
  });

  test("removing a rule restores the role default", async () => {
    const permission = await usecases.addUserTemplatePermission(ADMIN, TARGET, {
      capability: Capability.TemplateCreate,
      effect: UserPermissionEffect.Allow,
    });
    await expect(
      usecases.removeUserTemplatePermission(ADMIN, permission.id),
    ).resolves.toBe(true);
    expect(fake.templateStores.userTemplatePermissions.size).toBe(0);
  });

  test("removing an unknown rule reports NOT_FOUND", async () => {
    await expect(
      usecases.removeUserTemplatePermission(
        ADMIN,
        createUserTemplatePermissionId("missing"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("granting to an unknown user reports NOT_FOUND", async () => {
    await expect(
      usecases.addUserTemplatePermission(ADMIN, createUserId("ghost"), {
        capability: Capability.TemplateCreate,
        effect: UserPermissionEffect.Allow,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a non-admin user cannot manage template permissions", async () => {
    await expect(
      usecases.addUserTemplatePermission(memberViewer(), TARGET, {
        capability: Capability.TemplateCreate,
        effect: UserPermissionEffect.Allow,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an api key cannot manage template permissions, whatever it holds", async () => {
    const key = apiKeyViewer([
      { capability: Capability.KeyAdmin, domainId: null },
      { capability: Capability.TemplateCreate, domainId: null },
      { capability: Capability.TemplateDelete, domainId: null },
    ]);
    await expect(
      usecases.addUserTemplatePermission(key, TARGET, {
        capability: Capability.TemplateCreate,
        effect: UserPermissionEffect.Allow,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      usecases.listUserTemplatePermissions(key, [TARGET]),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
