import type {
  IcsCodec,
  IcsSerializeOptions,
  IcsWarning,
  ParsedIcsEvent,
  ParsedIcsLink,
} from "@mailcal/application/ports/ics-codec";
import type {
  CalendarEvent,
  EventTime,
  OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import {
  toWallClock,
  wallClockToUtc,
} from "@mailcal/domain/entities/recurrence-expansion";
import {
  addIsoDateDays,
  parseIsoDate,
} from "@mailcal/domain/value-objects/iso-date";
import {
  formatRecurrenceRule,
  parseRecurrenceRule,
} from "@mailcal/domain/value-objects/recurrence";
import {
  parseTimeZoneId,
  UTC_TIME_ZONE,
} from "@mailcal/domain/value-objects/time-zone";
import type { IsoDate } from "@mailcal/domain/value-objects/iso-date";
import type { TimeZoneId } from "@mailcal/domain/value-objects/time-zone";
import {
  encodeParamValue,
  escapeText,
  firstParam,
  foldLine,
  formatIcsDate,
  formatIcsLocalDateTime,
  type IcsContentLine,
  parseContentLine,
  parseIcsDateTimeParts,
  parseIcsDuration,
  unescapeText,
  unfoldLines,
} from "./ics-format";

const DEFAULT_PRODUCT_ID = "-//mailcal//calendar//EN";
const DAY_MS = 86_400_000;

/** A remote timed VEVENT with neither `DTEND` nor `DURATION` is zero-length
 * in RFC 5545 terms, which the domain rejects (`endsAt > startsAt`). One
 * minute is the smallest representable stand-in, so a re-serialized push
 * moves the remote event as little as possible. */
const ZERO_LENGTH_FALLBACK_MS = 60_000;

const MENTION_PROPERTY = "X-MAILCAL-MENTION";
const LINK_PROPERTY = "X-MAILCAL-LINK";
const LINK_TITLE_PARAM = "X-TITLE";

// -- serialize ---------------------------------------------------------------

function property(
  name: string,
  value: string,
  params: readonly (readonly [string, string])[] = [],
): string {
  const head = params
    .map(([key, raw]) => `;${key}=${encodeParamValue(raw)}`)
    .join("");
  return foldLine(`${name}${head}:${value}`);
}

function textProperty(name: string, value: string): string {
  return property(name, escapeText(value));
}

function localDateTimeInZone(epochMs: number, timeZone: TimeZoneId): string {
  return formatIcsLocalDateTime(toWallClock(epochMs, timeZone));
}

function isoDateToIcsDate(value: IsoDate): string {
  const [year, month, day] = value.split("-");
  return formatIcsDate(Number(year), Number(month), Number(day));
}

function occurrenceStartValue(start: OccurrenceStart, time: EventTime): string {
  if (time.kind === "ALL_DAY") {
    return isoDateToIcsDate(start as IsoDate);
  }
  return localDateTimeInZone(start as number, time.timeZone);
}

function timeParams(time: EventTime): readonly (readonly [string, string])[] {
  return time.kind === "ALL_DAY"
    ? [["VALUE", "DATE"]]
    : [["TZID", time.timeZone]];
}

function serializeTimeProperties(time: EventTime): readonly string[] {
  if (time.kind === "ALL_DAY") {
    return [
      property("DTSTART", isoDateToIcsDate(time.startDate), [
        ["VALUE", "DATE"],
      ]),
      property("DTEND", isoDateToIcsDate(time.endDateExclusive), [
        ["VALUE", "DATE"],
      ]),
    ];
  }
  return [
    property("DTSTART", localDateTimeInZone(time.startsAt, time.timeZone), [
      ["TZID", time.timeZone],
    ]),
    property("DTEND", localDateTimeInZone(time.endsAt, time.timeZone), [
      ["TZID", time.timeZone],
    ]),
  ];
}

function utcStamp(date: Date): string {
  return `${formatIcsLocalDateTime({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  })}Z`;
}

/** The `VEVENT` block for one event, without the enclosing `VCALENDAR`.
 *
 * Mentions are written as `X-MAILCAL-MENTION`, never as `ATTENDEE`: an
 * `ATTENDEE` line makes iCloud treat the object as an iTIP scheduling
 * message -- it emails invitations and starts tracking `PARTSTAT`, which is
 * precisely the RSVP behavior mailcal excludes by design. */
function serializeVevent(
  event: CalendarEvent,
  options: IcsSerializeOptions,
): readonly string[] {
  const lines: string[] = [
    "BEGIN:VEVENT",
    textProperty("UID", event.uid),
    property("DTSTAMP", utcStamp(options.dtstamp)),
    ...serializeTimeProperties(event.time),
    textProperty("SUMMARY", event.title),
  ];

  if (event.description !== null) {
    lines.push(textProperty("DESCRIPTION", event.description));
  }
  if (event.location !== null) {
    lines.push(textProperty("LOCATION", event.location));
  }
  if (event.recurrence !== null) {
    lines.push(property("RRULE", formatRecurrenceRule(event.recurrence)));
  }
  if (event.exdates.length > 0) {
    lines.push(
      property(
        "EXDATE",
        event.exdates
          .map((start) => occurrenceStartValue(start, event.time))
          .join(","),
        timeParams(event.time),
      ),
    );
  }
  if (event.overrideOf !== null) {
    lines.push(
      property(
        "RECURRENCE-ID",
        occurrenceStartValue(
          event.overrideOf.recurrenceInstanceStart,
          event.time,
        ),
        timeParams(event.time),
      ),
    );
  }

  const firstLink = event.links[0];
  if (firstLink !== undefined) {
    lines.push(property("URL", firstLink.url));
  }
  for (const link of event.links) {
    lines.push(
      property(
        LINK_PROPERTY,
        escapeText(link.url),
        link.title === null ? [] : [[LINK_TITLE_PARAM, link.title]],
      ),
    );
  }
  for (const mention of event.mentions) {
    lines.push(property(MENTION_PROPERTY, `mailto:${mention}`));
  }

  lines.push("END:VEVENT");
  return lines;
}

function wrapCalendar(
  veventBlocks: readonly (readonly string[])[],
  options: IcsSerializeOptions,
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    property("PRODID", options.productId ?? DEFAULT_PRODUCT_ID),
    "CALSCALE:GREGORIAN",
    ...veventBlocks.flat(),
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

function serializeEvent(
  event: CalendarEvent,
  options: IcsSerializeOptions,
): string {
  return wrapCalendar([serializeVevent(event, options)], options);
}

/** One calendar object resource: the master first, then its overrides in
 * occurrence order.
 *
 * Master-first matters on import: a reader (ours included) can only attach
 * an override to a series that already exists, and RFC 4791 lets a client
 * assume nothing about the order a server returns components in. */
function serializeCalendarObject(
  events: readonly CalendarEvent[],
  options: IcsSerializeOptions,
): string {
  const ordered = [...events].sort((left, right) => {
    if ((left.overrideOf === null) !== (right.overrideOf === null)) {
      return left.overrideOf === null ? -1 : 1;
    }
    const leftStart = left.overrideOf?.recurrenceInstanceStart ?? 0;
    const rightStart = right.overrideOf?.recurrenceInstanceStart ?? 0;
    return String(leftStart).localeCompare(String(rightStart));
  });
  return wrapCalendar(
    ordered.map((event) => serializeVevent(event, options)),
    options,
  );
}

// -- parse -------------------------------------------------------------------

interface ResolvedInstant {
  readonly epochMs: number;
  readonly timeZone: TimeZoneId;
  readonly unknownZone: string | null;
}

/** Resolves a date-time property to an instant plus the zone it was authored
 * in. An unknown `TZID` falls back to UTC and reports the original value, so
 * the sync result can tell the user their event may be offset rather than
 * silently shifting it. */
function resolveInstant(line: IcsContentLine): ResolvedInstant | null {
  const parts = parseIcsDateTimeParts(line.value.split(",")[0] ?? "");
  if (parts === null) {
    return null;
  }
  const tzid = firstParam(line, "TZID");
  if (parts.utc || tzid === null) {
    return {
      epochMs: Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      ),
      timeZone: UTC_TIME_ZONE,
      unknownZone: null,
    };
  }
  const zone = parseTimeZoneId(tzid);
  if (zone === null) {
    return {
      epochMs: Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      ),
      timeZone: UTC_TIME_ZONE,
      unknownZone: tzid,
    };
  }
  return {
    epochMs: wallClockToUtc(
      {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        hour: parts.hour,
        minute: parts.minute,
        second: parts.second,
      },
      zone,
    ),
    timeZone: zone,
    unknownZone: null,
  };
}

