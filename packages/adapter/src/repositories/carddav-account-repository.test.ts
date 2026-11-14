import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createAddressBook } from "@flying-mail/domain/entities/address-book";
import {
  type CarddavAccount,
  createCarddavAccount,
} from "@flying-mail/domain/entities/carddav-account";
import { createContact } from "@flying-mail/domain/entities/contact";
import {
  createAddressBookId,
  createCarddavAccountId,
  createCarddavBookId,
  createContactId,
  createDomainId,
  createMailAddressId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createAddressBookRepository } from "./address-book-repository";
import { createCarddavAccountRepository } from "./carddav-account-repository";
import { createContactRepository } from "./contact-repository";
import {
  createMigratedDatabase,
  seedDomain,
  seedMailAddress,
  seedUser,
} from "./test-support";

const USER_ID = createUserId("usr-1");
const OTHER_USER_ID = createUserId("usr-2");
const MAIL_ADDRESS_ID = createMailAddressId("addr-1");
const BOOK_ID = createAddressBookId("book-1");
const NOW = "2026-08-24T00:00:00.000Z";

let db: SqlDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedUser(db, { id: USER_ID, email: "owner@example.com" });
  await seedUser(db, { id: OTHER_USER_ID, email: "other@example.com" });
  await seedDomain(db, { id: createDomainId("dom-1"), name: "example.com" });
  await seedMailAddress(db, {
    id: MAIL_ADDRESS_ID,
    domainId: createDomainId("dom-1"),
    localPart: "support",
    address: "support@example.com",
  });
  await createAddressBookRepository(db).save(
    createAddressBook({
      id: BOOK_ID,
      mailAddressId: MAIL_ADDRESS_ID,
      name: "Contacts",
      createdAt: NOW,
    }),
  );
});

function account(id: string, userId = USER_ID): CarddavAccount {
  return createCarddavAccount({
    id: createCarddavAccountId(id),
    userId,
    serverUrl: "https://contacts.icloud.com/",
    username: "taco@example.com",
    passwordCiphertext: "ciphertext",
    createdAt: NOW,
  });
}

