import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createAddressBook } from "@flying-mail/domain/entities/address-book";
import {
  type Contact,
  createContact,
} from "@flying-mail/domain/entities/contact";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  type AddressBookId,
  createAddressBookId,
  createContactId,
  createDomainId,
  createMailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createAddressBookRepository } from "./address-book-repository";
import { createContactRepository } from "./contact-repository";
import {
  createMigratedDatabase,
  seedDomain,
  seedMailAddress,
} from "./test-support";

const DOMAIN_ID = createDomainId("dom-1");
const MAIL_ADDRESS_ID = createMailAddressId("addr-1");
const OTHER_MAIL_ADDRESS_ID = createMailAddressId("addr-2");
const NOW = "2026-08-24T00:00:00.000Z";

let db: SqlDatabase;
let bookId: AddressBookId;
let otherBookId: AddressBookId;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: DOMAIN_ID, name: "example.com" });
  await seedMailAddress(db, {
    id: MAIL_ADDRESS_ID,
    domainId: DOMAIN_ID,
    localPart: "support",
    address: "support@example.com",
  });
  await seedMailAddress(db, {
    id: OTHER_MAIL_ADDRESS_ID,
    domainId: DOMAIN_ID,
    localPart: "sales",
    address: "sales@example.com",
  });
  const books = createAddressBookRepository(db);
  bookId = createAddressBookId("book-1");
  otherBookId = createAddressBookId("book-2");
  await books.save(
    createAddressBook({
      id: bookId,
      mailAddressId: MAIL_ADDRESS_ID,
      name: "Contacts",
      createdAt: NOW,
    }),
  );
  await books.save(
    createAddressBook({
      id: otherBookId,
      mailAddressId: OTHER_MAIL_ADDRESS_ID,
      name: "Sales contacts",
      createdAt: NOW,
    }),
  );
});

function fullContact(
  id: string,
  overrides: Partial<Parameters<typeof createContact>[0]> = {},
): Contact {
  return createContact({
    id: createContactId(id),
    addressBookId: bookId,
    uid: `${id}@mailcal`,
    displayName: `Contact ${id}`,
    givenName: "Ada",
    familyName: "Lovelace",
    nickname: "Ada",
    organization: "Analytical Engines Inc",
    title: "Engineer",
    emails: [
      { address: "ada@example.com", label: "work" },
      { address: "ada.home@example.com", label: "home" },
    ],
    phones: [{ number: "+1-555-0100", label: "mobile" }],
    postalAddresses: [{ formatted: "1 Infinite Loop", label: "office" }],
    urls: ["https://example.com/ada"],
    note: "A note",
    birthday: "1990-01-01",
    extraVcardLines: "X-CUSTOM:value",
    createdAt: NOW,
    ...overrides,
  });
}

