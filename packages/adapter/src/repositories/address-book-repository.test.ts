import type { MailPermissionFilter } from "@flying-mail/application/policies/authorization";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createAddressBook } from "@flying-mail/domain/entities/address-book";
import { createContact } from "@flying-mail/domain/entities/contact";
import { createAddressPattern } from "@flying-mail/domain/value-objects/address-pattern";
import {
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
const OTHER_DOMAIN_ID = createDomainId("dom-2");
const SUPPORT_ID = createMailAddressId("addr-support");
const SALES_ID = createMailAddressId("addr-sales");
const OTHER_DOMAIN_ADDR_ID = createMailAddressId("addr-other-domain");
const NOW = "2026-08-24T00:00:00.000Z";

let db: SqlDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: DOMAIN_ID, name: "example.com" });
  await seedDomain(db, { id: OTHER_DOMAIN_ID, name: "other.example" });
  await seedMailAddress(db, {
    id: SUPPORT_ID,
    domainId: DOMAIN_ID,
    localPart: "support",
    address: "support@example.com",
  });
  await seedMailAddress(db, {
    id: SALES_ID,
    domainId: DOMAIN_ID,
    localPart: "sales",
    address: "sales@example.com",
  });
  await seedMailAddress(db, {
    id: OTHER_DOMAIN_ADDR_ID,
    domainId: OTHER_DOMAIN_ID,
    localPart: "hello",
    address: "hello@other.example",
  });
});

