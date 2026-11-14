import { ValidationError } from "../errors";
import {
  addIsoDateDays,
  isoDateToUtcMs,
  type IsoDate,
  utcMsToIsoDate,
} from "../value-objects/iso-date";
import type { Weekday } from "../value-objects/recurrence";
import type { TimeZoneId } from "../value-objects/time-zone";
import type {
  CalendarEvent,
  EventTime,
  OccurrenceStart,
} from "./calendar-event";

/** One materialized instance of an event. `startDate`/`endDateExclusive`
 * are present only for all-day events, where they -- not the UTC bounds --
 * are what a client should render. */
export interface Occurrence {
  readonly startUtc: number;
  readonly endUtc: number;
  readonly startDate?: IsoDate;
  readonly endDateExclusive?: IsoDate;
  /** The series-relative identity of this instance, matching what an
   * `EXDATE` entry or a `RECURRENCE-ID` would carry. */
  readonly occurrenceStart: OccurrenceStart;
}

export interface ExpansionResult {
  readonly occurrences: readonly Occurrence[];
  /** True when {@link MAX_OCCURRENCES_PER_EVENT} cut the list short. Surfaced
   * all the way to the GraphQL result so a client knows its view is
   * incomplete rather than silently believing an empty tail. */
  readonly truncated: boolean;
}

export interface ExpansionLimits {
  readonly maxOccurrences?: number;
}

/** A request wider than this is refused outright: expansion is O(range),
 * runs inside a Worker request, and no calendar UI needs more than a year
 * plus change in one query. */
export const MAX_EXPANSION_RANGE_DAYS = 400;
export const MAX_OCCURRENCES_PER_EVENT = 1000;
const DAY_MS = 86_400_000;

/** Absolute iteration ceiling, so a rule that matches nothing (e.g.
 * `BYMONTH=2;BYMONTHDAY=31`) still terminates. */
const MAX_WALK_STEPS = 200_000;

const WEEKDAY_INDEX: Record<Weekday, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 0,
};

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: TimeZoneId): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** The zone's wall-clock reading of an instant. */
export function toWallClock(epochMs: number, timeZone: TimeZoneId): WallClock {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function wallClockToUtcNaive(wall: WallClock): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
}

/** The zone's UTC offset (ms) at an instant. */
function offsetAt(epochMs: number, timeZone: TimeZoneId): number {
  return wallClockToUtcNaive(toWallClock(epochMs, timeZone)) - epochMs;
}

/** Converts a wall-clock reading in `timeZone` to the instant it denotes.
 *
 * Two DST edge cases have to be decided rather than discovered:
 * - **Gap** (spring forward): the wall time does not exist. RFC 5545 leaves
 *   this open; we shift forward by the gap, so an 02:30 daily event lands at
 *   03:30 on the transition day rather than vanishing.
 * - **Ambiguity** (fall back): the wall time happens twice. We take the
 *   earlier offset, which is what iCloud and Google both do, so a synced
 *   series does not drift by an hour relative to the other client. */
export function wallClockToUtc(wall: WallClock, timeZone: TimeZoneId): number {
  const naive = wallClockToUtcNaive(wall);
  // Two passes converge for every real-world zone: the first guess uses the
  // offset at the naive instant, the second corrects it if the guess landed
  // on the other side of a transition.
  const firstOffset = offsetAt(naive, timeZone);
  const firstGuess = naive - firstOffset;
  const secondOffset = offsetAt(firstGuess, timeZone);
  const candidate = naive - secondOffset;

  const reread = toWallClock(candidate, timeZone);
  if (wallClockToUtcNaive(reread) === naive) {
    // For an ambiguous time both offsets round-trip; prefer the earlier
    // instant (the larger offset, i.e. before the clocks went back).
    const earlier = naive - firstOffset;
    if (earlier < candidate) {
      const earlierReread = toWallClock(earlier, timeZone);
      if (wallClockToUtcNaive(earlierReread) === naive) {
        return earlier;
      }
    }
    return candidate;
  }
  // Nonexistent wall time: `candidate` reads back as a different wall time.
  // Shift forward by the gap so the occurrence keeps its ordering.
  return candidate + (naive - wallClockToUtcNaive(reread));
}

function matchesByRules(
  event: CalendarEvent,
  year: number,
  month: number,
  day: number,
): boolean {
  const rule = event.recurrence;
  if (rule === null) {
    return true;
  }
  if (rule.byMonth !== undefined && !rule.byMonth.includes(month)) {
    return false;
  }
  if (rule.byMonthDay !== undefined && !rule.byMonthDay.includes(day)) {
    return false;
  }
  if (rule.byDay !== undefined) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const allowed = rule.byDay.map((entry) => WEEKDAY_INDEX[entry]);
    if (!allowed.includes(weekday)) {
      return false;
    }
  }
  return true;
}

