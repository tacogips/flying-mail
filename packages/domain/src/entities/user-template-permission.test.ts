import { describe, expect, it } from "vitest";
import {
  createUserId,
  createUserTemplatePermissionId,
} from "../value-objects/ids";
import { Capability, TEMPLATE_CAPABILITIES } from "./api-key";
import { UserRole } from "./user";
import { UserPermissionEffect } from "./user-mail-permission";
import {
  createUserTemplatePermission,
  resolveUserTemplateCapability,
  roleGrantsTemplateCapability,
  type UserTemplatePermission,
} from "./user-template-permission";

const USER = createUserId("user-1");
const ADMIN = createUserId("admin-1");

function rule(
  capability: UserTemplatePermission["capability"],
  effect: UserPermissionEffect,
): UserTemplatePermission {
  return createUserTemplatePermission({
    id: createUserTemplatePermissionId(`${capability}-${effect}`),
    userId: USER,
    capability,
    effect,
    createdByUserId: ADMIN,
    createdAt: "2026-08-24T00:00:00.000Z",
  });
}

describe("roleGrantsTemplateCapability", () => {
  it("lets every role read the catalogue", () => {
    for (const role of [UserRole.Admin, UserRole.Member, UserRole.Viewer]) {
      expect(roleGrantsTemplateCapability(role, Capability.TemplateRead)).toBe(
        true,
      );
    }
  });

  it("closes the three mutating capabilities to everyone but an admin", () => {
    const mutating = [
      Capability.TemplateCreate,
      Capability.TemplateUpdate,
      Capability.TemplateDelete,
    ] as const;
    for (const capability of mutating) {
      expect(roleGrantsTemplateCapability(UserRole.Admin, capability)).toBe(
        true,
      );
      expect(roleGrantsTemplateCapability(UserRole.Member, capability)).toBe(
        false,
      );
      expect(roleGrantsTemplateCapability(UserRole.Viewer, capability)).toBe(
        false,
      );
    }
  });
});

describe("resolveUserTemplateCapability", () => {
  it("falls back to the role default with no rules", () => {
    expect(
      resolveUserTemplateCapability(
        UserRole.Member,
        [],
        Capability.TemplateCreate,
      ),
    ).toBe(false);
  });

  it("grants a member a capability its role would not give it", () => {
    expect(
      resolveUserTemplateCapability(
        UserRole.Member,
        [rule(Capability.TemplateCreate, UserPermissionEffect.Allow)],
        Capability.TemplateCreate,
      ),
    ).toBe(true);
  });

  it("does not let one grant leak into another capability", () => {
    const rules = [rule(Capability.TemplateCreate, UserPermissionEffect.Allow)];
    expect(
      resolveUserTemplateCapability(
        UserRole.Member,
        rules,
        Capability.TemplateDelete,
      ),
    ).toBe(false);
  });

  it("lets an admin revoke its own default with a deny", () => {
    expect(
      resolveUserTemplateCapability(
        UserRole.Admin,
        [rule(Capability.TemplateDelete, UserPermissionEffect.Deny)],
        Capability.TemplateDelete,
      ),
    ).toBe(false);
  });

  it("lets a deny beat an overlapping allow", () => {
    expect(
      resolveUserTemplateCapability(
        UserRole.Member,
        [
          rule(Capability.TemplateUpdate, UserPermissionEffect.Allow),
          rule(Capability.TemplateUpdate, UserPermissionEffect.Deny),
        ],
        Capability.TemplateUpdate,
      ),
    ).toBe(false);
  });

  it("can deny a viewer even read access", () => {
    expect(
      resolveUserTemplateCapability(
        UserRole.Viewer,
        [rule(Capability.TemplateRead, UserPermissionEffect.Deny)],
        Capability.TemplateRead,
      ),
    ).toBe(false);
  });

  it("covers every declared template capability", () => {
    for (const capability of TEMPLATE_CAPABILITIES) {
      expect(
        resolveUserTemplateCapability(UserRole.Admin, [], capability),
      ).toBe(true);
    }
  });
});
