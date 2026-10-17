import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createAddressBookId, createContactId } from "../value-objects/ids";
import {
  createContact,
  MAX_CONTACT_DISPLAY_NAME_LENGTH,
  MAX_CONTACT_EXTRA_VCARD_BYTES,
  MAX_CONTACT_LABEL_LENGTH,
  MAX_CONTACT_LIST_LENGTH,
  updateContact,
} from "./contact";

const base = {
  id: createContactId("con-1"),
  addressBookId: createAddressBookId("book-1"),
  uid: "uid-1",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("createContact", () => {
  it("accepts a minimal contact with every optional field omitted", () => {
    const contact = createContact({ ...base, displayName: "Ada Lovelace" });
    expect(contact.displayName).toBe("Ada Lovelace");
    expect(contact.givenName).toBeNull();
    expect(contact.familyName).toBeNull();
    expect(contact.nickname).toBeNull();
    expect(contact.organization).toBeNull();
    expect(contact.title).toBeNull();
    expect(contact.emails).toEqual([]);
    expect(contact.phones).toEqual([]);
    expect(contact.postalAddresses).toEqual([]);
    expect(contact.urls).toEqual([]);
    expect(contact.note).toBeNull();
    expect(contact.birthday).toBeNull();
    expect(contact.extraVcardLines).toBeNull();
    expect(contact.updatedAt).toBe(base.createdAt);
  });

  it("trims displayName and rejects it empty", () => {
    expect(createContact({ ...base, displayName: "  Ada  " }).displayName).toBe(
      "Ada",
    );
    expect(() => createContact({ ...base, displayName: "  " })).toThrow(
      ValidationError,
    );
  });

  it("accepts displayName at the max length and rejects one over it", () => {
    const atMax = "a".repeat(MAX_CONTACT_DISPLAY_NAME_LENGTH);
    expect(createContact({ ...base, displayName: atMax }).displayName).toBe(
      atMax,
    );
    expect(() => createContact({ ...base, displayName: `${atMax}x` })).toThrow(
      ValidationError,
    );
  });

  it("normalizes emails and deduplicates case-insensitively", () => {
    const contact = createContact({
      ...base,
      displayName: "Ada",
      emails: [
        { address: "Ada@Example.com", label: "work" },
        { address: "ada@example.com" },
        { address: "ada2@example.com", label: "home" },
      ],
    });
    expect(contact.emails).toEqual([
      { address: "ada@example.com", label: "work" },
      { address: "ada2@example.com", label: "home" },
    ]);
  });

  it("rejects a malformed email address", () => {
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        emails: [{ address: "not-an-email" }],
      }),
    ).toThrow(ValidationError);
  });

  it("caps emails/phones/postalAddresses/urls at 32 entries", () => {
    const emails = Array.from({ length: MAX_CONTACT_LIST_LENGTH }, (_, i) => ({
      address: `user${i}@example.com`,
    }));
    expect(
      createContact({ ...base, displayName: "Ada", emails }).emails,
    ).toHaveLength(MAX_CONTACT_LIST_LENGTH);

    const tooMany = [...emails, { address: "overflow@example.com" }];
    expect(() =>
      createContact({ ...base, displayName: "Ada", emails: tooMany }),
    ).toThrow(ValidationError);
  });

  it("caps phones at 32 entries", () => {
    const phones = Array.from({ length: MAX_CONTACT_LIST_LENGTH }, (_, i) => ({
      number: `+1000000${i}`,
    }));
    expect(
      createContact({ ...base, displayName: "Ada", phones }).phones,
    ).toHaveLength(MAX_CONTACT_LIST_LENGTH);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        phones: [...phones, { number: "+19999999" }],
      }),
    ).toThrow(ValidationError);
  });

  it("caps postalAddresses at 32 entries", () => {
    const postalAddresses = Array.from(
      { length: MAX_CONTACT_LIST_LENGTH },
      (_, i) => ({ formatted: `${i} Main St` }),
    );
    expect(
      createContact({ ...base, displayName: "Ada", postalAddresses })
        .postalAddresses,
    ).toHaveLength(MAX_CONTACT_LIST_LENGTH);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        postalAddresses: [...postalAddresses, { formatted: "Overflow St" }],
      }),
    ).toThrow(ValidationError);
  });

  it("caps urls at 32 entries", () => {
    const urls = Array.from(
      { length: MAX_CONTACT_LIST_LENGTH },
      (_, i) => `https://example.com/${i}`,
    );
    expect(
      createContact({ ...base, displayName: "Ada", urls }).urls,
    ).toHaveLength(MAX_CONTACT_LIST_LENGTH);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        urls: [...urls, "https://example.com/overflow"],
      }),
    ).toThrow(ValidationError);
  });

  it("normalizes and deduplicates absolute http(s) urls", () => {
    const contact = createContact({
      ...base,
      displayName: "Ada",
      urls: [
        "https://example.com/a",
        "https://example.com/a",
        "http://example.com/b",
      ],
    });
    expect(contact.urls).toEqual([
      "https://example.com/a",
      "http://example.com/b",
    ]);
  });

  it("rejects a relative or non-http(s) url", () => {
    expect(() =>
      createContact({ ...base, displayName: "Ada", urls: ["/relative"] }),
    ).toThrow(ValidationError);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        urls: ["javascript:alert(1)"],
      }),
    ).toThrow(ValidationError);
  });

  it("accepts a label at the max length and rejects one over it", () => {
    const atMax = "l".repeat(MAX_CONTACT_LABEL_LENGTH);
    const contact = createContact({
      ...base,
      displayName: "Ada",
      emails: [{ address: "ada@example.com", label: atMax }],
    });
    expect(contact.emails[0]?.label).toBe(atMax);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        emails: [{ address: "ada@example.com", label: `${atMax}x` }],
      }),
    ).toThrow(ValidationError);
  });

  it("strips control characters and quotes from labels", () => {
    const contact = createContact({
      ...base,
      displayName: "Ada",
      emails: [{ address: "ada@example.com", label: 'wo"rk\r\nTEL:+1\u0000' }],
      phones: [{ number: "+1-555-0100", label: "\r\n" }],
      postalAddresses: [{ formatted: "1 Loop", label: ' "home" ' }],
    });
    expect(contact.emails[0]?.label).toBe("workTEL:+1");
    expect(contact.phones[0]?.label).toBeNull();
    expect(contact.postalAddresses[0]?.label).toBe("home");
  });

  it("rejects an empty phone number or postal address", () => {
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        phones: [{ number: "  " }],
      }),
    ).toThrow(ValidationError);
    expect(() =>
      createContact({
        ...base,
        displayName: "Ada",
        postalAddresses: [{ formatted: "  " }],
      }),
    ).toThrow(ValidationError);
  });

  it("validates birthday as a YYYY-MM-DD date", () => {
    expect(
      createContact({ ...base, displayName: "Ada", birthday: "1990-06-15" })
        .birthday,
    ).toBe("1990-06-15");
    expect(() =>
      createContact({ ...base, displayName: "Ada", birthday: "not-a-date" }),
    ).toThrow(ValidationError);
  });

  it("carries extraVcardLines through verbatim without interpretation", () => {
    const payload = "X-CUSTOM:hello\nPHOTO:data-uri-stub";
    const contact = createContact({
      ...base,
      displayName: "Ada",
      extraVcardLines: payload,
    });
    expect(contact.extraVcardLines).toBe(payload);
  });
});

