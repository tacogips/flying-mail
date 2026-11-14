import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type CalendarCapability,
  Capability,
} from "@mailcal/domain/entities/api-key";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createUserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import {
  createUserCalendarPermissionId,
  createUserId,
  type UserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMigratedDatabase, seedUser } from "./test-support";
import { createUserCalendarPermissionRepository } from "./user-calendar-permission-repository";

const TS = "2026-08-23T00:00:00.000Z";
const GRANTEE = createUserId("usr-grantee");
const OWNER = createUserId("usr-owner");

describe("user calendar permission repository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createUserCalendarPermissionRepository>;

  const rule = (
    id: string,
    capability: CalendarCapability = Capability.CalendarRead,
    effect = UserPermissionEffect.Allow,
    ownerUserId: UserId | null = OWNER,
  ) =>
    createUserCalendarPermission({
      id: createUserCalendarPermissionId(id),
      userId: GRANTEE,
      capability,
      effect,
      ownerUserId,
      createdByUserId: GRANTEE,
      createdAt: TS,
    });

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedUser(db, { id: GRANTEE, email: "grantee@example.com" });
    await seedUser(db, { id: OWNER, email: "owner@example.com" });
    repository = createUserCalendarPermissionRepository(db);
  });

  test("round-trips an owner-scoped rule", async () => {
    const stored = rule("rule-1");
    await repository.save(stored);
    expect(await repository.findById(stored.id)).toEqual(stored);
  });

  test("round-trips an all-owners rule", async () => {
    const stored = rule(
      "rule-1",
      Capability.CalendarRead,
      UserPermissionEffect.Deny,
      null,
    );
    await repository.save(stored);
    expect(await repository.findById(stored.id)).toEqual(stored);
  });

  test("re-saving the same target replaces the effect", async () => {
    await repository.save(rule("rule-1"));
    await repository.save(
      rule("rule-1", Capability.CalendarRead, UserPermissionEffect.Deny),
    );
    const listed = await repository.listByUserId(GRANTEE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.effect).toBe(UserPermissionEffect.Deny);
  });

  test("an all-owners rule cannot stack on itself", async () => {
    // SQLite treats distinct NULLs as unequal, so the unique index has to
    // normalize them -- otherwise this second row would be accepted and the
    // pair's outcome would depend on evaluation order.
    await repository.save(
      rule("rule-1", Capability.CalendarRead, UserPermissionEffect.Allow, null),
    );
    await repository.save(
      rule("rule-2", Capability.CalendarRead, UserPermissionEffect.Deny, null),
    );
    const listed = await repository.listByUserId(GRANTEE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.effect).toBe(UserPermissionEffect.Deny);
  });

  test("keeps an all-owners rule separate from an owner-scoped one", async () => {
    await repository.save(
      rule("rule-1", Capability.CalendarRead, UserPermissionEffect.Allow, null),
    );
    await repository.save(
      rule("rule-2", Capability.CalendarRead, UserPermissionEffect.Deny, OWNER),
    );
    expect(await repository.listByUserId(GRANTEE)).toHaveLength(2);
  });

  test("keeps read and write rules separate", async () => {
    await repository.save(rule("rule-1", Capability.CalendarRead));
    await repository.save(rule("rule-2", Capability.CalendarWrite));
    expect(await repository.listByUserId(GRANTEE)).toHaveLength(2);
  });

  test("finds by target, distinguishing all-owners from owner-scoped", async () => {
    await repository.save(
      rule(
        "rule-1",
        Capability.CalendarRead,
        UserPermissionEffect.Allow,
        OWNER,
      ),
    );
    expect(
      await repository.findByTarget(GRANTEE, Capability.CalendarRead, OWNER),
    ).not.toBeNull();
    expect(
      await repository.findByTarget(GRANTEE, Capability.CalendarRead, null),
    ).toBeNull();
    expect(
      await repository.findByTarget(GRANTEE, Capability.CalendarWrite, OWNER),
    ).toBeNull();
  });

  test("groups a multi-user lookup, including users with no rules", async () => {
    const other = createUserId("usr-other");
    await seedUser(db, { id: other, email: "other@example.com" });
    await repository.save(rule("rule-1"));
    const grouped = await repository.listByUserIds([GRANTEE, other]);
    expect(grouped.get(GRANTEE)).toHaveLength(1);
    expect(grouped.get(other)).toEqual([]);
  });

  test("cascades when the grantee is deleted", async () => {
    await repository.save(rule("rule-1"));
    await db.execute("DELETE FROM users WHERE id = ?", [GRANTEE]);
    expect(await repository.listByUserId(GRANTEE)).toEqual([]);
  });

  test("cascades when the named owner is deleted", async () => {
    // Otherwise a recycled user id would silently inherit somebody else's
    // grants.
    await repository.save(rule("rule-1"));
    await db.execute("DELETE FROM users WHERE id = ?", [OWNER]);
    expect(await repository.listByUserId(GRANTEE)).toEqual([]);
  });

  test("rejects a non-calendar capability", async () => {
    await expect(
      db.execute(
        `INSERT INTO user_calendar_permissions
           (id, user_id, capability, effect, created_by_user_id, created_at)
         VALUES ('bad', ?, 'MAIL_READ', 'ALLOW', ?, ?)`,
        [GRANTEE, GRANTEE, TS],
      ),
    ).rejects.toThrow();
  });
});
