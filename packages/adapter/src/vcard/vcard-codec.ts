import type {
  ParsedVcardContact,
  ParsedVcardEmail,
  ParsedVcardPhone,
  ParsedVcardPostalAddress,
  VcardCodec,
} from "@flying-mail/application/ports/vcard-codec";
import type { Contact } from "@flying-mail/domain/entities/contact";
import {
  encodeParamValue,
  escapeText,
  foldLine,
  formatVcardTimestamp,
  parseContentLine,
  splitEscaped,
  typeLabel,
  unescapeText,
  unfoldLines,
  type VcardContentLine,
} from "./vcard-format";

/** RFC 6350 (4.0) / RFC 2426 (3.0) subset codec. `UID FN N NICKNAME ORG
 * TITLE EMAIL TEL ADR URL NOTE BDAY` are modeled; `VERSION`/`REV` are
 * recognized and consumed (their value is never carried into
 * `extraVcardLines`) but not modeled on `Contact` -- `REV` is instead
 * re-derived from `Contact.updatedAt` on format. Every other line,
 * including any line carrying a `group.` prefix such as iCloud's
 * `item1.EMAIL`/`item1.X-ABLABEL` pairing, is preserved verbatim for
 * round-trip fidelity rather than modeled -- see the design doc's "vCard
 * fidelity" section. */

const SUPPORTED_PROPERTIES = new Set([
  "UID",
  "FN",
  "N",
  "NICKNAME",
  "ORG",
  "TITLE",
  "EMAIL",
  "TEL",
  "ADR",
  "URL",
  "NOTE",
  "BDAY",
]);

/** Properties this codec recognizes structurally but never models or
 * preserves: the card is regenerated with a fresh `VERSION`/`REV` on every
 * `formatVcard`, so keeping the remote's own values in `extraVcardLines`
 * would just re-emit a stale timestamp. */
const CONSUMED_PROPERTIES = new Set(["VERSION", "REV"]);

const BDAY_PATTERN = /^(\d{4})-?(\d{2})-?(\d{2})$/;

