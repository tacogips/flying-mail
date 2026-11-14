import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createAddressBookId, createMailAddressId } from "../value-objects/ids";
import {
  createAddressBook,
  MAX_ADDRESS_BOOK_DESCRIPTION_LENGTH,
  MAX_ADDRESS_BOOK_NAME_LENGTH,
  updateAddressBook,
} from "./address-book";

const base = {
  id: createAddressBookId("book-1"),
  mailAddressId: createMailAddressId("addr-1"),
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("createAddressBook", () => {
  it("trims the name and defaults description/isDefault", () => {
    const book = createAddressBook({ ...base, name: "  Contacts  " });
    expect(book.name).toBe("Contacts");
    expect(book.description).toBeNull();
    expect(book.isDefault).toBe(false);
    expect(book.updatedAt).toBe(base.createdAt);
  });

  it("rejects an empty name", () => {
    expect(() => createAddressBook({ ...base, name: "  " })).toThrow(
      ValidationError,
    );
  });

  it("accepts a name at the max length and rejects one over it", () => {
    const atMax = "a".repeat(MAX_ADDRESS_BOOK_NAME_LENGTH);
    expect(createAddressBook({ ...base, name: atMax }).name).toBe(atMax);
    expect(() => createAddressBook({ ...base, name: `${atMax}x` })).toThrow(
      ValidationError,
    );
  });

  it("rejects a description over the max length", () => {
    expect(() =>
      createAddressBook({
        ...base,
        name: "Contacts",
        description: "a".repeat(MAX_ADDRESS_BOOK_DESCRIPTION_LENGTH + 1),
      }),
    ).toThrow(ValidationError);
  });

  it("stores an explicit isDefault", () => {
    const book = createAddressBook({
      ...base,
      name: "Contacts",
      isDefault: true,
    });
    expect(book.isDefault).toBe(true);
  });
});

describe("updateAddressBook", () => {
  it("leaves absent fields untouched and applies an explicit null description", () => {
    const book = createAddressBook({
      ...base,
      name: "Contacts",
      description: "Work rolodex",
      isDefault: true,
    });
    const updated = updateAddressBook(
      book,
      { description: null },
      "2026-08-25T00:00:00.000Z",
    );
    expect(updated.name).toBe("Contacts");
    expect(updated.description).toBeNull();
    expect(updated.isDefault).toBe(true);
    expect(updated.updatedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("re-validates through the same path as createAddressBook", () => {
    const book = createAddressBook({ ...base, name: "Contacts" });
    expect(() =>
      updateAddressBook(book, { name: "  " }, "2026-08-25T00:00:00.000Z"),
    ).toThrow(ValidationError);
  });
});