function isDateOnly(line: IcsContentLine): boolean {
  if (firstParam(line, "VALUE")?.toUpperCase() === "DATE") {
    return true;
  }
  return (
    parseIcsDateTimeParts(line.value.split(",")[0] ?? "")?.dateOnly === true
  );
}

function icsDateToIsoDate(value: string): IsoDate | null {
  const parts = parseIcsDateTimeParts(value);
  if (parts === null) {
    return null;
  }
  const text =
    `${String(parts.year).padStart(4, "0")}-` +
    `${String(parts.month).padStart(2, "0")}-` +
    `${String(parts.day).padStart(2, "0")}`;
  return parseIsoDate(text);
}

interface VeventBlock {
  readonly lines: readonly IcsContentLine[];
}

/** Splits the document into `VEVENT` blocks, skipping every other component
 * (`VTIMEZONE`, `VALARM`, `VTODO`) including nested ones. */
function extractVevents(ics: string): readonly VeventBlock[] {
  const blocks: VeventBlock[] = [];
  let current: IcsContentLine[] | null = null;
  let nestedDepth = 0;

  for (const raw of unfoldLines(ics)) {
    const line = parseContentLine(raw);
    if (line === null) {
      continue;
    }
    const component = line.value.trim().toUpperCase();
    if (line.name === "BEGIN") {
      if (current === null) {
        if (component === "VEVENT") {
          current = [];
        }
        continue;
      }
      nestedDepth += 1;
      continue;
    }
    if (line.name === "END") {
      if (current === null) {
        continue;
      }
      if (nestedDepth > 0) {
        nestedDepth -= 1;
        continue;
      }
      if (component === "VEVENT") {
        blocks.push({ lines: current });
        current = null;
      }
      continue;
    }
    if (current !== null && nestedDepth === 0) {
      current.push(line);
    }
  }
  return blocks;
}

