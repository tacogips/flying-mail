import {
  type Calendar,
  createCalendar,
  updateCalendar,
} from "@mailcal/domain/entities/calendar";
import { UserRole } from "@mailcal/domain/entities/user";
import {
  type CalendarId,
  createCalendarId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import { requireUserViewer } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  createCalendarAccessContext,
  listReadableCalendars,
  loadReadableCalendar,
  loadWritableCalendar,
} from "./calendar-access";
import { translateDomainError } from "./translate-domain-error";

export interface CreateCalendarInput {
  readonly name: string;
  readonly color?: string | null;
  readonly description?: string | null;
  /** Admin-only: create the calendar on behalf of another user. Defaults to
   * the calling user. */
  readonly ownerUserId?: string;
}

export interface UpdateCalendarUseCaseInput {
  readonly name?: string;
  readonly color?: string | null;
  readonly description?: string | null;
}

export function createListCalendarsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly Calendar[]> {
  return (viewer) => listReadableCalendars(deps, viewer);
}

export function createGetCalendarUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CalendarId) => Promise<Calendar | null> {
  return (viewer, id) => loadReadableCalendar(deps, viewer, id);
}

/** An API key cannot create a calendar out of nothing: a calendar needs an
 * owner, and a key inherits no user identity (unchanged doctrine). It can
 * still write to calendars its scopes cover. */
export function createCreateCalendarUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateCalendarInput) => Promise<Calendar> {
  return async (viewer, input) => {
    const user = requireUserViewer(
      viewer,
      "A calendar can only be created by a signed-in user",
    );
    const targetOwner = input.ownerUserId ?? (user.userId as string);
    if (targetOwner !== user.userId && user.role !== UserRole.Admin) {
      throw new BadUserInputError(
        "Only an admin may create a calendar for another user",
        "ownerUserId",
      );
    }
    const owner = await deps.userRepository.findById(createUserId(targetOwner));
    if (owner === null) {
      throw new NotFoundError("User", targetOwner);
    }

    const now = deps.clock.now().toISOString();
    try {
      const calendar = createCalendar({
        id: createCalendarId(deps.random.uuid()),
        ownerUserId: owner.id,
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        createdAt: now,
      });
      await deps.calendarRepository.save(calendar);
      return calendar;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createUpdateCalendarUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: CalendarId,
  input: UpdateCalendarUseCaseInput,
) => Promise<Calendar> {
  return async (viewer, id, input) => {
    const context = createCalendarAccessContext();
    const calendar = await loadWritableCalendar(deps, viewer, id, context);
    const now = deps.clock.now().toISOString();
    try {
      const updated = updateCalendar(
        calendar,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
        },
        now,
      );
      await deps.calendarRepository.save(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

/** Hard delete. Events, mentions, links, attachment claims and CalDAV link
 * rows all cascade in D1; the CalDAV *remote* collection is untouched --
 * unlinking is not a remote delete, deliberately. */
export function createDeleteCalendarUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CalendarId) => Promise<boolean> {
  return async (viewer, id) => {
    await loadWritableCalendar(deps, viewer, id);
    await deps.calendarRepository.delete(id);
    return true;
  };
}