describe("extraVcardLines cap", () => {
  const line = `X-FILLER:${"a".repeat(1000)}\n`;
  const lineBytes = new TextEncoder().encode(line).byteLength;

  it("keeps a payload exactly at the cap", () => {
    const filler = "a".repeat(MAX_CONTACT_EXTRA_VCARD_BYTES);
    const contact = createContact({
      ...base,
      displayName: "Ada",
      extraVcardLines: filler,
    });
    expect(contact.extraVcardLines).toBe(filler);
  });

  it("drops whole lines past the cap", () => {
    const count = Math.ceil(MAX_CONTACT_EXTRA_VCARD_BYTES / lineBytes) + 5;
    const contact = createContact({
      ...base,
      displayName: "Ada",
      extraVcardLines: line.repeat(count),
    });
    const kept = contact.extraVcardLines ?? "";
    expect(new TextEncoder().encode(kept).byteLength).toBeLessThanOrEqual(
      MAX_CONTACT_EXTRA_VCARD_BYTES,
    );
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.endsWith("\n")).toBe(true);
    expect(kept.length % line.length).toBe(0);
  });

  it("never splits a folded property", () => {
    const folded = `PHOTO:${"b".repeat(40_000)}\n ${"c".repeat(40_000)}\n`;
    const contact = createContact({
      ...base,
      displayName: "Ada",
      extraVcardLines: `X-KEEP:1\n${folded}X-DROPPED:2\n`,
    });
    // The folded PHOTO does not fit after X-KEEP, so it goes whole.
    expect(contact.extraVcardLines).toBe("X-KEEP:1\n");
  });

  it("applies the cap on update too", () => {
    const contact = createContact({ ...base, displayName: "Ada" });
    const updated = updateContact(
      contact,
      { extraVcardLines: line.repeat(200) },
      "2026-08-25T00:00:00.000Z",
    );
    expect(
      new TextEncoder().encode(updated.extraVcardLines ?? "").byteLength,
    ).toBeLessThanOrEqual(MAX_CONTACT_EXTRA_VCARD_BYTES);
  });
});

describe("updateContact", () => {
  it("leaves absent fields untouched and applies explicit nulls", () => {
    const contact = createContact({
      ...base,
      displayName: "Ada Lovelace",
      organization: "Analytical Engines Ltd",
      emails: [{ address: "ada@example.com" }],
    });
    const updated = updateContact(
      contact,
      { organization: null },
      "2026-08-25T00:00:00.000Z",
    );
    expect(updated.displayName).toBe("Ada Lovelace");
    expect(updated.organization).toBeNull();
    expect(updated.emails).toEqual(contact.emails);
    expect(updated.updatedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("re-validates through the same path as createContact", () => {
    const contact = createContact({ ...base, displayName: "Ada" });
    expect(() =>
      updateContact(contact, { displayName: "  " }, "2026-08-25T00:00:00.000Z"),
    ).toThrow(ValidationError);
  });

  it("replaces emails wholesale when provided", () => {
    const contact = createContact({
      ...base,
      displayName: "Ada",
      emails: [{ address: "old@example.com" }],
    });
    const updated = updateContact(
      contact,
      { emails: [{ address: "new@example.com" }] },
      "2026-08-25T00:00:00.000Z",
    );
    expect(updated.emails).toEqual([
      { address: "new@example.com", label: null },
    ]);
  });
});