describe("carddav account repository", () => {
  test("saves, reads and lists accounts by user", async () => {
    const repository = createCarddavAccountRepository(db);
    const acc = account("acc-1");
    await repository.saveAccount(acc);

    expect(await repository.findAccountById(acc.id)).toEqual(acc);
    expect(
      (await repository.listAccountsByUser(USER_ID)).map((a) => a.id),
    ).toEqual([acc.id]);
    expect(await repository.listAccountsByUser(OTHER_USER_ID)).toEqual([]);

    const updated = createCarddavAccount({
      id: acc.id,
      userId: USER_ID,
      serverUrl: acc.serverUrl,
      username: acc.username,
      passwordCiphertext: "new-ciphertext",
      principalUrl: "https://contacts.icloud.com/1234/principal/",
      homeSetUrl: "https://contacts.icloud.com/1234/carddavhome/",
      createdAt: NOW,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    await repository.saveAccount(updated);
    expect(await repository.findAccountById(acc.id)).toEqual(updated);
  });

  test("book link CRUD honors both unique indexes", async () => {
    const repository = createCarddavAccountRepository(db);
    const acc = account("acc-1");
    await repository.saveAccount(acc);

    const linkId = createCarddavBookId("link-1");
    await repository.saveBookLink({
      id: linkId,
      accountId: acc.id,
      addressBookId: BOOK_ID,
      remoteUrl: "https://contacts.icloud.com/1234/carddavhome/card/",
      displayName: "Contacts",
      ctag: "ctag-1",
      syncToken: null,
      lastSyncedAt: null,
    });

    expect(await repository.findBookLinkById(linkId)).toMatchObject({
      id: linkId,
      accountId: acc.id,
      addressBookId: BOOK_ID,
    });
    expect(await repository.findBookLinkByAddressBook(BOOK_ID)).toMatchObject({
      id: linkId,
    });
    expect(
      (await repository.listBookLinksByAccount(acc.id)).map((l) => l.id),
    ).toEqual([linkId]);

    // Same (account_id, remote_url) again conflicts.
    await expect(
      repository.saveBookLink({
        id: createCarddavBookId("link-2"),
        accountId: acc.id,
        addressBookId: createAddressBookId("book-does-not-matter"),
        remoteUrl: "https://contacts.icloud.com/1234/carddavhome/card/",
        displayName: null,
        ctag: null,
        syncToken: null,
        lastSyncedAt: null,
      }),
    ).rejects.toThrow();

    // Same (address_book_id, account_id) again also conflicts.
    await expect(
      repository.saveBookLink({
        id: createCarddavBookId("link-3"),
        accountId: acc.id,
        addressBookId: BOOK_ID,
        remoteUrl: "https://contacts.icloud.com/1234/carddavhome/other/",
        displayName: null,
        ctag: null,
        syncToken: null,
        lastSyncedAt: null,
      }),
    ).rejects.toThrow();

    await repository.deleteBookLink(linkId);
    expect(await repository.findBookLinkById(linkId)).toBeNull();
  });

  test("contact state upsert and lookup by href", async () => {
    const repository = createCarddavAccountRepository(db);
    const acc = account("acc-1");
    await repository.saveAccount(acc);
    const linkId = createCarddavBookId("link-1");
    await repository.saveBookLink({
      id: linkId,
      accountId: acc.id,
      addressBookId: BOOK_ID,
      remoteUrl: "https://contacts.icloud.com/1234/carddavhome/card/",
      displayName: null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    });
    const contactId = createContactId("con-1");
    await createContactRepository(db).createContact(
      createContact({
        id: contactId,
        addressBookId: BOOK_ID,
        uid: "con-1@mailcal",
        displayName: "Ada",
        createdAt: NOW,
      }),
    );

    await repository.saveContactState({
      contactId,
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/con-1.vcf",
      etag: '"etag-1"',
      lastSyncedAt: NOW,
      remoteUnsupported: false,
    });

    expect(await repository.findContactState(contactId)).toMatchObject({
      contactId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/con-1.vcf",
      etag: '"etag-1"',
    });
    expect(
      await repository.findContactStateByHref(
        linkId,
        "https://contacts.icloud.com/1234/carddavhome/card/con-1.vcf",
      ),
    ).toMatchObject({ contactId });
    expect(
      (await repository.listContactStates(linkId)).map((s) => s.contactId),
    ).toEqual([contactId]);

    await repository.saveContactState({
      contactId,
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/con-1.vcf",
      etag: '"etag-2"',
      lastSyncedAt: NOW,
      remoteUnsupported: true,
    });
    expect(await repository.findContactState(contactId)).toMatchObject({
      etag: '"etag-2"',
      remoteUnsupported: true,
    });

    await repository.deleteContactState(contactId);
    expect(await repository.findContactState(contactId)).toBeNull();
  });

  test("tombstones can be added, listed and removed", async () => {
    const repository = createCarddavAccountRepository(db);
    const acc = account("acc-1");
    await repository.saveAccount(acc);
    const linkId = createCarddavBookId("link-1");
    await repository.saveBookLink({
      id: linkId,
      accountId: acc.id,
      addressBookId: BOOK_ID,
      remoteUrl: "https://contacts.icloud.com/1234/carddavhome/card/",
      displayName: null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    });

    await repository.addDeletion({
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/gone.vcf",
      etag: '"etag-x"',
      deletedAt: NOW,
    });
    expect((await repository.listDeletions(linkId)).map((d) => d.href)).toEqual(
      ["https://contacts.icloud.com/1234/carddavhome/card/gone.vcf"],
    );

    await repository.removeDeletion(
      linkId,
      "https://contacts.icloud.com/1234/carddavhome/card/gone.vcf",
    );
    expect(await repository.listDeletions(linkId)).toEqual([]);
  });

  test("deleting an account cascades book links, states and tombstones but not local data", async () => {
    const repository = createCarddavAccountRepository(db);
    const acc = account("acc-1");
    await repository.saveAccount(acc);
    const linkId = createCarddavBookId("link-1");
    await repository.saveBookLink({
      id: linkId,
      accountId: acc.id,
      addressBookId: BOOK_ID,
      remoteUrl: "https://contacts.icloud.com/1234/carddavhome/card/",
      displayName: null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    });
    const contactId = createContactId("con-1");
    const contacts = createContactRepository(db);
    await contacts.createContact(
      createContact({
        id: contactId,
        addressBookId: BOOK_ID,
        uid: "con-1@mailcal",
        displayName: "Ada",
        createdAt: NOW,
      }),
    );
    await repository.saveContactState({
      contactId,
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/con-1.vcf",
      etag: '"etag-1"',
      lastSyncedAt: NOW,
      remoteUnsupported: false,
    });
    await repository.addDeletion({
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1234/carddavhome/card/gone.vcf",
      etag: null,
      deletedAt: NOW,
    });

    await repository.deleteAccount(acc.id);

    expect(await repository.findAccountById(acc.id)).toBeNull();
    expect(await repository.findBookLinkById(linkId)).toBeNull();
    expect(await repository.findContactState(contactId)).toBeNull();
    expect(await repository.listDeletions(linkId)).toEqual([]);

    // The local address book and its contact are untouched.
    expect(
      await createAddressBookRepository(db).findById(BOOK_ID),
    ).not.toBeNull();
    expect(await contacts.findById(contactId)).not.toBeNull();
  });
});
