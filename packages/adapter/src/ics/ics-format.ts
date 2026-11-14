/** RFC 5545 content-line grammar: folding, escaping and date-time forms.
 *
 * Kept apart from `ics-codec.ts` so the codec reads as a property mapping
 * rather than as string surgery, and so the fiddly octet-counting rules can
 * be tested on their own. */

const MAX_LINE_OCTETS = 75;

const encoder = new TextEncoder();

function octetLength(value: string): number {
  return encoder.encode(value).length;
}

/** Folds at 75 octets (not characters -- RFC 5545 counts octets, and a
 * folded multi-byte character would be corrupt). Continuation lines carry a
 * leading space, which counts toward their own 75. */
export function foldLine(line: string): string {
  if (octetLength(line) <= MAX_LINE_OCTETS) {
    return line;
  }
  const chunks: string[] = [];
  let current = "";
  let currentOctets = 0;
  let limit = MAX_LINE_OCTETS;
  // Iterating the string yields whole code points, so a surrogate pair is
  // never split either.
  for (const char of line) {
    const size = octetLength(char);
    if (currentOctets + size > limit) {
      chunks.push(current);
      current = "";
      currentOctets = 0;
      limit = MAX_LINE_OCTETS - 1;
    }
    current += char;
    currentOctets += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks.join("\r\n ");
}

/** Unfolds a whole ICS document into logical lines. Tolerant on purpose:
 * lone `\n` line endings and tab continuations both appear in the wild. */
export function unfoldLines(ics: string): readonly string[] {
  const rawLines = ics.split(/\r\n|\n|\r/);
  const logical: string[] = [];
  for (const raw of rawLines) {
    if (raw.length === 0) {
      continue;
    }
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && logical.length > 0) {
      logical[logical.length - 1] += raw.slice(1);
      continue;
    }
    logical.push(raw);
  }
  return logical;
}

/** Escapes a TEXT value: backslash first, so the backslashes introduced for
 * the other escapes are not re-escaped. */
export function escapeText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\n");
}

export function unescapeText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      result += char;
      continue;
    }
    index += 1;
    switch (next) {
      case "n":
      case "N":
        result += "\n";
        break;
      case "\\":
      case ";":
      case ",":
        result += next;
        break;
      default:
        // An unknown escape is kept verbatim rather than dropped: the
        // producer meant something by it, and losing the backslash would
        // silently change the text.
        result += next;
        break;
    }
  }
  return result;
}

/** RFC 6868 parameter-value encoding, plus RFC 5545 quoting when the value
 * carries a character that would otherwise end the parameter. */
export function encodeParamValue(value: string): string {
  const encoded = value
    .replaceAll("^", "^^")
    .replaceAll('"', "^'")
    .replaceAll("\r\n", "^n")
    .replaceAll("\n", "^n");
  return /[:;,]/.test(encoded) ? `"${encoded}"` : encoded;
}

export function decodeParamValue(value: string): string {
  const unquoted =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value;
  let result = "";
  for (let index = 0; index < unquoted.length; index += 1) {
    const char = unquoted[index];
    if (char !== "^") {
      result += char;
      continue;
    }
    const next = unquoted[index + 1];
    if (next === "n") {
      result += "\n";
      index += 1;
    } else if (next === "'") {
      result += '"';
      index += 1;
    } else if (next === "^") {
      result += "^";
      index += 1;
    } else {
      result += char;
    }
  }
  return result;
}

export interface IcsContentLine {
  /** Upper-cased, with any `group.` prefix stripped. */
  readonly name: string;
  /** Upper-cased parameter names; a parameter may legally repeat or carry a
   * comma-separated list, so values are always an array. */
  readonly params: ReadonlyMap<string, readonly string[]>;
  readonly value: string;
}

function splitParamList(raw: string): readonly string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map(decodeParamValue);
}

/** Splits one unfolded line into name, parameters and value. Returns `null`
 * for a line with no `:` separator, which is malformed and skipped rather
 * than aborting the whole import. */
export function parseContentLine(line: string): IcsContentLine | null {
  let separator = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ":" && !quoted) {
      separator = index;
      break;
    }
  }
  if (separator === -1) {
    return null;
  }
  const head = line.slice(0, separator);
  const value = line.slice(separator + 1);

  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const char of head) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const rawName = parts[0] ?? "";
  // `group.NAME` (RFC 5545 allows a grouping prefix; vCard-style producers
  // emit it) -- the group carries no meaning here.
  const dot = rawName.lastIndexOf(".");
  const name = (dot === -1 ? rawName : rawName.slice(dot + 1))
    .trim()
    .toUpperCase();

  const params = new Map<string, readonly string[]>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const paramName = part.slice(0, equals).trim().toUpperCase();
    const paramValues = splitParamList(part.slice(equals + 1));
    const existing = params.get(paramName);
    params.set(
      paramName,
      existing === undefined ? paramValues : [...existing, ...paramValues],
    );
  }

  return { name, params, value };
}

export function firstParam(line: IcsContentLine, name: string): string | null {
  return line.params.get(name)?.[0] ?? null;
}

export interface IcsDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** True for a `...Z` value, which is an absolute instant regardless of any
   * (illegal, but occasionally present) `TZID`. */
  readonly utc: boolean;
  /** True for a `VALUE=DATE` style `YYYYMMDD` value. */
  readonly dateOnly: boolean;
}

const DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

export function parseIcsDateTimeParts(value: string): IcsDateTimeParts | null {
  const trimmed = value.trim();
  const dateTime = DATE_TIME_PATTERN.exec(trimmed);
  if (dateTime !== null) {
    return {
      year: Number(dateTime[1]),
      month: Number(dateTime[2]),
      day: Number(dateTime[3]),
      hour: Number(dateTime[4]),
      minute: Number(dateTime[5]),
      second: Number(dateTime[6]),
      utc: dateTime[7] === "Z",
      dateOnly: false,
    };
  }
  const date = DATE_PATTERN.exec(trimmed);
  if (date === null) {
    return null;
  }
  return {
    year: Number(date[1]),
    month: Number(date[2]),
    day: Number(date[3]),
    hour: 0,
    minute: 0,
    second: 0,
    utc: false,
    dateOnly: true,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatIcsDate(
  year: number,
  month: number,
  day: number,
): string {
  return `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}`;
}

export function formatIcsLocalDateTime(parts: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}): string {
  return (
    `${formatIcsDate(parts.year, parts.month, parts.day)}T` +
    `${pad(parts.hour, 2)}${pad(parts.minute, 2)}${pad(parts.second, 2)}`
  );
}

/** ISO 8601 duration subset used by `DURATION` (`P1DT2H30M`, `-PT15M`).
 * Returns milliseconds, or `null` when the text is outside the subset. */
export function parseIcsDuration(value: string): number | null {
  const match =
    /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
      value.trim().toUpperCase(),
    );
  if (match === null) {
    return null;
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (
    weeks === undefined &&
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return null;
  }
  const total =
    Number(weeks ?? 0) * 604_800_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1000;
  return sign === "-" ? -total : total;
}