interface CandidateDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function fromUtcMs(epochMs: number): CandidateDate {
  const date = new Date(epochMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function toUtcMs(candidate: CandidateDate): number {
  return Date.UTC(candidate.year, candidate.month - 1, candidate.day);
}

/** Start of the interval's first day, so `INTERVAL` counting is anchored
 * consistently regardless of which day inside the interval the series
 * started on. */
function intervalIndex(
  event: CalendarEvent,
  seed: CandidateDate,
  candidate: CandidateDate,
): number | null {
  const rule = event.recurrence;
  if (rule === null) {
    return 0;
  }
  switch (rule.freq) {
    case "DAILY": {
      const days = Math.round((toUtcMs(candidate) - toUtcMs(seed)) / DAY_MS);
      return days % rule.interval === 0 ? days / rule.interval : null;
    }
    case "WEEKLY": {
      const weekStartIndex = WEEKDAY_INDEX[rule.weekStart];
      const alignToWeek = (value: CandidateDate): number => {
        const utc = toUtcMs(value);
        const weekday = new Date(utc).getUTCDay();
        const delta = (weekday - weekStartIndex + 7) % 7;
        return utc - delta * DAY_MS;
      };
      const weeks = Math.round(
        (alignToWeek(candidate) - alignToWeek(seed)) / (7 * DAY_MS),
      );
      return weeks % rule.interval === 0 ? weeks / rule.interval : null;
    }
    case "MONTHLY": {
      const months =
        (candidate.year - seed.year) * 12 + (candidate.month - seed.month);
      return months % rule.interval === 0 ? months / rule.interval : null;
    }
    case "YEARLY": {
      const years = candidate.year - seed.year;
      return years % rule.interval === 0 ? years / rule.interval : null;
    }
    default: {
      const exhaustive: never = rule.freq;
      throw new Error(`Unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}

/** Days the generator has to walk for one candidate step. Walking day by
 * day is correct for every supported frequency; the coarser frequencies
 * simply reject most days in {@link intervalIndex}, so the step is widened
 * where it is provably safe (a monthly rule with no BYDAY/BYMONTHDAY can
 * skip to the same day of the next month). */
function nextCandidate(candidate: CandidateDate): CandidateDate {
  return fromUtcMs(toUtcMs(candidate) + DAY_MS);
}

interface SeriesSeed {
  readonly seedDate: CandidateDate;
  readonly durationMs: number;
  readonly wallTime: {
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
  };
  readonly timeZone: TimeZoneId | null;
  readonly startIsoDate: IsoDate | null;
  readonly dayCount: number;
}

function seedFromTime(time: EventTime): SeriesSeed {
  if (time.kind === "TIMED") {
    const wall = toWallClock(time.startsAt, time.timeZone);
    return {
      seedDate: { year: wall.year, month: wall.month, day: wall.day },
      durationMs: time.endsAt - time.startsAt,
      wallTime: { hour: wall.hour, minute: wall.minute, second: wall.second },
      timeZone: time.timeZone,
      startIsoDate: null,
      dayCount: 0,
    };
  }
  const startUtc = isoDateToUtcMs(time.startDate);
  const endUtc = isoDateToUtcMs(time.endDateExclusive);
  return {
    seedDate: fromUtcMs(startUtc),
    durationMs: endUtc - startUtc,
    wallTime: { hour: 0, minute: 0, second: 0 },
    timeZone: null,
    startIsoDate: time.startDate,
    dayCount: Math.round((endUtc - startUtc) / DAY_MS),
  };
}

function buildOccurrence(
  seed: SeriesSeed,
  candidate: CandidateDate,
): Occurrence {
  if (seed.timeZone !== null) {
    const startUtc = wallClockToUtc(
      {
        year: candidate.year,
        month: candidate.month,
        day: candidate.day,
        hour: seed.wallTime.hour,
        minute: seed.wallTime.minute,
        second: seed.wallTime.second,
      },
      seed.timeZone,
    );
    return {
      startUtc,
      // Duration is preserved rather than the end wall-clock time: a
      // one-hour meeting stays one hour across a DST transition, which is
      // what both iCloud and Google do.
      endUtc: startUtc + seed.durationMs,
      occurrenceStart: startUtc,
    };
  }
  const startDate = utcMsToIsoDate(toUtcMs(candidate));
  const endDateExclusive = addIsoDateDays(startDate, seed.dayCount);
  return {
    startUtc: toUtcMs(candidate),
    endUtc: toUtcMs(candidate) + seed.durationMs,
    startDate,
    endDateExclusive,
    occurrenceStart: startDate,
  };
}

function isExcluded(event: CalendarEvent, occurrence: Occurrence): boolean {
  return event.exdates.some((entry) => entry === occurrence.occurrenceStart);
}

/** Expands `event` into the occurrences overlapping `[rangeStartUtc,
 * rangeEndUtc)`.
 *
 * `COUNT` is consumed by **generated** occurrences before `EXDATE` filtering,
 * per RFC 5545: excluding a date shortens the series, it does not extend it
 * by generating one more at the end. */
export function expandOccurrences(
  event: CalendarEvent,
  rangeStartUtc: number,
  rangeEndUtc: number,
  limits: ExpansionLimits = {},
): ExpansionResult {
  if (!Number.isFinite(rangeStartUtc) || !Number.isFinite(rangeEndUtc)) {
    throw new ValidationError(
      "expansion range bounds must be valid timestamps",
      "rangeStart",
    );
  }
  if (rangeEndUtc <= rangeStartUtc) {
    throw new ValidationError(
      "expansion range end must be after its start",
      "rangeEnd",
    );
  }
  if (rangeEndUtc - rangeStartUtc > MAX_EXPANSION_RANGE_DAYS * DAY_MS) {
    throw new ValidationError(
      `expansion range must not exceed ${MAX_EXPANSION_RANGE_DAYS} days`,
      "rangeEnd",
    );
  }

  const maxOccurrences = limits.maxOccurrences ?? MAX_OCCURRENCES_PER_EVENT;
  const seed = seedFromTime(event.time);
  const rule = event.recurrence;

  if (rule === null) {
    const occurrence = buildOccurrence(seed, seed.seedDate);
    const overlaps =
      occurrence.startUtc < rangeEndUtc && occurrence.endUtc > rangeStartUtc;
    return {
      occurrences:
        overlaps && !isExcluded(event, occurrence) ? [occurrence] : [],
      truncated: false,
    };
  }

  const occurrences: Occurrence[] = [];
  let truncated = false;
  let generated = 0;
  const seedUtc = toUtcMs(seed.seedDate);
  // Walking stops at the earliest of the requested range end and `UNTIL`;
  // occurrences are generated in increasing order, so nothing past that
  // point can overlap the range.
  const walkLimitUtc = Math.min(
    rangeEndUtc,
    rule.untilUtc ?? Number.POSITIVE_INFINITY,
  );
  // `COUNT` is consumed by generated occurrences from the series start, so a
  // counted series must be walked from its seed. An uncounted one can jump
  // straight to the interval period covering the range -- without this a
  // decade-old daily series would spend thousands of iterations getting to
  // the window the caller actually asked about.
  const candidateStart =
    rule.count === undefined
      ? fastForward(seed, rule, rangeStartUtc - seed.durationMs - 2 * DAY_MS)
      : seed.seedDate;
  let candidate = candidateStart;

  const maxSteps = Math.min(
    Math.max(Math.ceil((walkLimitUtc - toUtcMs(candidateStart)) / DAY_MS), 0) +
      periodDays(rule) +
      5,
    MAX_WALK_STEPS,
  );

  for (let step = 0; step < maxSteps; step += 1) {
    if (rule.count !== undefined && generated >= rule.count) {
      break;
    }
    const candidateUtc = toUtcMs(candidate);
    // One day of slack: a timed occurrence's UTC instant can sit up to ~14h
    // either side of its local date's midnight-UTC stand-in.
    if (candidateUtc - DAY_MS > walkLimitUtc) {
      break;
    }

    const index = intervalIndex(event, seed.seedDate, candidate);
    if (
      index !== null &&
      index >= 0 &&
      matchesByRules(event, candidate.year, candidate.month, candidate.day) &&
      matchesFrequencyAnchor(event, seed.seedDate, candidate)
    ) {
      const occurrence = buildOccurrence(seed, candidate);
      if (rule.untilUtc !== undefined && occurrence.startUtc > rule.untilUtc) {
        break;
      }
      if (occurrence.startUtc >= seedUtc - DAY_MS) {
        generated += 1;
        if (
          occurrence.startUtc < rangeEndUtc &&
          occurrence.endUtc > rangeStartUtc &&
          !isExcluded(event, occurrence)
        ) {
          if (occurrences.length >= maxOccurrences) {
            truncated = true;
            break;
          }
          occurrences.push(occurrence);
        }
      }
    }
    candidate = nextCandidate(candidate);
  }

  return { occurrences, truncated };
}

/** For frequencies coarser than a day, a day only qualifies when it is the
 * anchor day the rule implies: the seed's day-of-month for MONTHLY/YEARLY
 * without an explicit `BYMONTHDAY`/`BYDAY`, and the seed's weekday for
 * WEEKLY without `BYDAY`. Without this, `FREQ=MONTHLY` would match every
 * day of the qualifying month. */
function matchesFrequencyAnchor(
  event: CalendarEvent,
  seed: CandidateDate,
  candidate: CandidateDate,
): boolean {
  const rule = event.recurrence;
  if (rule === null) {
    return true;
  }
  const hasByDay = rule.byDay !== undefined && rule.byDay.length > 0;
  const hasByMonthDay =
    rule.byMonthDay !== undefined && rule.byMonthDay.length > 0;
  switch (rule.freq) {
    case "DAILY":
      return true;
    case "WEEKLY":
      return (
        hasByDay ||
        new Date(toUtcMs(candidate)).getUTCDay() ===
          new Date(toUtcMs(seed)).getUTCDay()
      );
    case "MONTHLY":
      return hasByDay || hasByMonthDay || candidate.day === seed.day;
    case "YEARLY":
      return (
        (hasByDay || hasByMonthDay || candidate.day === seed.day) &&
        (rule.byMonth !== undefined || candidate.month === seed.month)
      );
    default: {
      const exhaustive: never = rule.freq;
      throw new Error(`Unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}

/** Replaces occurrences that carry an override row with the override's own
 * time/content, and drops occurrences whose override was itself excluded.
 *
 * Kept separate from {@link expandOccurrences} because overrides are stored
 * as sibling rows the application layer loads, while expansion stays a pure
 * function of one event. */
export function applyOverrides(
  master: CalendarEvent,
  overrides: readonly CalendarEvent[],
  occurrences: readonly Occurrence[],
): readonly {
  readonly event: CalendarEvent;
  readonly occurrence: Occurrence;
}[] {
  const byInstance = new Map<string, CalendarEvent>();
  for (const override of overrides) {
    if (override.overrideOf === null) {
      continue;
    }
    byInstance.set(
      String(override.overrideOf.recurrenceInstanceStart),
      override,
    );
  }

  const result: {
    readonly event: CalendarEvent;
    readonly occurrence: Occurrence;
  }[] = [];
  for (const occurrence of occurrences) {
    const override = byInstance.get(String(occurrence.occurrenceStart));
    if (override === undefined) {
      result.push({ event: master, occurrence });
      continue;
    }
    const seed = seedFromTime(override.time);
    const overridden = buildOccurrence(seed, seed.seedDate);
    result.push({
      event: override,
      occurrence: {
        ...overridden,
        occurrenceStart: occurrence.occurrenceStart,
      },
    });
  }
  return result;
}

/** Upper bound on the number of days one interval period can span, used to
 * size the walk. Deliberately generous rather than exact. */
function periodDays(rule: NonNullable<CalendarEvent["recurrence"]>): number {
  switch (rule.freq) {
    case "DAILY":
      return rule.interval + 1;
    case "WEEKLY":
      return rule.interval * 7 + 7;
    case "MONTHLY":
      return rule.interval * 31 + 31;
    case "YEARLY":
      return rule.interval * 366 + 366;
    default: {
      const exhaustive: never = rule.freq;
      throw new Error(`Unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}

/** Advances the walk start to the last interval period boundary at or before
 * `targetUtc`, preserving `INTERVAL` alignment with the seed. Only safe for
 * uncounted rules -- see the call site. */
function fastForward(
  seed: SeriesSeed,
  rule: NonNullable<CalendarEvent["recurrence"]>,
  targetUtc: number,
): CandidateDate {
  const seedUtc = toUtcMs(seed.seedDate);
  if (targetUtc <= seedUtc) {
    return seed.seedDate;
  }
  switch (rule.freq) {
    case "DAILY": {
      const days = Math.floor((targetUtc - seedUtc) / DAY_MS);
      const aligned = Math.floor(days / rule.interval) * rule.interval;
      return fromUtcMs(seedUtc + aligned * DAY_MS);
    }
    case "WEEKLY": {
      const weeks = Math.floor((targetUtc - seedUtc) / (7 * DAY_MS));
      const aligned = Math.floor(weeks / rule.interval) * rule.interval;
      return fromUtcMs(seedUtc + aligned * 7 * DAY_MS);
    }
    case "MONTHLY":
    case "YEARLY": {
      const target = fromUtcMs(targetUtc);
      const monthsApart =
        (target.year - seed.seedDate.year) * 12 +
        (target.month - seed.seedDate.month);
      const step = rule.freq === "MONTHLY" ? rule.interval : rule.interval * 12;
      const aligned = Math.floor(monthsApart / step) * step;
      if (aligned <= 0) {
        return seed.seedDate;
      }
      const absolute =
        seed.seedDate.year * 12 + (seed.seedDate.month - 1) + aligned;
      // Starts at the first of the period so a `BYMONTHDAY` earlier than the
      // seed's own day is not skipped.
      return {
        year: Math.floor(absolute / 12),
        month: (absolute % 12) + 1,
        day: 1,
      };
    }
    default: {
      const exhaustive: never = rule.freq;
      throw new Error(`Unhandled recurrence frequency: ${String(exhaustive)}`);
    }
  }
}
