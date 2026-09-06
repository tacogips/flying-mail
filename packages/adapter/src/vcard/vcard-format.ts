/** RFC 6350 (vCard 4.0) / RFC 2426 (vCard 3.0) content-line grammar: folding,
 * escaping and content-line tokenizing.
 *
 * Kept apart from `vcard-codec.ts` so the codec reads as a property mapping
 * rather than as string surgery. */

const MAX_LINE_OCTETS = 75;

const encoder = new TextEncoder();

function octetLength(value: string): number {
  return encoder.encode(value).length;
}

/** Folds at 75 octets (not characters -- RFC 6350 section 3.2 counts
 * octets, and a folded multi-byte character would be corrupt). Continuation
 * lines carry a leading space, which counts toward their own 75. */
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

/** Unfolds a whole vCard document into logical lines. Tolerant on purpose:
 * lone `\n` line endings and tab continuations both appear in the wild
 * (RFC 6350 section 3.2 permits a tab as the continuation marker too). */
export function unfoldLines(vcard: string): readonly string[] {
  const rawLines = vcard.split(/\r\n|\n|\r/);
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

/** Splits a structured TEXT value (`N`, `ADR`) on unescaped occurrences of
 * `separator`, returning each component still escaped -- callers unescape
 * the components they actually use. A `\;` inside a component must not
 * split it, which a plain `String.split` would get wrong. */
export function splitEscaped(
  value: string,
  separator: string,
): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      const next = value[index + 1];
      current += next === undefined ? char : char + next;
      index += 1;
      continue;
    }
    if (char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Quotes a parameter value when it carries a character (`:`, `;`, `,`)
 * that would otherwise end the parameter or its value list. vCard 3.0
 * (RFC 2426) parameter values have no caret-escaping mechanism -- unlike
 * iCalendar's RFC 6868 -- so a literal double quote is simply dropped
 * rather than encoded; no vCard property this codec models has ever needed
 * one in the wild. */
export function encodeParamValue(value: string): string {
  const sanitized = value.replaceAll('"', "");
  return /[:;,]/.test(sanitized) ? `"${sanitized}"` : sanitized;
}

function decodeParamValue(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
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

export interface VcardContentLine {
  /** The `group.` prefix, verbatim and un-uppercased, or `null` when the
   * line carries none. A grouped line (`item1.EMAIL`, `item1.X-ABLABEL`)
   * is never modeled by this codec regardless of `name` -- see the codec's
   * module doc -- so callers branch on this before consulting `name`. */
  readonly group: string | null;
  /** Upper-cased property name, group prefix already stripped. */
  readonly name: string;
  /** Upper-cased parameter names; a parameter may legally repeat or carry a
   * comma-separated list, so values are always an array. A bare parameter
   * with no `NAME=` (the vCard 2.1/3.0 shorthand `EMAIL;HOME;INTERNET:...`)
   * is folded into `TYPE` with its bare word as the value, which is how
   * every real-world 3.0 producer means it. */
  readonly params: ReadonlyMap<string, readonly string[]>;
  readonly value: string;
}

/** Splits one unfolded line into its optional group, name, parameters and
 * value. Returns `null` for a line with no `:` separator, which is
 * malformed and handled by the caller (preserved verbatim rather than
 * dropped, never thrown). */
export function parseContentLine(line: string): VcardContentLine | null {
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

  const rawName = (parts[0] ?? "").trim();
  const dot = rawName.lastIndexOf(".");
  const group = dot === -1 ? null : rawName.slice(0, dot);
  const name = (dot === -1 ? rawName : rawName.slice(dot + 1)).toUpperCase();

  const params = new Map<string, string[]>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals === -1) {
      // Bare vCard 2.1/3.0 shorthand type, e.g. `EMAIL;HOME:...`.
      const bareValue = decodeParamValue(part.trim());
      if (bareValue.length === 0) {
        continue;
      }
      const existing = params.get("TYPE");
      params.set(
        "TYPE",
        existing === undefined ? [bareValue] : [...existing, bareValue],
      );
      continue;
    }
    const paramName = part.slice(0, equals).trim().toUpperCase();
    const paramValues = splitParamList(part.slice(equals + 1));
    const existing = params.get(paramName);
    params.set(
      paramName,
      existing === undefined ? [...paramValues] : [...existing, ...paramValues],
    );
  }

  return { group, name, params, value };
}

export function firstParam(
  line: VcardContentLine,
  name: string,
): string | null {
  return line.params.get(name)?.[0] ?? null;
}

/** Every `TYPE` value on a line, comma-joined -- used as the free-text
 * `label` a `ContactEmail`/`ContactPhone`/`ContactPostalAddress` carries.
 * `null` when the line has no `TYPE` at all, which the caller renders as
 * no label rather than an empty string. */
export function typeLabel(line: VcardContentLine): string | null {
  const values = line.params.get("TYPE");
  if (values === undefined || values.length === 0) {
    return null;
  }
  const joined = values.join(", ").trim();
  return joined.length === 0 ? null : joined;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `YYYYMMDDTHHMMSSZ` -- the vCard/iCalendar basic UTC timestamp form, used
 * for `REV`. Takes an ISO 8601 instant (`Contact.updatedAt`'s own format)
 * rather than a `Date`, so a malformed stored timestamp fails loudly instead
 * of silently becoming `Invalid Date`. */
export function formatVcardTimestamp(isoInstant: string): string {
  const date = new Date(isoInstant);
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}` +
    `${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`
  );
}
