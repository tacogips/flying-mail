/**
 * Pure date arithmetic for the calendar grids.
 *
 * Everything here works in the browser's local zone and returns plain data,
 * so the components stay declarative and the fiddly parts (week starts,
 * month padding, half-open ranges, overlap layout) are unit-testable
 * without rendering anything.
 */

import type { EventOccurrenceView } from "../api/calendar-types";

export type CalendarViewMode = "MONTH" | "WEEK";

export const DAY_MS = 86_400_000;

/** Local midnight of the day containing `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function addMonths(date: Date, months: number): Date {
  // Day 1 first: adding a month to the 31st would otherwise roll into the
  // month after next.
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** `weekStartsOn` is 0 (Sunday) .. 6 (Saturday). */
export function startOfWeek(date: Date, weekStartsOn = 0): Date {
  const day = startOfDay(date);
  const shift = (day.getDay() - weekStartsOn + 7) % 7;
  return addDays(day, -shift);
}

export function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function toIsoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` -> local midnight of that date. `new Date("2026-09-01")`
 * would parse as UTC and land on the previous day west of Greenwich. */
export function fromIsoDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** `HH:MM` in the browser's zone. */
export function toTimeInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

/** Combines a date-input and a time-input value into a local instant. */
export function fromDateAndTime(dateValue: string, timeValue: string): Date {
  const base = fromIsoDate(dateValue);
  const [hours, minutes] = timeValue.split(":").map(Number);
  base.setHours(hours ?? 0, minutes ?? 0, 0, 0);
  return base;
}

export interface CalendarRange {
  readonly start: Date;
  /** Exclusive. */
  readonly end: Date;
}

/** The visible range of a month view: whole weeks, so the grid is a
 * rectangle rather than a ragged one. */
export function monthGridRange(month: Date, weekStartsOn = 0): CalendarRange {
  const start = startOfWeek(startOfMonth(month), weekStartsOn);
  const end = addDays(start, 42);
  return { start, end };
}

export function weekGridRange(date: Date, weekStartsOn = 0): CalendarRange {
  const start = startOfWeek(date, weekStartsOn);
  return { start, end: addDays(start, 7) };
}

export function visibleRange(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn = 0,
): CalendarRange {
  return mode === "MONTH"
    ? monthGridRange(anchor, weekStartsOn)
    : weekGridRange(anchor, weekStartsOn);
}

export interface MonthCell {
  readonly date: Date;
  readonly inMonth: boolean;
  readonly isToday: boolean;
}

/** Six rows of seven days. Always six, so the grid does not resize as the
 * user pages through months. */
export function buildMonthMatrix(
  month: Date,
  today: Date,
  weekStartsOn = 0,
): readonly (readonly MonthCell[])[] {
  const { start } = monthGridRange(month, weekStartsOn);
  const rows: MonthCell[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const cells: MonthCell[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(start, week * 7 + day);
      cells.push({
        date,
        inMonth: date.getMonth() === month.getMonth(),
        isToday: isSameDay(date, today),
      });
    }
    rows.push(cells);
  }
  return rows;
}

export function buildWeekDays(date: Date, weekStartsOn = 0): readonly Date[] {
  const start = startOfWeek(date, weekStartsOn);
  return Array.from({ length: 7 }, (_unused, index) => addDays(start, index));
}

/** True when `[startsAt, endsAt)` overlaps the day. Half-open on both
 * sides: an event ending exactly at midnight belongs to the day before, not
 * to the one that starts then. */
export function occurrenceCoversDay(
  occurrence: EventOccurrenceView,
  day: Date,
): boolean {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;
  const start = Date.parse(occurrence.startsAt);
  const end = Date.parse(occurrence.endsAt);
  return start < dayEnd && end > dayStart;
}

export function occurrencesForDay(
  occurrences: readonly EventOccurrenceView[],
  day: Date,
): readonly EventOccurrenceView[] {
  return occurrences
    .filter((occurrence) => occurrenceCoversDay(occurrence, day))
    .sort((left, right) => {
      // All-day first, then by start: a day column reads top-down as
      // "context, then schedule".
      const leftAllDay = left.event.time.allDay ? 0 : 1;
      const rightAllDay = right.event.time.allDay ? 0 : 1;
      if (leftAllDay !== rightAllDay) {
        return leftAllDay - rightAllDay;
      }
      return Date.parse(left.startsAt) - Date.parse(right.startsAt);
    });
}

export interface PositionedOccurrence {
  readonly occurrence: EventOccurrenceView;
  /** Fraction of the day (0..1) at which the block starts and ends, clamped
   * to the day so a multi-day event renders as a full column rather than
   * overflowing. */
  readonly top: number;
  readonly height: number;
  /** Horizontal slot for overlapping events: `column` of `columns`. */
  readonly column: number;
  readonly columns: number;
}

/** Lays out one day's timed occurrences into non-overlapping columns.
 *
 * Greedy interval colouring: an occurrence takes the first column whose last
 * entry has already ended. Every member of an overlapping cluster then gets
 * the cluster's column count, so a pair of overlapping events each take half
 * the width instead of one hiding the other. */
export function layoutDayOccurrences(
  occurrences: readonly EventOccurrenceView[],
  day: Date,
): readonly PositionedOccurrence[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + DAY_MS;
  const timed = occurrencesForDay(occurrences, day).filter(
    (occurrence) => !occurrence.event.time.allDay,
  );

  interface Placed {
    readonly occurrence: EventOccurrenceView;
    readonly start: number;
    readonly end: number;
    column: number;
    cluster: number;
  }
  const placed: Placed[] = [];
  const columnEnds: number[] = [];
  let clusterIndex = 0;
  let clusterEnd = -Infinity;

  for (const occurrence of timed) {
    const start = Math.max(Date.parse(occurrence.startsAt), dayStart);
    const end = Math.min(Date.parse(occurrence.endsAt), dayEnd);
    if (start >= clusterEnd) {
      // Nothing still running: a new cluster, and every column is free.
      clusterIndex += 1;
      columnEnds.length = 0;
      clusterEnd = end;
    } else {
      clusterEnd = Math.max(clusterEnd, end);
    }
    let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
    if (column === -1) {
      column = columnEnds.length;
    }
    columnEnds[column] = end;
    placed.push({ occurrence, start, end, column, cluster: clusterIndex });
  }

  const clusterColumns = new Map<number, number>();
  for (const entry of placed) {
    clusterColumns.set(
      entry.cluster,
      Math.max(clusterColumns.get(entry.cluster) ?? 0, entry.column + 1),
    );
  }

  return placed.map((entry) => ({
    occurrence: entry.occurrence,
    top: (entry.start - dayStart) / DAY_MS,
    height: Math.max((entry.end - entry.start) / DAY_MS, 1 / 96),
    column: entry.column,
    columns: clusterColumns.get(entry.cluster) ?? 1,
  }));
}

const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

export function formatMonthLabel(date: Date): string {
  return MONTH_FORMAT.format(date);
}

export function formatRangeLabel(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartsOn = 0,
): string {
  if (mode === "MONTH") {
    return formatMonthLabel(anchor);
  }
  const days = buildWeekDays(anchor, weekStartsOn);
  const first = days[0];
  const last = days[6];
  if (first === undefined || last === undefined) {
    return formatMonthLabel(anchor);
  }
  const dayFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${dayFormat.format(first)} - ${dayFormat.format(last)}, ${last.getFullYear()}`;
}

export function formatTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The browser's IANA zone, or `UTC` when the runtime will not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