describe("contact repository", () => {
  test("writes the contact and every child table in one batch and reads them back", async () => {
    const repository = createContactRepository(db);
    const contact = fullContact("con-1");
    await repository.createContact(contact);

    const loaded = await repository.findById(contact.id);
    expect(loaded).toEqual(contact);
  });

  test("updateContact fully replaces the child rows rather than merging", async () => {
    const repository = createContactRepository(db);
    const contact = fullContact("con-1");
    await repository.createContact(contact);

    const updated = createContact({
      id: contact.id,
      addressBookId: bookId,
      uid: contact.uid,
      displayName: "Updated Name",
      emails: [{ address: "new@example.com" }],
      createdAt: contact.createdAt,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    await repository.updateContact(updated);

    const loaded = await repository.findById(contact.id);
    expect(loaded).toEqual(updated);
    expect(loaded?.phones).toEqual([]);
    expect(loaded?.emails).toEqual([
      { address: createEmailAddress("new@example.com"), label: null },
    ]);
  });

  test("findByUid looks up by (addressBookId, uid)", async () => {
    const repository = createContactRepository(db);
    const contact = fullContact("con-1");
    await repository.createContact(contact);

    expect(await repository.findByUid(bookId, contact.uid)).toEqual(contact);
    expect(await repository.findByUid(otherBookId, contact.uid)).toBeNull();
    expect(await repository.findByUid(bookId, "no-such-uid")).toBeNull();
  });

  test("deleting a contact cascades its child rows", async () => {
    const repository = createContactRepository(db);
    const contact = fullContact("con-1");
    await repository.createContact(contact);
    await repository.deleteContact(contact.id);

    expect(await repository.findById(contact.id)).toBeNull();
    const emailRows = await db.query(
      "SELECT * FROM contact_emails WHERE contact_id = ?",
      [contact.id],
    );
    expect(emailRows).toEqual([]);
  });

  test("deleting an address book cascades its contacts", async () => {
    const books = createAddressBookRepository(db);
    const repository = createContactRepository(db);
    const contact = fullContact("con-1");
    await repository.createContact(contact);

    await books.delete(bookId);
    expect(await repository.findById(contact.id)).toBeNull();
  });

  test("listByAddressBook orders by display name", async () => {
    const repository = createContactRepository(db);
    await repository.createContact(
      fullContact("con-zulu", { displayName: "Zulu" }),
    );
    await repository.createContact(
      fullContact("con-alpha", { displayName: "Alpha" }),
    );
    await repository.createContact(
      createContact({
        id: createContactId("con-other-book"),
        addressBookId: otherBookId,
        uid: "other@mailcal",
        displayName: "Other book contact",
        createdAt: NOW,
      }),
    );

    const listed = await repository.listByAddressBook(bookId);
    expect(listed.map((c) => c.displayName)).toEqual(["Alpha", "Zulu"]);
  });

  test("listByEmail finds a contact across address books by its indexed email", async () => {
    const repository = createContactRepository(db);
    await repository.createContact(fullContact("con-1"));
    await repository.createContact(
      createContact({
        id: createContactId("con-2"),
        addressBookId: otherBookId,
        uid: "con-2@mailcal",
        displayName: "Other match",
        emails: [{ address: "ada@example.com" }],
        createdAt: NOW,
      }),
    );
    await repository.createContact(
      createContact({
        id: createContactId("con-3"),
        addressBookId: otherBookId,
        uid: "con-3@mailcal",
        displayName: "No match",
        emails: [{ address: "someone-else@example.com" }],
        createdAt: NOW,
      }),
    );

    const found = await repository.listByEmail(
      createEmailAddress("ada@example.com"),
      [bookId, otherBookId],
    );
    expect(found.map((c) => c.id).sort()).toEqual(["con-1", "con-2"].sort());

    // Restricting to one book narrows the match.
    const restricted = await repository.listByEmail(
      createEmailAddress("ada@example.com"),
      [bookId],
    );
    expect(restricted.map((c) => c.id)).toEqual(["con-1"]);

    expect(
      await repository.listByEmail(createEmailAddress("ada@example.com"), []),
    ).toEqual([]);
  });
});

describe("contact repository listPage", () => {
  async function seedMany(count: number): Promise<void> {
    const repository = createContactRepository(db);
    for (let index = 0; index < count; index += 1) {
      const label = String(index).padStart(3, "0");
      await repository.createContact(
        createContact({
          id: createContactId(`con-${label}`),
          addressBookId: bookId,
          uid: `con-${label}@mailcal`,
          displayName: `Contact ${label}`,
          organization: index % 2 === 0 ? "Acme" : "Globex",
          emails: index === 0 ? [{ address: "special@example.com" }] : [],
          createdAt: NOW,
        }),
      );
    }
  }

  test("paginates with a stable cursor across pages", async () => {
    await seedMany(5);
    const repository = createContactRepository(db);

    const page1 = await repository.listPage({
      addressBookIds: [bookId],
      first: 2,
    });
    expect(page1.nodes.map((c) => c.displayName)).toEqual([
      "Contact 000",
      "Contact 001",
    ]);
    expect(page1.totalCount).toBe(5);
    expect(page1.nextCursor).not.toBeNull();

    const cursor1 = page1.nextCursor;
    if (cursor1 === null) {
      throw new Error("expected a next cursor after page 1");
    }
    const page2 = await repository.listPage({
      addressBookIds: [bookId],
      first: 2,
      after: cursor1,
    });
    expect(page2.nodes.map((c) => c.displayName)).toEqual([
      "Contact 002",
      "Contact 003",
    ]);

    const cursor2 = page2.nextCursor;
    if (cursor2 === null) {
      throw new Error("expected a next cursor after page 2");
    }
    const page3 = await repository.listPage({
      addressBookIds: [bookId],
      first: 2,
      after: cursor2,
    });
    expect(page3.nodes.map((c) => c.displayName)).toEqual(["Contact 004"]);
    expect(page3.nextCursor).toBeNull();
  });

  test("query matches display name, organization and email substrings", async () => {
    await seedMany(5);
    const repository = createContactRepository(db);

    const byName = await repository.listPage({
      addressBookIds: [bookId],
      first: 10,
      query: "Contact 002",
    });
    expect(byName.nodes.map((c) => c.displayName)).toEqual(["Contact 002"]);

    const byOrg = await repository.listPage({
      addressBookIds: [bookId],
      first: 10,
      query: "Globex",
    });
    expect(byOrg.totalCount).toBe(2);

    const byEmail = await repository.listPage({
      addressBookIds: [bookId],
      first: 10,
      query: "special@",
    });
    expect(byEmail.nodes.map((c) => c.displayName)).toEqual(["Contact 000"]);
  });

  test("email filters to an exact address match", async () => {
    await seedMany(3);
    const repository = createContactRepository(db);
    const page = await repository.listPage({
      addressBookIds: [bookId],
      first: 10,
      email: createEmailAddress("special@example.com"),
    });
    expect(page.nodes.map((c) => c.displayName)).toEqual(["Contact 000"]);
  });

  test("scopes to only the given address books", async () => {
    await seedMany(2);
    const repository = createContactRepository(db);
    await repository.createContact(
      createContact({
        id: createContactId("con-other"),
        addressBookId: otherBookId,
        uid: "other@mailcal",
        displayName: "Other book",
        createdAt: NOW,
      }),
    );
    const page = await repository.listPage({
      addressBookIds: [bookId],
      first: 10,
    });
    expect(page.nodes.every((c) => c.addressBookId === bookId)).toBe(true);
    expect(page.totalCount).toBe(2);
  });
});
