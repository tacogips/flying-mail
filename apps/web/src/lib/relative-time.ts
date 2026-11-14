const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A compact relative label for a message list.
 *
 * Takes `now` explicitly rather than reading the clock, so the output is
 * testable and a list re-render cannot produce inconsistent labels within
 * one pass. */
export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  const elapsed = now.getTime() - then.getTime();
  if (elapsed < MINUTE) {
    return "just now";
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)}m ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)}h ago`;
  }
  if (elapsed < 7 * DAY) {
    return `${Math.floor(elapsed / DAY)}d ago`;
  }
  return then.toISOString().slice(0, 10);
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** A Proton-style list timestamp: a bare time for today, "Yesterday" for
 * the previous day, a short date within the current year, and a full date
 * (with year) beyond that -- the reader needs the year once a message is
 * old enough that "Aug 23" alone would be ambiguous. */
export function formatListTime(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  if (sameCalendarDay(then, now)) {
    return then.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameCalendarDay(then, yesterday)) {
    return "Yesterday";
  }
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return then.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Full timestamp for a detail view, where precision matters more than
 * brevity. */
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Human-readable byte size for attachment tiles. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
