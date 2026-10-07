import { createContact } from "@flying-mail/domain/entities/contact";
import {
  createAddressBookId,
  createContactId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { createVcardCodec } from "./vcard-codec";
import {
  escapeText,
  foldLine,
  unescapeText,
  unfoldLines,
} from "./vcard-format";

const BOOK_ID = createAddressBookId("book-1");
const NOW = "2026-08-24T00:00:00.000Z";

describe("vcard folding and escaping", () => {
  test("foldLine leaves short lines untouched", () => {
    expect(foldLine("FN:Ada Lovelace")).toBe("FN:Ada Lovelace");
  });

  test("foldLine wraps at 75 octets with a leading space continuation", () => {
    const longValue = "x".repeat(200);
    const folded = foldLine(`NOTE:${longValue}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(" ")).toBe(true);
    }
    // Unfolding recovers the exact original content.
    expect(unfoldLines(folded)).toEqual([`NOTE:${longValue}`]);
  });

  test("foldLine never splits a multi-byte character", () => {
    const longValue = "\u{1F600}".repeat(60); // emoji, 4 octets each in UTF-8
    const folded = foldLine(`NOTE:${longValue}`);
    expect(unfoldLines(folded)).toEqual([`NOTE:${longValue}`]);
  });

  test("unfoldLines tolerates a tab continuation and bare LF", () => {
    const raw = "NOTE:hello\n\tworld";
    expect(unfoldLines(raw)).toEqual(["NOTE:helloworld"]);
  });

  test("escapeText/unescapeText round-trip commas, semicolons, backslashes and newlines", () => {
    const original = 'a,b;c\\d\ne "quoted"';
    const escaped = escapeText(original);
    expect(escaped).not.toContain("\n");
    expect(unescapeText(escaped)).toBe(original.replace("\n", "\n"));
  });
});

describe("vcard codec round-trip", () => {
  test("own output survives a parse round-trip for every modeled field", () => {
    const codec = createVcardCodec();
    const contact = createContact({
      id: createContactId("con-1"),
      addressBookId: BOOK_ID,
      uid: "con-1@mailcal",
      displayName: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      nickname: "Ada",
      organization: "Analytical Engines, Inc.",
      title: "Mathematician",
      emails: [
        { address: "ada@example.com", label: "work" },
        { address: "ada.home@example.com", label: "home" },
      ],
      phones: [{ number: "+1-555-0100", label: "mobile" }],
      postalAddresses: [
        { formatted: "1 Infinite Loop, Cupertino, CA", label: "office" },
      ],
      urls: ["https://example.com/ada"],
      note: "Loves;commas,and\nnewlines",
      birthday: "1990-01-01",
      createdAt: NOW,
    });

    const vcard = codec.formatVcard(contact);
    expect(vcard).toContain("BEGIN:VCARD\r\n");
    expect(vcard).toContain("VERSION:3.0\r\n");
    expect(vcard.endsWith("END:VCARD\r\n")).toBe(true);

    const parsed = codec.parseVcard(vcard);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      uid: contact.uid,
      displayName: contact.displayName,
      givenName: contact.givenName,
      familyName: contact.familyName,
      nickname: contact.nickname,
      organization: contact.organization,
      title: contact.title,
      note: contact.note,
      birthday: contact.birthday,
      unparsable: false,
    });
    expect(parsed?.emails).toEqual([
      { address: "ada@example.com", label: "work" },
      { address: "ada.home@example.com", label: "home" },
    ]);
    expect(parsed?.phones).toEqual([
      { number: "+1-555-0100", label: "mobile" },
    ]);
    expect(parsed?.postalAddresses).toEqual([
      { formatted: "1 Infinite Loop, Cupertino, CA", label: "office" },
    ]);
    expect(parsed?.urls).toEqual(["https://example.com/ada"]);
    // REV is regenerated from updatedAt every format, not modeled -- so it
    // must never leak into extraVcardLines.
    expect(parsed?.extraVcardLines).toBeNull();
  });

  test("extraVcardLines round-trips unchanged through format and parse", () => {
    const codec = createVcardCodec();
    const contact = createContact({
      id: createContactId("con-1"),
      addressBookId: BOOK_ID,
      uid: "con-1@mailcal",
      displayName: "Someone",
      extraVcardLines: "X-CUSTOM:hello world\nPHOTO;ENCODING=b;TYPE=JPEG:AAAA",
      createdAt: NOW,
    });

    const vcard = codec.formatVcard(contact);
    expect(vcard).toContain("X-CUSTOM:hello world");
    expect(vcard).toContain("PHOTO;ENCODING=b;TYPE=JPEG:AAAA");

    const parsed = codec.parseVcard(vcard);
    const extraLines = (parsed?.extraVcardLines ?? "").split("\n");
    expect(extraLines).toContain("X-CUSTOM:hello world");
    expect(extraLines).toContain("PHOTO;ENCODING=b;TYPE=JPEG:AAAA");
  });
});

describe("vcard codec parsing real-world fixtures", () => {
  test("parses a minimal 4.0 card", () => {
    const codec = createVcardCodec();
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:abc-123",
      "FN:Jane Doe",
      "N:Doe;Jane;;;",
      "EMAIL;TYPE=work:jane@example.com",
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed).toMatchObject({
      uid: "urn:uuid:abc-123",
      displayName: "Jane Doe",
      givenName: "Jane",
      familyName: "Doe",
      unparsable: false,
    });
    expect(parsed?.emails).toEqual([
      { address: "jane@example.com", label: "work" },
    ]);
  });

  test("preserves iCloud-shaped grouped item1.EMAIL/item1.X-ABLABEL verbatim", () => {
    const codec = createVcardCodec();
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "N:Appleseed;John;;;",
      "FN:John Appleseed",
      "item1.EMAIL;type=INTERNET;type=pref:john@example.com",
      "item1.X-ABLabel:_$!<Other>!$_",
      "ADR;type=HOME;type=pref:;;1 Infinite Loop;Cupertino;CA;95014;USA",
      "PHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=",
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed).not.toBeNull();
    // The grouped EMAIL is never modeled as a real email address.
    expect(parsed?.emails).toEqual([]);
    expect(parsed?.postalAddresses).toEqual([
      {
        formatted: "1 Infinite Loop, Cupertino, CA, 95014, USA",
        label: "HOME, pref",
      },
    ]);
    const extraLines = (parsed?.extraVcardLines ?? "").split("\n");
    expect(extraLines).toContain(
      "item1.EMAIL;type=INTERNET;type=pref:john@example.com",
    );
    expect(extraLines).toContain("item1.X-ABLabel:_$!<Other>!$_");
    expect(extraLines).toContain("PHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=");

    // Re-formatting still carries the grouped lines and photo forward.
    const contact = createContact({
      id: createContactId("con-1"),
      addressBookId: BOOK_ID,
      uid: "con-1@mailcal",
      displayName: parsed?.displayName ?? "unused",
      extraVcardLines: parsed?.extraVcardLines ?? null,
      createdAt: NOW,
    });
    const reFormatted = codec.formatVcard(contact);
    expect(reFormatted).toContain(
      "item1.EMAIL;type=INTERNET;type=pref:john@example.com",
    );
    expect(reFormatted).toContain("PHOTO;ENCODING=b;TYPE=JPEG:aGVsbG8=");
  });

  test("preserves a folded ADR verbatim as an extra line when unrecognized due to grouping", () => {
    const codec = createVcardCodec();
    const longStreet = "Street Name ".repeat(10).trim();
    const foldedAdr = foldLine(
      `item1.ADR;type=HOME;type=pref:;;${longStreet};Cupertino;CA;95014;USA`,
    );
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Folded Address",
      foldedAdr,
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed).not.toBeNull();
    expect(parsed?.postalAddresses).toEqual([]);
    expect(parsed?.extraVcardLines).toContain(longStreet);
  });

  test("bare vCard 3.0 type parameters (no TYPE=) are folded into a label", () => {
    const codec = createVcardCodec();
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Legacy Card",
      "TEL;HOME;VOICE:+1-555-0199",
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed?.phones).toEqual([
      { number: "+1-555-0199", label: "HOME, VOICE" },
    ]);
  });

  test("a TEL value with a tel: URI scheme is stripped", () => {
    const codec = createVcardCodec();
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:URI Phone",
      "TEL;VALUE=uri:tel:+1-555-0100",
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed?.phones).toEqual([{ number: "+1-555-0100", label: null }]);
  });
});

describe("vcard codec malformed input", () => {
  test("returns null when BEGIN:VCARD is missing entirely", () => {
    const codec = createVcardCodec();
    expect(codec.parseVcard("FN:No begin\r\nEND:VCARD\r\n")).toBeNull();
  });

  test("returns null when END:VCARD is missing entirely", () => {
    const codec = createVcardCodec();
    expect(codec.parseVcard("BEGIN:VCARD\r\nFN:No end\r\n")).toBeNull();
  });

  test("returns null for garbage input, never throws", () => {
    const codec = createVcardCodec();
    expect(() => codec.parseVcard("not a vcard at all")).not.toThrow();
    expect(codec.parseVcard("not a vcard at all")).toBeNull();
  });

  test("falls back to an email or a placeholder when FN and N are both absent", () => {
    const codec = createVcardCodec();
    const withEmail = codec.parseVcard(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:only@example.com\r\nEND:VCARD\r\n",
    );
    expect(withEmail?.displayName).toBe("only@example.com");

    const withNothing = codec.parseVcard(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n",
    );
    expect(withNothing?.displayName).toBe("(no name)");
  });

  test("an unparseable BDAY is preserved as an extra line rather than dropped", () => {
    const codec = createVcardCodec();
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bad Birthday",
      "BDAY:not-a-date",
      "END:VCARD",
    ].join("\r\n");

    const parsed = codec.parseVcard(vcard);
    expect(parsed?.birthday).toBeNull();
    expect(parsed?.extraVcardLines).toContain("BDAY");
    expect(parsed?.extraVcardLines).toContain("not-a-date");
  });
});