interface MentionCollector {
  readonly addresses: string[];
  readonly seen: Set<string>;
}

function addMention(collector: MentionCollector, raw: string): void {
  const address = unescapeText(raw)
    .trim()
    .replace(/^mailto:/i, "")
    .trim();
  if (address.length === 0) {
    return;
  }
  const key = address.toLowerCase();
  if (collector.seen.has(key)) {
    return;
  }
  collector.seen.add(key);
  collector.addresses.push(address);
}

function parseAllDayTime(
  start: IcsContentLine,
  end: IcsContentLine | null,
  duration: IcsContentLine | null,
): EventTime | null {
  const startDate = icsDateToIsoDate(start.value.split(",")[0] ?? "");
  if (startDate === null) {
    return null;
  }
  if (end !== null) {
    const endDate = icsDateToIsoDate(end.value.split(",")[0] ?? "");
    if (endDate !== null) {
      return { kind: "ALL_DAY", startDate, endDateExclusive: endDate };
    }
  }
  if (duration !== null) {
    const durationMs = parseIcsDuration(duration.value);
    if (durationMs !== null && durationMs > 0) {
      const days = Math.max(1, Math.round(durationMs / DAY_MS));
      return {
        kind: "ALL_DAY",
        startDate,
        endDateExclusive: addIsoDateDays(startDate, days),
      };
    }
  }
  // RFC 5545: a DATE-valued DTSTART with no DTEND ends at the end of that
  // same calendar day.
  return {
    kind: "ALL_DAY",
    startDate,
    endDateExclusive: addIsoDateDays(startDate, 1),
  };
}

function parseTimedTime(
  start: ResolvedInstant,
  end: IcsContentLine | null,
  duration: IcsContentLine | null,
): EventTime {
  let endsAt: number | null = null;
  if (end !== null) {
    const resolved = resolveInstant(end);
    if (resolved !== null) {
      endsAt = resolved.epochMs;
    }
  }
  if (endsAt === null && duration !== null) {
    const durationMs = parseIcsDuration(duration.value);
    if (durationMs !== null) {
      endsAt = start.epochMs + durationMs;
    }
  }
  if (endsAt === null || endsAt <= start.epochMs) {
    endsAt = start.epochMs + ZERO_LENGTH_FALLBACK_MS;
  }
  return {
    kind: "TIMED",
    startsAt: start.epochMs,
    endsAt,
    timeZone: start.timeZone,
  };
}

function parseExdates(
  lines: readonly IcsContentLine[],
  time: EventTime,
): readonly OccurrenceStart[] {
  const result: OccurrenceStart[] = [];
  for (const line of lines) {
    for (const entry of line.value.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (time.kind === "ALL_DAY") {
        const date = icsDateToIsoDate(trimmed);
        if (date !== null) {
          result.push(date);
        }
        continue;
      }
      // Each value carries the property's own TZID, so a per-value line is
      // resolved with the same parameters as the whole property.
      const resolved = resolveInstant({
        name: line.name,
        params: line.params,
        value: trimmed,
      });
      if (resolved !== null) {
        result.push(resolved.epochMs);
      }
    }
  }
  return result;
}

