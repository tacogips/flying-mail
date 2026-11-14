import { describe, expect, it } from "vitest";
import {
  createUserCalendarPermissionId,
  createUserId,
  type UserId,
} from "../value-objects/ids";
import { Capability } from "./api-key";
import { UserRole } from "./user";
import { UserPermissionEffect } from "./user-mail-permission";
import {
  createUserCalendarPermission,
  resolveUserCalendarCapability,
  roleGrantsCalendarCapability,
  type UserCalendarPermission,
} from "./user-calendar-permission";

const SELF = createUserId("usr-self");
const OTHER = createUserId("usr-other");
const ADMIN_ID = createUserId("usr-admin");

let ruleCounter = 0;

function rule(
  capability: UserCalendarPermission["capability"],
  effect: UserPermissionEffect,
  ownerUserId: UserId | null,
): UserCalendarPermission {
  ruleCounter += 1;
  return createUserCalendarPermission({
    id: createUserCalendarPermissionId(`ucp-${ruleCounter}`),
    userId: SELF,
    capability,
    effect,
    ownerUserId,
    createdByUserId: ADMIN_ID,
    createdAt: "2026-08-24T00:00:00.000Z",
  });
}

function viewer(
  role: UserRole,
  calendarPermissions: readonly UserCalendarPermission[] = [],
) {
  return { userId: SELF, role, calendarPermissions };
}

describe("roleGrantsCalendarCapability", () => {
  it("lets every role read", () => {
    for (const role of [UserRole.Admin, UserRole.Member, UserRole.Viewer]) {
      expect(roleGrantsCalendarCapability(role, Capability.CalendarRead)).toBe(
        true,
      );
    }
  });

  it("never lets a VIEWER write", () => {
    expect(
      roleGrantsCalendarCapability(UserRole.Viewer, Capability.CalendarWrite),
    ).toBe(false);
    expect(
      roleGrantsCalendarCapability(UserRole.Member, Capability.CalendarWrite),
    ).toBe(true);
  });
});

describe("resolveUserCalendarCapability", () => {
  describe("own calendars", () => {
    it("every role reads its own", () => {
      for (const role of [UserRole.Admin, UserRole.Member, UserRole.Viewer]) {
        expect(
          resolveUserCalendarCapability(
            viewer(role),
            Capability.CalendarRead,
            SELF,
          ),
        ).toBe(true);
      }
    });

    it("a VIEWER cannot write even its own, whatever the rules say", () => {
      expect(
        resolveUserCalendarCapability(
          viewer(UserRole.Viewer, [
            rule(Capability.CalendarWrite, UserPermissionEffect.Allow, null),
          ]),
          Capability.CalendarWrite,
          SELF,
        ),
      ).toBe(false);
    });
  });

  describe("other people's calendars", () => {
    it("an admin reaches them by default", () => {
      expect(
        resolveUserCalendarCapability(
          viewer(UserRole.Admin),
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(true);
    });

    it("a member does not", () => {
      expect(
        resolveUserCalendarCapability(
          viewer(UserRole.Member),
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(false);
    });

    it("an ALLOW naming the owner grants a member access", () => {
      expect(
        resolveUserCalendarCapability(
          viewer(UserRole.Member, [
            rule(Capability.CalendarRead, UserPermissionEffect.Allow, OTHER),
          ]),
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(true);
    });

    it("an ALLOW for one owner does not reach another", () => {
      const granted = viewer(UserRole.Member, [
        rule(Capability.CalendarRead, UserPermissionEffect.Allow, OTHER),
      ]);
      expect(
        resolveUserCalendarCapability(
          granted,
          Capability.CalendarRead,
          createUserId("usr-third"),
        ),
      ).toBe(false);
    });

    it("a read grant is not a write grant", () => {
      const granted = viewer(UserRole.Member, [
        rule(Capability.CalendarRead, UserPermissionEffect.Allow, OTHER),
      ]);
      expect(
        resolveUserCalendarCapability(granted, Capability.CalendarWrite, OTHER),
      ).toBe(false);
    });
  });

  describe("an admin restricting itself", () => {
    it("a DENY naming one owner revokes the admin baseline for that owner", () => {
      const restricted = viewer(UserRole.Admin, [
        rule(Capability.CalendarRead, UserPermissionEffect.Deny, OTHER),
      ]);
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(false);
      // Every other owner is untouched: a self-restriction is not a
      // wholesale revocation.
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarRead,
          createUserId("usr-third"),
        ),
      ).toBe(true);
    });

    it("a DENY with no owner revokes every calendar, own included", () => {
      const restricted = viewer(UserRole.Admin, [
        rule(Capability.CalendarRead, UserPermissionEffect.Deny, null),
      ]);
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(false);
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarRead,
          SELF,
        ),
      ).toBe(false);
    });

    it("an admin can keep read while giving up write", () => {
      const restricted = viewer(UserRole.Admin, [
        rule(Capability.CalendarWrite, UserPermissionEffect.Deny, null),
      ]);
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(true);
      expect(
        resolveUserCalendarCapability(
          restricted,
          Capability.CalendarWrite,
          OTHER,
        ),
      ).toBe(false);
    });

    it("a DENY beats an overlapping ALLOW", () => {
      expect(
        resolveUserCalendarCapability(
          viewer(UserRole.Member, [
            rule(Capability.CalendarRead, UserPermissionEffect.Allow, OTHER),
            rule(Capability.CalendarRead, UserPermissionEffect.Deny, null),
          ]),
          Capability.CalendarRead,
          OTHER,
        ),
      ).toBe(false);
    });
  });
});
