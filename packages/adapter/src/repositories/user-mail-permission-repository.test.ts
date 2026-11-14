import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  createUserMailPermission,
  UserPermissionEffect,
} from "@mailcal/domain/entities/user-mail-permission";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import {
  createDomainId,
  createUserId,
  createUserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMigratedDatabase, seedDomain, seedUser } from "./test-support";
import { createUserMailPermissionRepository } from "./user-mail-permission-repository";

const NOW = "2026-08-23T00:00:00.000Z";
const adminId = createUserId("usr-admin");
const memberId = createUserId("usr-member");
const otherUserId = createUserId("usr-other");
const domainId = createDomainId("dom-1");

describe("userMailPermissionRepository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createUserMailPermissionRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedUser(db, { id: adminId, email: "admin@example.com" });
    await seedUser(db, { id: memberId, email: "member@example.com" });
    await seedUser(db, { id: otherUserId, email: "other@example.com" });
    await seedDomain(db, { id: domainId, name: "example.com" });
    repository = createUserMailPermissionRepository(db);
  });

  test("saves, finds, and lists only the requested user's rules", async () => {
    const domainRule = createUserMailPermission({
      id: createUserMailPermissionId("ump-domain"),
      userId: memberId,
      effect: UserPermissionEffect.Allow,
      domainId,
      addressPattern: MATCH_ALL_ADDRESSES,
      createdByUserId: adminId,
      createdAt: NOW,
    });
    const addressRule = createUserMailPermission({
      id: createUserMailPermissionId("ump-address"),
      userId: memberId,
      effect: UserPermissionEffect.Deny,
      domainId: null,
      addressPattern: createAddressPattern("private@example.com"),
      createdByUserId: adminId,
      createdAt: "2026-08-23T00:01:00.000Z",
    });
    const otherRule = createUserMailPermission({
      ...domainRule,
      id: createUserMailPermissionId("ump-other"),
      userId: otherUserId,
    });

    await repository.save(addressRule);
    await repository.save(otherRule);
    await repository.save(domainRule);

    expect(await repository.findById(domainRule.id)).toEqual(domainRule);
    expect(await repository.listByUserId(memberId)).toEqual([
      domainRule,
      addressRule,
    ]);
    expect(
      await repository.findById(createUserMailPermissionId("ump-missing")),
    ).toBeNull();
  });

  test("upserts and deletes a rule by id", async () => {
    const permission = createUserMailPermission({
      id: createUserMailPermissionId("ump-1"),
      userId: memberId,
      effect: UserPermissionEffect.Allow,
      domainId,
      addressPattern: MATCH_ALL_ADDRESSES,
      createdByUserId: adminId,
      createdAt: NOW,
    });
    await repository.save(permission);
    const updated = {
      ...permission,
      effect: UserPermissionEffect.Deny,
      addressPattern: createAddressPattern("blocked@example.com"),
    };
    await repository.save(updated);
    expect(await repository.findById(permission.id)).toEqual(updated);

    await repository.delete(permission.id);
    expect(await repository.findById(permission.id)).toBeNull();
  });
});