function parseBday(value: string): string | null {
  const match = BDAY_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

interface CollectedLines {
  readonly byName: ReadonlyMap<string, readonly VcardContentLine[]>;
  readonly extraLines: readonly string[];
}

/** Splits the card body into modeled property lines (grouped by name, in
 * document order) and everything this codec does not model, which is kept
 * as the raw unfolded text it will be folded back from on `formatVcard`. */
function collectLines(body: readonly string[]): CollectedLines {
  const byName = new Map<string, VcardContentLine[]>();
  const extraLines: string[] = [];

  for (const raw of body) {
    const line = parseContentLine(raw);
    if (line === null) {
      // Malformed within the body (no `:`): kept verbatim rather than
      // dropped, matching every other "cannot model this" case.
      if (raw.trim().length > 0) {
        extraLines.push(raw);
      }
      continue;
    }
    if (line.group !== null) {
      // A grouped line is never modeled, regardless of its property name --
      // see the module doc.
      extraLines.push(raw);
      continue;
    }
    if (CONSUMED_PROPERTIES.has(line.name)) {
      continue;
    }
    if (!SUPPORTED_PROPERTIES.has(line.name)) {
      extraLines.push(raw);
      continue;
    }
    const bucket = byName.get(line.name);
    if (bucket === undefined) {
      byName.set(line.name, [line]);
    } else {
      bucket.push(line);
    }
  }

  return { byName, extraLines };
}

function single(
  byName: ReadonlyMap<string, readonly VcardContentLine[]>,
  name: string,
): VcardContentLine | null {
  return byName.get(name)?.[0] ?? null;
}

function parseName(line: VcardContentLine | null): {
  readonly givenName: string | null;
  readonly familyName: string | null;
} {
  if (line === null) {
    return { givenName: null, familyName: null };
  }
  const components = splitEscaped(line.value, ";");
  const family = unescapeText(components[0] ?? "").trim();
  const given = unescapeText(components[1] ?? "").trim();
  return {
    familyName: family.length === 0 ? null : family,
    givenName: given.length === 0 ? null : given,
  };
}

function parseOrganization(line: VcardContentLine | null): string | null {
  if (line === null) {
    return null;
  }
  const first = splitEscaped(line.value, ";")[0] ?? "";
  const text = unescapeText(first).trim();
  return text.length === 0 ? null : text;
}

function parseEmails(
  lines: readonly VcardContentLine[],
): readonly ParsedVcardEmail[] {
  const emails: ParsedVcardEmail[] = [];
  for (const line of lines) {
    const address = unescapeText(line.value).trim();
    if (address.length === 0) {
      continue;
    }
    emails.push({ address, label: typeLabel(line) });
  }
  return emails;
}

function parsePhones(
  lines: readonly VcardContentLine[],
): readonly ParsedVcardPhone[] {
  const phones: ParsedVcardPhone[] = [];
  for (const line of lines) {
    // TEL values are frequently `tel:+1-555-0100` (a URI) under VALUE=uri;
    // the scheme carries no information `ContactPhone.number` needs.
    const number = unescapeText(line.value).replace(/^tel:/i, "").trim();
    if (number.length === 0) {
      continue;
    }
    phones.push({ number, label: typeLabel(line) });
  }
  return phones;
}

/** `ADR`'s seven components (`PO Box;Extended;Street;Locality;Region;
 * PostalCode;Country`) collapse into `ContactPostalAddress.formatted`,
 * which has no structure of its own -- every non-empty component is
 * joined in RFC order, comma-separated, into one readable line. */
function parsePostalAddresses(
  lines: readonly VcardContentLine[],
): readonly ParsedVcardPostalAddress[] {
  const addresses: ParsedVcardPostalAddress[] = [];
  for (const line of lines) {
    const components = splitEscaped(line.value, ";")
      .map((component) => unescapeText(component).trim())
      .filter((component) => component.length > 0);
    if (components.length === 0) {
      continue;
    }
    addresses.push({
      formatted: components.join(", "),
      label: typeLabel(line),
    });
  }
  return addresses;
}

function parseUrls(lines: readonly VcardContentLine[]): readonly string[] {
  const urls: string[] = [];
  for (const line of lines) {
    const url = unescapeText(line.value).trim();
    if (url.length > 0) {
      urls.push(url);
    }
  }
  return urls;
}

/** Locates the first well-formed `BEGIN:VCARD` ... `END:VCARD` pair. `null`
 * when neither is found at all -- the caller reports that as fully
 * unparsable, distinct from a pair that parses but models nothing. */
function extractCardBody(lines: readonly string[]): readonly string[] | null {
  let beginIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().toUpperCase() === "BEGIN:VCARD") {
      beginIndex = index;
      break;
    }
  }
  if (beginIndex === -1) {
    return null;
  }
  for (let index = beginIndex + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim().toUpperCase() === "END:VCARD") {
      return lines.slice(beginIndex + 1, index);
    }
  }
  return null;
}

function fallbackDisplayName(
  byName: ReadonlyMap<string, readonly VcardContentLine[]>,
  givenName: string | null,
  familyName: string | null,
): string {
  const fromName = [givenName, familyName].filter((part) => part !== null);
  if (fromName.length > 0) {
    return fromName.join(" ");
  }
  const firstEmail = single(byName, "EMAIL");
  if (firstEmail !== null) {
    const address = unescapeText(firstEmail.value).trim();
    if (address.length > 0) {
      return address;
    }
  }
  return "(no name)";
}