function parseVevent(block: VeventBlock): ParsedIcsEvent | null {
  const byName = new Map<string, IcsContentLine[]>();
  for (const line of block.lines) {
    const existing = byName.get(line.name);
    if (existing === undefined) {
      byName.set(line.name, [line]);
    } else {
      existing.push(line);
    }
  }
  const single = (name: string): IcsContentLine | null =>
    byName.get(name)?.[0] ?? null;

  const uidLine = single("UID");
  const startLine = single("DTSTART");
  if (uidLine === null || startLine === null) {
    // Without a UID there is nothing to map the object onto locally, and
    // without a DTSTART it is not an event we can place on a grid.
    return null;
  }
  const uid = unescapeText(uidLine.value).trim();
  if (uid.length === 0) {
    return null;
  }

  const warnings: IcsWarning[] = [];
  const endLine = single("DTEND");
  const durationLine = single("DURATION");

  let time: EventTime | null;
  if (isDateOnly(startLine)) {
    time = parseAllDayTime(startLine, endLine, durationLine);
  } else {
    const resolved = resolveInstant(startLine);
    if (resolved === null) {
      return null;
    }
    if (resolved.unknownZone !== null) {
      warnings.push({
        kind: "UNKNOWN_TIME_ZONE",
        uid,
        value: resolved.unknownZone,
      });
    }
    time = parseTimedTime(resolved, endLine, durationLine);
  }
  if (time === null) {
    return null;
  }

  const rruleLine = single("RRULE");
  const recurrence =
    rruleLine === null ? null : parseRecurrenceRule(rruleLine.value);
  const recurrenceUnsupported = rruleLine !== null && recurrence === null;
  if (recurrenceUnsupported && rruleLine !== null) {
    warnings.push({
      kind: "RECURRENCE_UNSUPPORTED",
      uid,
      value: rruleLine.value,
    });
  }

  const recurrenceIdLine = single("RECURRENCE-ID");
  let recurrenceInstanceStart: OccurrenceStart | null = null;
  if (recurrenceIdLine !== null) {
    if (time.kind === "ALL_DAY") {
      recurrenceInstanceStart = icsDateToIsoDate(
        recurrenceIdLine.value.split(",")[0] ?? "",
      );
    } else {
      recurrenceInstanceStart =
        resolveInstant(recurrenceIdLine)?.epochMs ?? null;
    }
  }

  const mentions: MentionCollector = { addresses: [], seen: new Set() };
  for (const line of byName.get("ATTENDEE") ?? []) {
    // Address only: PARTSTAT, RSVP, ROLE and CN are dropped on the floor.
    // mailcal has nowhere to put attendance state, and keeping a CN would
    // imply a participant record that does not exist.
    addMention(mentions, line.value);
  }
  for (const line of byName.get(MENTION_PROPERTY) ?? []) {
    addMention(mentions, line.value);
  }

  const links: ParsedIcsLink[] = [];
  const linkUrls = new Set<string>();
  for (const line of byName.get(LINK_PROPERTY) ?? []) {
    const url = unescapeText(line.value).trim();
    if (url.length === 0 || linkUrls.has(url)) {
      continue;
    }
    linkUrls.add(url);
    const title = firstParam(line, LINK_TITLE_PARAM);
    links.push({
      url,
      title: title === null || title.length === 0 ? null : title,
    });
  }
  for (const line of byName.get("URL") ?? []) {
    const url = unescapeText(line.value).trim();
    if (url.length === 0 || linkUrls.has(url)) {
      continue;
    }
    linkUrls.add(url);
    links.push({ url, title: null });
  }

  const summary = single("SUMMARY");
  const description = single("DESCRIPTION");
  const location = single("LOCATION");

  return {
    uid,
    title:
      summary === null || unescapeText(summary.value).trim().length === 0
        ? "(no title)"
        : unescapeText(summary.value).trim(),
    description:
      description === null ? null : unescapeText(description.value).trim(),
    location: location === null ? null : unescapeText(location.value).trim(),
    time,
    recurrence,
    exdates: parseExdates(byName.get("EXDATE") ?? [], time),
    recurrenceInstanceStart,
    mentions: mentions.addresses,
    links,
    recurrenceUnsupported,
    warnings,
  };
}

/** RFC 5545 subset codec. One calendar object may carry a series master plus
 * its overrides, so parsing returns a list. */
export function createIcsCodec(): IcsCodec {
  return {
    serializeEvent,
    serializeCalendarObject,
    parseCalendarObject(ics: string): readonly ParsedIcsEvent[] {
      const parsed: ParsedIcsEvent[] = [];
      for (const block of extractVevents(ics)) {
        const event = parseVevent(block);
        if (event !== null) {
          parsed.push(event);
        }
      }
      return parsed;
    },
  };
}
