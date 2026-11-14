import { ValidationError } from "../errors";

/** The RFC 5545 `RRULE` subset mailcal represents faithfully. Anything
 * outside it (`SECONDLY`, `BYSETPOS`, `BYWEEKNO`, `BYHOUR`, negative
 * `BYMONTHDAY`, ...) makes {@link parseRecurrenceRule} return `null` rather
 * than silently approximating: an approximated series would be pushed back
 * to a CalDAV server as a *different* rule, quietly rewriting the user's
 * calendar on another device. */
export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export const WEEKDAYS: readonly Weekday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];

const FREQUENCIES: readonly RecurrenceFrequency[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

export interface RecurrenceRule {
  readonly freq: RecurrenceFrequency;
  /** `>= 1`; `1` is RFC 5545's default and is always materialized here. */
  readonly interval: number;
  /** Total number of occurrences, mutually exclusive with `untilUtc`. */
  readonly count?: number;
  /** Inclusive upper bound as epoch milliseconds (UTC). */
  readonly untilUtc?: number;
  readonly byDay?: readonly Weekday[];
  /** 1..31 only; negative month days are outside the supported subset. */
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
  /** Defaults to `MO`, as RFC 5545 does. */
  readonly weekStart: Weekday;
}

export interface RecurrenceRuleInput {
  readonly freq: RecurrenceFrequency;
  readonly interval?: number;
  readonly count?: number;
  readonly untilUtc?: number;
  readonly byDay?: readonly Weekday[];
  readonly byMonthDay?: readonly number[];
  readonly byMonth?: readonly number[];
  readonly weekStart?: Weekday;
}

function isFrequency(value: string): value is RecurrenceFrequency {
  return (FREQUENCIES as readonly string[]).includes(value);
}

function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

function uniqueSorted(
  values: readonly number[],
  order: readonly number[] | null,
): readonly number[] {
  const seen = new Set(values);
  const result = [...seen];
  if (order === null) {
    result.sort((a, b) => a - b);
    return result;
  }
  result.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return result;
}

function uniqueWeekdays(values: readonly Weekday[]): readonly Weekday[] {
  const seen = new Set(values);
  return WEEKDAYS.filter((day) => seen.has(day));
}

/** Smart constructor; throws `ValidationError` on anything outside the
 * supported subset. Callers that must tolerate foreign input (ICS import)
 * use {@link parseRecurrenceRule} instead. */
export function createRecurrenceRule(
  input: RecurrenceRuleInput,
): RecurrenceRule {
  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new ValidationError(
      "recurrence interval must be an integer >= 1",
      "interval",
    );
  }
  if (input.count !== undefined && input.untilUtc !== undefined) {
    throw new ValidationError(
      "recurrence count and until are mutually exclusive",
      "count",
    );
  }
  if (
    input.count !== undefined &&
    (!Number.isInteger(input.count) || input.count < 1)
  ) {
    throw new ValidationError(
      "recurrence count must be an integer >= 1",
      "count",
    );
  }
  if (input.untilUtc !== undefined && !Number.isFinite(input.untilUtc)) {
    throw new ValidationError(
      "recurrence until must be a valid timestamp",
      "untilUtc",
    );
  }
  if (input.byMonthDay !== undefined) {
    for (const day of input.byMonthDay) {
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new ValidationError(
          "recurrence byMonthDay entries must be integers between 1 and 31",
          "byMonthDay",
        );
      }
    }
  }
  if (input.byMonth !== undefined) {
    for (const month of input.byMonth) {
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new ValidationError(
          "recurrence byMonth entries must be integers between 1 and 12",
          "byMonth",
        );
      }
    }
  }

  return {
    freq: input.freq,
    interval,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.untilUtc === undefined ? {} : { untilUtc: input.untilUtc }),
    ...(input.byDay === undefined || input.byDay.length === 0
      ? {}
      : { byDay: uniqueWeekdays(input.byDay) }),
    ...(input.byMonthDay === undefined || input.byMonthDay.length === 0
      ? {}
      : { byMonthDay: uniqueSorted(input.byMonthDay, null) }),
    ...(input.byMonth === undefined || input.byMonth.length === 0
      ? {}
      : { byMonth: uniqueSorted(input.byMonth, null) }),
    weekStart: input.weekStart ?? "MO",
  };
}

/** `19970714T173000Z` / `19970714` -> epoch ms, or `null`. RFC 5545 allows
 * a floating (zone-less) `UNTIL`, which is read as UTC here: the value only
 * ever bounds an already-generated occurrence list, so a few hours of skew
 * cannot create or drop an occurrence that a correct reading would not. */
