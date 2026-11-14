import { ValidationError } from "../errors";
import type { Brand } from "./ids";

/** An IANA time-zone identifier (`"Asia/Tokyo"`, `"UTC"`), validated against
 * the runtime's own zone database rather than a hand-maintained list: the
 * only authority that matters is the one recurrence expansion will later
 * ask for offsets. Mirrors `EmailAddress`'s dual-constructor shape. */
export type TimeZoneId = Brand<string, "TimeZoneId">;

/** `Intl.DateTimeFormat` throws `RangeError` for an unknown zone, and also
 * for values that are syntactically fine but not in the database -- which is
 * exactly the distinction we want. Offsets like `"+09:00"` are deliberately
 * rejected: a fixed offset cannot express DST, so accepting one would make
 * a recurring event silently wrong for half the year. */
export function parseTimeZoneId(value: string): TimeZoneId | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Newer runtimes accept `"+09:00"` as an `Intl` time zone. A fixed offset
  // cannot express DST, so a recurring event pinned to one would be
  // silently wrong for half the year -- rejected before `Intl` sees it.
  if (trimmed.startsWith("+") || trimmed.startsWith("-")) {
    return null;
  }
  try {
    // `timeZoneName: "short"` is not needed; construction alone validates.
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    // Intl canonicalizes (`"utc"` -> `"UTC"`), so the resolved value is
    // stored rather than the caller's spelling: two events in the same zone
    // must compare equal as strings.
    return formatter.resolvedOptions().timeZone as TimeZoneId;
  } catch {
    return null;
  }
}

/** {@link parseTimeZoneId}, but throws `ValidationError`. Used on
 * caller-facing paths (event inputs) where a bad zone is a mistake the
 * caller should see. */
export function createTimeZoneId(
  value: string,
  field = "timeZone",
): TimeZoneId {
  const parsed = parseTimeZoneId(value);
  if (parsed === null) {
    throw new ValidationError(
      `${field} is not a valid IANA time zone identifier`,
      field,
    );
  }
  return parsed;
}

export const UTC_TIME_ZONE: TimeZoneId = "UTC" as TimeZoneId;
