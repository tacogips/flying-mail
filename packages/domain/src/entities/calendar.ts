import { ValidationError } from "../errors";
import type { CalendarId, UserId } from "../value-objects/ids";

/** A user-owned container for events. Calendars are hard-deleted (deleting
 * one cascades its events): there is no trash lifecycle here, unlike mail,
 * because a calendar carries no delivery history that an operator might
 * later need to audit. */
export interface Calendar {
  readonly id: CalendarId;
  readonly ownerUserId: UserId;
  readonly name: string;
  /** `#rrggbb`, lower-cased. */
  readonly color: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCalendarInput {
  readonly id: CalendarId;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly color?: string | null;
  readonly description?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export const MAX_CALENDAR_NAME_LENGTH = 120;
export const MAX_CALENDAR_DESCRIPTION_LENGTH = 2000;
export const DEFAULT_CALENDAR_COLOR = "#3b82f6";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Normalizes `#RRGGBB` to lower case, so two calendars that differ only in
 * hex casing are not rendered as different colors by a client that compares
 * strings. */
export function normalizeCalendarColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!COLOR_PATTERN.test(normalized)) {
    throw new ValidationError(
      "calendar color must be a #rrggbb hex value",
      "color",
    );
  }
  return normalized;
}

export function createCalendar(input: CreateCalendarInput): Calendar {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("calendar name must not be empty", "name");
  }
  if (name.length > MAX_CALENDAR_NAME_LENGTH) {
    throw new ValidationError(
      `calendar name must be at most ${MAX_CALENDAR_NAME_LENGTH} characters`,
      "name",
    );
  }
  const description = input.description?.trim() ?? "";
  if (description.length > MAX_CALENDAR_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `calendar description must be at most ${MAX_CALENDAR_DESCRIPTION_LENGTH} characters`,
      "description",
    );
  }
  return {
    id: input.id,
    ownerUserId: input.ownerUserId,
    name,
    color: normalizeCalendarColor(input.color ?? DEFAULT_CALENDAR_COLOR),
    description: description.length === 0 ? null : description,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

export interface UpdateCalendarInput {
  readonly name?: string;
  readonly color?: string | null;
  readonly description?: string | null;
}

/** Applies a partial edit through the same validation the factory uses --
 * an absent field is left untouched, an explicit `null` description clears
 * it. */
export function updateCalendar(
  calendar: Calendar,
  input: UpdateCalendarInput,
  updatedAt: string,
): Calendar {
  return createCalendar({
    id: calendar.id,
    ownerUserId: calendar.ownerUserId,
    name: input.name ?? calendar.name,
    color: input.color ?? calendar.color,
    description:
      input.description === undefined
        ? calendar.description
        : input.description,
    createdAt: calendar.createdAt,
    updatedAt,
  });
}
