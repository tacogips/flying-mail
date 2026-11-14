import { describe, expect, test } from "vitest";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "../value-objects/address-pattern";
import {
  createDomainId,
  createUserId,
  createUserMailPermissionId,
} from "../value-objects/ids";
import {
  createUserMailPermission,
  UserPermissionEffect,
} from "./user-mail-permission";

const createdAt = "2026-08-23T00:00:00.000Z";

describe("createUserMailPermission", () => {
  test.each([UserPermissionEffect.Allow, UserPermissionEffect.Deny])(
    "creates an immutable %s rule for a specific domain",
    (effect) => {
      const permission = createUserMailPermission({
        id: createUserMailPermissionId("ump-1"),
        userId: createUserId("usr-member"),
        effect,
        domainId: createDomainId("dom-1"),
        addressPattern: MATCH_ALL_ADDRESSES,
        createdByUserId: createUserId("usr-admin"),
        createdAt,
      });

      expect(permission).toEqual({
        id: "ump-1",
        userId: "usr-member",
        effect,
        domainId: "dom-1",
        addressPattern: "*",
        createdByUserId: "usr-admin",
        createdAt,
      });
    },
  );

  test("preserves a global exact-address assignment", () => {
    const permission = createUserMailPermission({
      id: createUserMailPermissionId("ump-global"),
      userId: createUserId("usr-viewer"),
      effect: UserPermissionEffect.Allow,
      domainId: null,
      addressPattern: createAddressPattern("support@example.com"),
      createdByUserId: createUserId("usr-admin"),
      createdAt,
    });

    expect(permission.domainId).toBeNull();
    expect(permission.addressPattern).toBe("support@example.com");
  });
});