function parseVcard(vcard: string): ParsedVcardContact | null {
  const body = extractCardBody(unfoldLines(vcard));
  if (body === null) {
    return null;
  }

  const { byName, extraLines } = collectLines(body);

  const uidLine = single(byName, "UID");
  const uid = uidLine === null ? "" : unescapeText(uidLine.value).trim();

  const { givenName, familyName } = parseName(single(byName, "N"));

  const fnLine = single(byName, "FN");
  const fnValue = fnLine === null ? "" : unescapeText(fnLine.value).trim();
  const displayName =
    fnValue.length > 0
      ? fnValue
      : fallbackDisplayName(byName, givenName, familyName);

  const nicknameLine = single(byName, "NICKNAME");
  const nickname =
    nicknameLine === null
      ? null
      : (() => {
          const text = unescapeText(nicknameLine.value).trim();
          return text.length === 0 ? null : text;
        })();

  const titleLine = single(byName, "TITLE");
  const title =
    titleLine === null
      ? null
      : (() => {
          const text = unescapeText(titleLine.value).trim();
          return text.length === 0 ? null : text;
        })();

  const noteLine = single(byName, "NOTE");
  const note =
    noteLine === null
      ? null
      : (() => {
          const text = unescapeText(noteLine.value).trim();
          return text.length === 0 ? null : text;
        })();

  const finalExtraLines = [...extraLines];
  const bdayLine = single(byName, "BDAY");
  const birthday =
    bdayLine === null ? null : parseBday(unescapeText(bdayLine.value));
  if (bdayLine !== null && birthday === null) {
    // Recognized but unparseable: keep the data rather than drop it.
    finalExtraLines.push(
      `BDAY${[...bdayLine.params.entries()]
        .map(([name, values]) => `;${name}=${values.join(",")}`)
        .join("")}:${bdayLine.value}`,
    );
  }

  return {
    uid,
    displayName,
    givenName,
    familyName,
    nickname,
    organization: parseOrganization(single(byName, "ORG")),
    title,
    emails: parseEmails(byName.get("EMAIL") ?? []),
    phones: parsePhones(byName.get("TEL") ?? []),
    postalAddresses: parsePostalAddresses(byName.get("ADR") ?? []),
    urls: parseUrls(byName.get("URL") ?? []),
    note,
    birthday,
    extraVcardLines:
      finalExtraLines.length === 0 ? null : finalExtraLines.join("\n"),
    unparsable: false,
  };
}

// -- format -------------------------------------------------------------

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

function labelParams(
  label: string | null,
): readonly (readonly [string, string])[] {
  return label === null ? [] : [["TYPE", label]];
}

function formatVcard(contact: Contact): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0"];

  if (contact.uid.length > 0) {
    lines.push(textProperty("UID", contact.uid));
  }
  lines.push(textProperty("FN", contact.displayName));
  if (contact.givenName !== null || contact.familyName !== null) {
    lines.push(
      property(
        "N",
        [
          escapeText(contact.familyName ?? ""),
          escapeText(contact.givenName ?? ""),
          "",
          "",
          "",
        ].join(";"),
      ),
    );
  }
  if (contact.nickname !== null) {
    lines.push(textProperty("NICKNAME", contact.nickname));
  }
  if (contact.organization !== null) {
    lines.push(textProperty("ORG", contact.organization));
  }
  if (contact.title !== null) {
    lines.push(textProperty("TITLE", contact.title));
  }
  for (const email of contact.emails) {
    lines.push(
      property("EMAIL", escapeText(email.address), labelParams(email.label)),
    );
  }
  for (const phone of contact.phones) {
    lines.push(
      property("TEL", escapeText(phone.number), labelParams(phone.label)),
    );
  }
  for (const address of contact.postalAddresses) {
    // No structured components to reconstruct (see `ContactPostalAddress`),
    // so the whole formatted string is carried in the "street" component --
    // the slot every real-world reader (including this codec) treats as
    // free text when the other components are empty.
    lines.push(
      property(
        "ADR",
        ["", "", escapeText(address.formatted), "", "", "", ""].join(";"),
        labelParams(address.label),
      ),
    );
  }
  for (const url of contact.urls) {
    lines.push(property("URL", escapeText(url)));
  }
  if (contact.note !== null) {
    lines.push(textProperty("NOTE", contact.note));
  }
  if (contact.birthday !== null) {
    lines.push(property("BDAY", contact.birthday));
  }
  lines.push(property("REV", formatVcardTimestamp(contact.updatedAt)));

  if (contact.extraVcardLines !== null) {
    for (const raw of contact.extraVcardLines.split("\n")) {
      if (raw.length > 0) {
        lines.push(foldLine(raw));
      }
    }
  }

  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}

export function createVcardCodec(): VcardCodec {
  return { parseVcard, formatVcard };
}
