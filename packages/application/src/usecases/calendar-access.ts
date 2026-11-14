import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import {
  emailDomainName,
  type EmailAddress,
} from "@mailcal/domain/value-objects/email-address";
import type { CalendarId, UserId } from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  authorizesCalendarRead,
  authorizesCalendarWrite,
  authorizesEventRead,
  type CalendarOwnerRef,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";

/** Shared access resolution for every calendar use case.
 *
 * Authorization decisions live in `policies/authorization.ts`; this module
 * only *feeds* them -- it resolves the owner identity a decision needs
 * (account email plus, when the address is in a managed domain, that
 * domain's id) and turns a denied read into `NOT_FOUND`, preserving the same
 * probe resistance mail has. */

/** Per-call memo. Listing a month of events touches the same handful of
 * owners repeatedly, and each resolution is two repository reads. */
export interface CalendarAccessContext {
  readonly owners: Map<string, CalendarOwnerRef | null>;
  viewerEmail?: EmailAddress | null;
}

export function createCalendarAccessContext(): CalendarAccessContext {
  return { owners: new Map() };
}

export async function resolveCalendarOwner(
  deps: AppDependencies,
  ownerUserId: UserId,
  context: CalendarAccessContext = createCalendarAccessContext(),
): Promise<CalendarOwnerRef | null> {
  const cached = context.owners.get(ownerUserId);
  if (cached !== undefined) {
    return cached;
  }
  const user = await deps.userRepository.findById(ownerUserId);
  if (user === null) {
    context.owners.set(ownerUserId, null);
    return null;
  }
  const domain = await deps.mailDomainRepository.findByName(
    emailDomainName(user.email),
  );
  const owner: CalendarOwnerRef = {
    userId: user.id,
    email: user.email,
    domainId: domain?.id ?? null,
  };
  context.owners.set(ownerUserId, owner);
  return owner;
}

/** The signed-in user's own account address, used for mention visibility.
 * `null` for an API key -- a key is never "mentioned". */
export async function viewerAccountEmail(
  deps: AppDependencies,
  viewer: Viewer,
  context: CalendarAccessContext = createCalendarAccessContext(),
): Promise<EmailAddress | null> {
  if (context.viewerEmail !== undefined) {
    return context.viewerEmail;
  }
  if (viewer.kind !== "USER") {
    context.viewerEmail = null;
    return null;
  }
  const user = await deps.userRepository.findById(viewer.userId);
  const email = user?.email ?? null;
  context.viewerEmail = email;
  return email;
}

export async function canReadCalendar(
  deps: AppDependencies,
  viewer: Viewer,
  calendar: Calendar,
  context?: CalendarAccessContext,
): Promise<boolean> {
  const owner = await resolveCalendarOwner(deps, calendar.ownerUserId, context);
  return owner !== null && authorizesCalendarRead(viewer, owner);
}

/** `null` rather than a thrown error when the viewer may not see it: the
 * caller turns that into `NOT_FOUND`, so an unauthorized read is
 * indistinguishable from a missing calendar. */
export async function loadReadableCalendar(
  deps: AppDependencies,
  viewer: Viewer,
  calendarId: CalendarId,
  context?: CalendarAccessContext,
): Promise<Calendar | null> {
  const calendar = await deps.calendarRepository.findById(calendarId);
  if (calendar === null) {
    return null;
  }
  return (await canReadCalendar(deps, viewer, calendar, context))
    ? calendar
    : null;
}

/** Writes report `NOT_FOUND` when the viewer cannot even read the calendar
 * (nothing is leaked) and `FORBIDDEN` when it can read but not write (the
 * caller already knows the calendar exists, so saying so leaks nothing). */
export async function loadWritableCalendar(
  deps: AppDependencies,
  viewer: Viewer,
  calendarId: CalendarId,
  context?: CalendarAccessContext,
): Promise<Calendar> {
  const calendar = await deps.calendarRepository.findById(calendarId);
  if (calendar === null) {
    throw new NotFoundError("Calendar", calendarId);
  }
  const owner = await resolveCalendarOwner(deps, calendar.ownerUserId, context);
  if (owner === null || !authorizesCalendarRead(viewer, owner)) {
    throw new NotFoundError("Calendar", calendarId);
  }
  if (!authorizesCalendarWrite(viewer, owner)) {
    throw new ForbiddenError(
      "This credential is not permitted to modify this calendar",
    );
  }
  return calendar;
}

/** Every calendar the viewer may read, in one place so listing and range
 * queries cannot drift apart. */
export async function listReadableCalendars(
  deps: AppDependencies,
  viewer: Viewer,
  context: CalendarAccessContext = createCalendarAccessContext(),
): Promise<readonly Calendar[]> {
  const candidates =
    viewer.kind === "USER" && viewer.role !== "ADMIN"
      ? await deps.calendarRepository.listByOwner(viewer.userId)
      : await deps.calendarRepository.listAll();

  const readable: Calendar[] = [];
  for (const calendar of candidates) {
    if (await canReadCalendar(deps, viewer, calendar, context)) {
      readable.push(calendar);
    }
  }
  return readable;
}

/** Read access to one event: calendar read, or a mention of the viewer's own
 * address. Overrides inherit the master's mentions for this decision only
 * when they carry none of their own. */
export async function canReadEvent(
  deps: AppDependencies,
  viewer: Viewer,
  event: CalendarEvent,
  context: CalendarAccessContext = createCalendarAccessContext(),
): Promise<boolean> {
  const calendar = await deps.calendarRepository.findById(event.calendarId);
  if (calendar === null) {
    return false;
  }
  const owner = await resolveCalendarOwner(deps, calendar.ownerUserId, context);
  if (owner === null) {
    return false;
  }
  const email = await viewerAccountEmail(deps, viewer, context);
  return authorizesEventRead(viewer, owner, event.mentions, email);
}

export async function loadReadableEvent(
  deps: AppDependencies,
  viewer: Viewer,
  eventId: CalendarEvent["id"],
  context?: CalendarAccessContext,
): Promise<CalendarEvent | null> {
  const event = await deps.calendarEventRepository.findById(eventId);
  if (event === null) {
    return null;
  }
  return (await canReadEvent(deps, viewer, event, context)) ? event : null;
}

/** Loads an event for mutation. Existence is only admitted to a viewer that
 * can read it. */
export async function loadWritableEvent(
  deps: AppDependencies,
  viewer: Viewer,
  eventId: CalendarEvent["id"],
  context?: CalendarAccessContext,
): Promise<CalendarEvent> {
  const event = await deps.calendarEventRepository.findById(eventId);
  if (event === null) {
    throw new NotFoundError("CalendarEvent", eventId);
  }
  const readable = await canReadEvent(deps, viewer, event, context);
  if (!readable) {
    throw new NotFoundError("CalendarEvent", eventId);
  }
  // Re-checked through the calendar so a mentioned user -- who can read the
  // event but holds no calendar rights -- cannot edit it.
  await loadWritableCalendar(deps, viewer, event.calendarId, context);
  return event;
}
