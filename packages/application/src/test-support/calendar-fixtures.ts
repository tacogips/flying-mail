import { Capability } from "@mailcal/domain/entities/api-key";
import { createCalendar } from "@mailcal/domain/entities/calendar";
import { createMailDomain } from "@mailcal/domain/entities/mail-domain";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createCalendarId,
  createDomainId,
  createUserId,
  type CalendarId,
  type DomainId,
  type UserId,
} from "@mailcal/domain/value-objects/ids";
import type { Viewer } from "../policies/viewer";
import type { FakeDependencies } from "./fakes";
import { apiKeyViewer } from "./viewer-fixtures";

/** Shared calendar seeding for use-case and policy tests: one managed
 * domain, an owner, a bystander, an admin, and a calendar owned by the
 * owner. Kept here rather than duplicated per suite so every calendar test
 * agrees on the same fixture. */

export const NOW = "2026-08-24T00:00:00.000Z";
export const DOMAIN_ID: DomainId = createDomainId("dom-1");
export const OWNER_ID: UserId = createUserId("usr-owner");
export const OTHER_ID: UserId = createUserId("usr-other");
export const ADMIN_ID: UserId = createUserId("usr-admin");
export const CALENDAR_ID: CalendarId = createCalendarId("cal-1");
export const OWNER_EMAIL = "owner@example.com";
export const OTHER_EMAIL = "other@example.com";

export interface CalendarFixture {
  readonly ownerViewer: Viewer;
  readonly otherViewer: Viewer;
  readonly adminViewer: Viewer;
  readonly viewerRoleViewer: Viewer;
}

export async function seedCalendarFixture(
  fake: FakeDependencies,
): Promise<CalendarFixture> {
  await fake.deps.mailDomainRepository.save(
    createMailDomain({
      id: DOMAIN_ID,
      name: createDomainName("example.com"),
      catchAll: true,
      verificationToken: "tok",
      createdAt: NOW,
    }),
  );
  for (const [id, email, role] of [
    [OWNER_ID, OWNER_EMAIL, UserRole.Member],
    [OTHER_ID, OTHER_EMAIL, UserRole.Member],
    [ADMIN_ID, "admin@example.com", UserRole.Admin],
  ] as const) {
    await fake.deps.userRepository.save(
      createUser({
        id: id,
        email: createEmailAddress(email),
        name: email,
        role,
        createdAt: NOW,
      }),
    );
  }
  await fake.deps.calendarRepository.save(
    createCalendar({
      id: CALENDAR_ID,
      ownerUserId: OWNER_ID,
      name: "Work",
      createdAt: NOW,
    }),
  );

  return {
    ownerViewer: {
      kind: "USER",
      userId: OWNER_ID,
      role: UserRole.Member,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    },
    otherViewer: {
      kind: "USER",
      userId: OTHER_ID,
      role: UserRole.Member,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    },
    adminViewer: {
      kind: "USER",
      userId: ADMIN_ID,
      role: UserRole.Admin,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    },
    viewerRoleViewer: {
      kind: "USER",
      userId: OWNER_ID,
      role: UserRole.Viewer,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    },
  };
}

/** A key scoped to the owner's account address for the given calendar
 * capabilities. */
export function calendarKeyViewer(
  capabilities: readonly Capability[],
  addressPattern = OWNER_EMAIL,
  domainId: DomainId | null = null,
): Viewer {
  return apiKeyViewer(
    capabilities.map((capability) => ({
      capability,
      domainId,
      addressPattern,
    })),
    "key-calendar",
  );
}

/** A mail-only key: holds no calendar capability at all. */
export function mailOnlyKeyViewer(): Viewer {
  return apiKeyViewer(
    [
      {
        capability: Capability.MailRead,
        domainId: DOMAIN_ID,
        addressPattern: OWNER_EMAIL,
      },
    ],
    "key-mail",
  );
}
