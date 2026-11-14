import { ValidationError } from "../errors";
import type { Brand } from "./ids";

/** A calendar date with no time and no zone (`"2026-03-08"`).
 *
 * All-day events are stored as dates rather than instants on purpose: an
 * all-day event on the 8th is the 8th in whatever zone the reader is in,
 * and converting it to an instant at creation time would move it across a
 * day boundary for anyone else. */
export type IsoDate = Brand<string, "IsoDate">;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): IsoDate | null {
  const match = ISO_DATE_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  // Rejects "2026-02-30", which `Date.UTC` would silently roll forward.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value.trim() as IsoDate;
}

export function createIsoDate(value: string, field = "date"): IsoDate {
  const parsed = parseIsoDate(value);
  if (parsed === null) {
    throw new ValidationError(
      `${field} must be a valid YYYY-MM-DD date`,
      field,
    );
  }
  return parsed;
}

/** Midnight UTC of the date, used only for ordering and range overlap --
 * never presented to a user as an instant. */
export function isoDateToUtcMs(value: IsoDate): number {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    throw new ValidationError(`invalid date: ${value}`, "date");
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function utcMsToIsoDate(epochMs: number): IsoDate {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}` as IsoDate;
}

export function addIsoDateDays(value: IsoDate, days: number): IsoDate {
  return utcMsToIsoDate(isoDateToUtcMs(value) + days * 86_400_000);
}

/** Negative when `left` is earlier. Plain string comparison would work for
 * this format, but going through the numeric form keeps callers honest
 * about what is being compared. */
export function compareIsoDates(left: IsoDate, right: IsoDate): number {
  return isoDateToUtcMs(left) - isoDateToUtcMs(right);
}