export function parseIcsDateTime(value: string): number | null {
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
  if (utc !== null) {
    return Date.UTC(
      Number(utc[1]),
      Number(utc[2]) - 1,
      Number(utc[3]),
      Number(utc[4]),
      Number(utc[5]),
      Number(utc[6]),
    );
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date !== null) {
    return Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  }
  return null;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Epoch ms -> RFC 5545 UTC date-time (`19970714T173000Z`). */
export function formatIcsUtcDateTime(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}` +
    `${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`
  );
}

function parseNumberList(raw: string): readonly number[] | null {
  const parts = raw.split(",");
  const values: number[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      return null;
    }
    values.push(Number(trimmed));
  }
  return values.length === 0 ? null : values;
}

/** Parses an RFC 5545 `RRULE` value (with or without the `RRULE:` prefix).
 *
 * Returns `null` -- never a partial rule -- when the text uses any part
 * outside the supported subset, so an importer can fall back to storing the
 * event as non-recurring and flag it rather than misrepresenting it. */
export function parseRecurrenceRule(rrule: string): RecurrenceRule | null {
  const body = rrule.trim().replace(/^RRULE:/i, "");
  if (body.length === 0) {
    return null;
  }

  let freq: RecurrenceFrequency | null = null;
  let interval = 1;
  let count: number | undefined;
  let untilUtc: number | undefined;
  let byDay: readonly Weekday[] | undefined;
  let byMonthDay: readonly number[] | undefined;
  let byMonth: readonly number[] | undefined;
  let weekStart: Weekday = "MO";

  for (const part of body.split(";")) {
    if (part.trim().length === 0) {
      continue;
    }
    const separator = part.indexOf("=");
    if (separator === -1) {
      return null;
    }
    const name = part.slice(0, separator).trim().toUpperCase();
    const value = part.slice(separator + 1).trim();
    switch (name) {
      case "FREQ": {
        const upper = value.toUpperCase();
        if (!isFrequency(upper)) {
          return null;
        }
        freq = upper;
        break;
      }
      case "INTERVAL": {
        if (!/^\d+$/.test(value)) {
          return null;
        }
        interval = Number(value);
        if (interval < 1) {
          return null;
        }
        break;
      }
      case "COUNT": {
        if (!/^\d+$/.test(value)) {
          return null;
        }
        count = Number(value);
        if (count < 1) {
          return null;
        }
        break;
      }
      case "UNTIL": {
        const parsed = parseIcsDateTime(value);
        if (parsed === null) {
          return null;
        }
        untilUtc = parsed;
        break;
      }
      case "BYDAY": {
        const days: Weekday[] = [];
        for (const entry of value.split(",")) {
          const upper = entry.trim().toUpperCase();
          // `-1SU` / `2MO` (an ordinal weekday) is outside the subset.
          if (!isWeekday(upper)) {
            return null;
          }
          days.push(upper);
        }
        if (days.length === 0) {
          return null;
        }
        byDay = days;
        break;
      }
      case "BYMONTHDAY": {
        const values = parseNumberList(value);
        if (values === null || values.some((day) => day < 1 || day > 31)) {
          return null;
        }
        byMonthDay = values;
        break;
      }
      case "BYMONTH": {
        const values = parseNumberList(value);
        if (
          values === null ||
          values.some((month) => month < 1 || month > 12)
        ) {
          return null;
        }
        byMonth = values;
        break;
      }
      case "WKST": {
        const upper = value.toUpperCase();
        if (!isWeekday(upper)) {
          return null;
        }
        weekStart = upper;
        break;
      }
      default:
        // Any other part (BYSETPOS, BYWEEKNO, BYHOUR, BYMINUTE, ...) is
        // outside the subset. See the type doc for why this is fatal.
        return null;
    }
  }

  if (freq === null || (count !== undefined && untilUtc !== undefined)) {
    return null;
  }

  try {
    return createRecurrenceRule({
      freq,
      interval,
      ...(count === undefined ? {} : { count }),
      ...(untilUtc === undefined ? {} : { untilUtc }),
      ...(byDay === undefined ? {} : { byDay }),
      ...(byMonthDay === undefined ? {} : { byMonthDay }),
      ...(byMonth === undefined ? {} : { byMonth }),
      weekStart,
    });
  } catch {
    return null;
  }
}

/** Serializes back to RFC 5545 `RRULE` text (no `RRULE:` prefix). Part
 * order is fixed so `parse -> format` is stable and diffable. */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) {
    parts.push(`INTERVAL=${rule.interval}`);
  }
  if (rule.count !== undefined) {
    parts.push(`COUNT=${rule.count}`);
  }
  if (rule.untilUtc !== undefined) {
    parts.push(`UNTIL=${formatIcsUtcDateTime(rule.untilUtc)}`);
  }
  // Part order follows RFC 5545's own listing (coarsest selector first), so
  // `parse -> format` output is stable and diffable against what other
  // clients emit.
  if (rule.byMonth !== undefined && rule.byMonth.length > 0) {
    parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  }
  if (rule.byMonthDay !== undefined && rule.byMonthDay.length > 0) {
    parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  }
  if (rule.byDay !== undefined && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.join(",")}`);
  }
  if (rule.weekStart !== "MO") {
    parts.push(`WKST=${rule.weekStart}`);
  }
  return parts.join(";");
}