describe("address book repository", () => {
  test("saves, reads and updates a book", async () => {
    const repository = createAddressBookRepository(db);
    const book = createAddressBook({
      id: createAddressBookId("book-1"),
      mailAddressId: SUPPORT_ID,
      name: "Contacts",
      createdAt: NOW,
    });
    await repository.save(book);

    expect(await repository.findById(book.id)).toEqual(book);

    await repository.save({
      ...book,
      name: "Renamed",
      description: "desc",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const updated = await repository.findById(book.id);
    expect(updated).toMatchObject({
      name: "Renamed",
      description: "desc",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
  });

  test("finds the default book for a mail address", async () => {
    const repository = createAddressBookRepository(db);
    const book = createAddressBook({
      id: createAddressBookId("book-1"),
      mailAddressId: SUPPORT_ID,
      name: "Contacts",
      isDefault: true,
      createdAt: NOW,
    });
    await repository.save(book);
    expect(await repository.findDefaultForMailAddress(SUPPORT_ID)).toEqual(
      book,
    );
    expect(await repository.findDefaultForMailAddress(SALES_ID)).toBeNull();
  });

  test("a second explicit default for the same address conflicts", async () => {
    const repository = createAddressBookRepository(db);
    await repository.save(
      createAddressBook({
        id: createAddressBookId("book-1"),
        mailAddressId: SUPPORT_ID,
        name: "Contacts",
        isDefault: true,
        createdAt: NOW,
      }),
    );
    await expect(
      repository.save(
        createAddressBook({
          id: createAddressBookId("book-2"),
          mailAddressId: SUPPORT_ID,
          name: "Another",
          isDefault: true,
          createdAt: NOW,
        }),
      ),
    ).rejects.toThrow();

    // A second non-default book for the same address is fine.
    await expect(
      repository.save(
        createAddressBook({
          id: createAddressBookId("book-3"),
          mailAddressId: SUPPORT_ID,
          name: "Also fine",
          isDefault: false,
          createdAt: NOW,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  test("lists by mail addresses, ordered by name", async () => {
    const repository = createAddressBookRepository(db);
    await repository.save(
      createAddressBook({
        id: createAddressBookId("book-zulu"),
        mailAddressId: SUPPORT_ID,
        name: "Zulu",
        createdAt: NOW,
      }),
    );
    await repository.save(
      createAddressBook({
        id: createAddressBookId("book-alpha"),
        mailAddressId: SUPPORT_ID,
        name: "Alpha",
        createdAt: NOW,
      }),
    );
    await repository.save(
      createAddressBook({
        id: createAddressBookId("book-other"),
        mailAddressId: SALES_ID,
        name: "Sales book",
        createdAt: NOW,
      }),
    );

    expect(
      (await repository.listByMailAddresses([SUPPORT_ID])).map((b) => b.name),
    ).toEqual(["Alpha", "Zulu"]);
    expect(await repository.listByMailAddresses([])).toEqual([]);
  });

  test("deleting a book cascades its contacts", async () => {
    const books = createAddressBookRepository(db);
    const bookId = createAddressBookId("book-1");
    await books.save(
      createAddressBook({
        id: bookId,
        mailAddressId: SUPPORT_ID,
        name: "Contacts",
        createdAt: NOW,
      }),
    );

    const contacts = createContactRepository(db);
    const contactId = createContactId("con-1");
    await contacts.createContact(
      createContact({
        id: contactId,
        addressBookId: bookId,
        uid: "uid-1",
        displayName: "Ada",
        createdAt: NOW,
      }),
    );

    await books.delete(bookId);
    expect(await contacts.findById(contactId)).toBeNull();
  });

  test("countContacts reflects the address book's contacts", async () => {
    const books = createAddressBookRepository(db);
    const bookId = createAddressBookId("book-1");
    await books.save(
      createAddressBook({
        id: bookId,
        mailAddressId: SUPPORT_ID,
        name: "Contacts",
        createdAt: NOW,
      }),
    );
    expect(await books.countContacts(bookId)).toBe(0);

    const contacts = createContactRepository(db);
    await contacts.createContact(
      createContact({
        id: createContactId("con-1"),
        addressBookId: bookId,
        uid: "uid-1",
        displayName: "Ada",
        createdAt: NOW,
      }),
    );
    expect(await books.countContacts(bookId)).toBe(1);
  });
});

describe("address book repository listReadable", () => {
  async function seedBooks(): Promise<{
    readonly supportBook: string;
    readonly salesBook: string;
    readonly otherDomainBook: string;
  }> {
    const books = createAddressBookRepository(db);
    const supportBook = "book-support";
    const salesBook = "book-sales";
    const otherDomainBook = "book-other-domain";
    await books.save(
      createAddressBook({
        id: createAddressBookId(supportBook),
        mailAddressId: SUPPORT_ID,
        name: "Support",
        createdAt: NOW,
      }),
    );
    await books.save(
      createAddressBook({
        id: createAddressBookId(salesBook),
        mailAddressId: SALES_ID,
        name: "Sales",
        createdAt: NOW,
      }),
    );
    await books.save(
      createAddressBook({
        id: createAddressBookId(otherDomainBook),
        mailAddressId: OTHER_DOMAIN_ADDR_ID,
        name: "Other domain",
        createdAt: NOW,
      }),
    );
    return { supportBook, salesBook, otherDomainBook };
  }

  test("ADMIN baseline sees every book", async () => {
    const { supportBook, salesBook, otherDomainBook } = await seedBooks();
    const repository = createAddressBookRepository(db);
    const filter: MailPermissionFilter = { baseline: true, rules: [] };
    const readable = await repository.listReadable({
      allowedPatterns: null,
      mailPermissionFilter: filter,
    });
    expect(readable.map((b) => b.id).sort()).toEqual(
      [supportBook, salesBook, otherDomainBook].sort(),
    );
  });

  test("MEMBER sees only ALLOW-scoped addresses", async () => {
    const { supportBook } = await seedBooks();
    const repository = createAddressBookRepository(db);
    const filter: MailPermissionFilter = {
      baseline: false,
      rules: [
        {
          effect: "ALLOW",
          domainId: null,
          addressPattern: createAddressPattern("support@example.com"),
        },
      ],
    };
    const readable = await repository.listReadable({
      allowedPatterns: null,
      mailPermissionFilter: filter,
    });
    expect(readable.map((b) => b.id)).toEqual([supportBook]);
  });

  test("VIEWER with no ALLOW rule sees nothing", async () => {
    await seedBooks();
    const repository = createAddressBookRepository(db);
    const filter: MailPermissionFilter = { baseline: false, rules: [] };
    const readable = await repository.listReadable({
      allowedPatterns: null,
      mailPermissionFilter: filter,
    });
    expect(readable).toEqual([]);
  });

  test("a DENY rule hides a book even under an ADMIN baseline", async () => {
    const { salesBook, otherDomainBook } = await seedBooks();
    const repository = createAddressBookRepository(db);
    const filter: MailPermissionFilter = {
      baseline: true,
      rules: [
        {
          effect: "DENY",
          domainId: null,
          addressPattern: createAddressPattern("support@example.com"),
        },
      ],
    };
    const readable = await repository.listReadable({
      allowedPatterns: null,
      mailPermissionFilter: filter,
    });
    expect(readable.map((b) => b.id).sort()).toEqual(
      [salesBook, otherDomainBook].sort(),
    );
  });

  test("an API-key allowlist scopes to matching addresses", async () => {
    const { supportBook } = await seedBooks();
    const repository = createAddressBookRepository(db);
    const readable = await repository.listReadable({
      allowedPatterns: [createAddressPattern("support@example.com")],
      mailPermissionFilter: null,
    });
    expect(readable.map((b) => b.id)).toEqual([supportBook]);
  });

  test("an empty API-key allowlist sees nothing", async () => {
    await seedBooks();
    const repository = createAddressBookRepository(db);
    const readable = await repository.listReadable({
      allowedPatterns: [],
      mailPermissionFilter: null,
    });
    expect(readable).toEqual([]);
  });

  test("mailAddressIds narrows the candidate set", async () => {
    const { supportBook } = await seedBooks();
    const repository = createAddressBookRepository(db);
    const readable = await repository.listReadable({
      mailAddressIds: [SUPPORT_ID],
      allowedPatterns: null,
      mailPermissionFilter: { baseline: true, rules: [] },
    });
    expect(readable.map((b) => b.id)).toEqual([supportBook]);
  });
});
