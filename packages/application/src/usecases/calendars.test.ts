import { Capability } from "@mailcal/domain/entities/api-key";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createCalendarId } from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import {
  CALENDAR_ID,
  calendarKeyViewer,
  type CalendarFixture,
  mailOnlyKeyViewer,
  NOW,
  OTHER_EMAIL,
  OWNER_ID,
  seedCalendarFixture,
} from "../test-support/calendar-fixtures";
import { createFakeDependencies } from "../test-support/fakes";
import { buildCalendarPermissions } from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

/** The calendar authorization matrix, exercised through the use cases
 * rather than the policy functions directly: what matters is that a denied
 * read surfaces as NOT_FOUND and a denied write as the right error, not
 * merely that the predicate returned false. */

let usecases: UseCases;
let fixture: CalendarFixture;

beforeEach(async () => {
  const fake = createFakeDependencies({ now: NOW });
  usecases = createUseCases(fake.deps);
  fixture = await seedCalendarFixture(fake);
});

describe("calendar reads", () => {
  test("the owner reads its own calendar", async () => {
    expect(
      (await usecases.getCalendar(fixture.ownerViewer, CALENDAR_ID))?.name,
    ).toBe("Work");
    expect(await usecases.listCalendars(fixture.ownerViewer)).toHaveLength(1);
  });

  test("an ADMIN reads every calendar", async () => {
    expect(
      await usecases.getCalendar(fixture.adminViewer, CALENDAR_ID),
    ).not.toBeNull();
    expect(await usecases.listCalendars(fixture.adminViewer)).toHaveLength(1);
  });

  test("a bystander gets NOT_FOUND, never FORBIDDEN", async () => {
    expect(
      await usecases.getCalendar(fixture.otherViewer, CALENDAR_ID),
    ).toBeNull();
    expect(await usecases.listCalendars(fixture.otherViewer)).toEqual([]);
    await expect(
      usecases.updateCalendar(fixture.otherViewer, CALENDAR_ID, {
        name: "Stolen",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a VIEWER-role user reads but cannot write its own calendar", async () => {
    expect(
      await usecases.getCalendar(fixture.viewerRoleViewer, CALENDAR_ID),
    ).not.toBeNull();
    await expect(
      usecases.updateCalendar(fixture.viewerRoleViewer, CALENDAR_ID, {
        name: "Renamed",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a CALENDAR_READ-scoped key reads the matching owner's calendars", async () => {
    const key = calendarKeyViewer([Capability.CalendarRead]);
    expect(await usecases.listCalendars(key)).toHaveLength(1);
    await expect(
      usecases.updateCalendar(key, CALENDAR_ID, { name: "Agent" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a key scoped to a different owner sees nothing", async () => {
    const key = calendarKeyViewer([Capability.CalendarRead], OTHER_EMAIL);
    expect(await usecases.listCalendars(key)).toEqual([]);
    expect(await usecases.getCalendar(key, CALENDAR_ID)).toBeNull();
  });

  test("a mail-only key sees no calendar at all", async () => {
    const key = mailOnlyKeyViewer();
    expect(await usecases.listCalendars(key)).toEqual([]);
    expect(await usecases.getCalendar(key, CALENDAR_ID)).toBeNull();
  });

  test("an unknown calendar is NOT_FOUND for its own owner too", async () => {
    expect(
      await usecases.getCalendar(
        fixture.ownerViewer,
        createCalendarId("cal-missing"),
      ),
    ).toBeNull();
  });
});

describe("per-user calendar rules", () => {
  test("ALLOW extends read to another owner's calendars", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const local = createUseCases(fake.deps);
    const seeded = await seedCalendarFixture(fake);
    const allowed = {
      ...seeded.otherViewer,
      calendarPermissions: buildCalendarPermissions(
        seeded.otherViewer.kind === "USER"
          ? seeded.otherViewer.userId
          : OWNER_ID,
        [
          {
            capability: Capability.CalendarRead,
            effect: UserPermissionEffect.Allow,
            ownerUserId: OWNER_ID,
          },
        ],
      ),
    };
    expect(await local.getCalendar(allowed, CALENDAR_ID)).not.toBeNull();
    // The ALLOW named only CALENDAR_READ, so writing is still refused.
    await expect(
      local.updateCalendar(allowed, CALENDAR_ID, { name: "Nope" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("DENY beats ownership", async () => {
    const denied = {
      ...fixture.ownerViewer,
      calendarPermissions: buildCalendarPermissions(OWNER_ID, [
        {
          capability: Capability.CalendarRead,
          effect: UserPermissionEffect.Deny,
          ownerUserId: null,
        },
      ]),
    };
    expect(await usecases.getCalendar(denied, CALENDAR_ID)).toBeNull();
  });

  test("DENY beats an ADMIN's default access", async () => {
    const denied = {
      ...fixture.adminViewer,
      calendarPermissions: buildCalendarPermissions(
        fixture.adminViewer.kind === "USER"
          ? fixture.adminViewer.userId
          : OWNER_ID,
        [
          {
            capability: Capability.CalendarRead,
            effect: UserPermissionEffect.Deny,
            ownerUserId: OWNER_ID,
          },
          {
            capability: Capability.CalendarWrite,
            effect: UserPermissionEffect.Deny,
            ownerUserId: OWNER_ID,
          },
        ],
      ),
    };
    expect(await usecases.getCalendar(denied, CALENDAR_ID)).toBeNull();
    await expect(
      usecases.updateCalendar(denied, CALENDAR_ID, { name: "Admin edit" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a VIEWER can never be ALLOWed calendar write", async () => {
    const allowedViewer = {
      ...fixture.viewerRoleViewer,
      calendarPermissions: buildCalendarPermissions(OWNER_ID, [
        {
          capability: Capability.CalendarWrite,
          effect: UserPermissionEffect.Allow,
          ownerUserId: null,
        },
      ]),
    };
    await expect(
      usecases.updateCalendar(allowedViewer, CALENDAR_ID, { name: "Nope" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("calendar writes", () => {
  test("creates, updates and deletes a calendar", async () => {
    const created = await usecases.createCalendar(fixture.ownerViewer, {
      name: "Personal",
      color: "#FF0000",
    });
    expect(created).toMatchObject({
      name: "Personal",
      color: "#ff0000",
      ownerUserId: OWNER_ID,
    });

    const updated = await usecases.updateCalendar(
      fixture.ownerViewer,
      created.id,
      { description: "Mine" },
    );
    expect(updated.description).toBe("Mine");
    expect(updated.name).toBe("Personal");

    expect(await usecases.deleteCalendar(fixture.ownerViewer, created.id)).toBe(
      true,
    );
    expect(
      await usecases.getCalendar(fixture.ownerViewer, created.id),
    ).toBeNull();
  });

  test("only an ADMIN may create a calendar for someone else", async () => {
    await expect(
      usecases.createCalendar(fixture.ownerViewer, {
        name: "Theirs",
        ownerUserId: "usr-other",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);

    const created = await usecases.createCalendar(fixture.adminViewer, {
      name: "Theirs",
      ownerUserId: "usr-other",
    });
    expect(created.ownerUserId).toBe("usr-other");
  });

  test("an API key cannot create a calendar: it has no user to own it", async () => {
    await expect(
      usecases.createCalendar(calendarKeyViewer([Capability.CalendarWrite]), {
        name: "Agent",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
