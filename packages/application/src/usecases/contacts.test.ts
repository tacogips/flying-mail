import { Capability } from "@flying-mail/domain/entities/api-key";
import { createCarddavAccount } from "@flying-mail/domain/entities/carddav-account";
import {
  createCarddavAccountId,
  createCarddavBookId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { NotFoundError } from "../errors";
import {
  type ContactFixture,
  contactKeyViewer,
  NOW,
  seedContactFixture,
} from "../test-support/contact-fixtures";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

let fake: FakeDependencies;
let usecases: UseCases;
let fixture: ContactFixture;

beforeEach(async () => {
  fake = createFakeDependencies({ now: NOW });
  usecases = createUseCases(fake.deps);
  fixture = await seedContactFixture(fake);
});

describe("createContact: default-book auto-creation", () => {
  test("with no addressBookId, creates the address's default book named 'Contacts' on first use", async () => {
    const admin = adminViewer();
    const contact = await usecases.createContact(admin, {
      mailAddressId: fixture.billingMailAddressId,
      displayName: "Grace Hopper",
    });
    const books = await usecases.listAddressBooks(
      admin,
      fixture.billingMailAddressId,
    );
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ name: "Contacts", isDefault: true });
    expect(contact.addressBookId).toBe(books[0]?.id);
  });

  test("a second createContact with no addressBookId reuses the same default book", async () => {
    const admin = adminViewer();
    const first = await usecases.createContact(admin, {
      mailAddressId: fixture.billingMailAddressId,
      displayName: "Grace Hopper",
    });
    const second = await usecases.createContact(admin, {
      mailAddressId: fixture.billingMailAddressId,
      displayName: "Alan Turing",
    });
    expect(second.addressBookId).toBe(first.addressBookId);
    const books = await usecases.listAddressBooks(
      admin,
      fixture.billingMailAddressId,
    );
    expect(books).toHaveLength(1);
  });

  test("the seeded default book on the support address is used directly, no new book created", async () => {
    const admin = adminViewer();
    await usecases.createContact(admin, {
      mailAddressId: fixture.supportMailAddressId,
      displayName: "Ada Lovelace",
    });
    const books = await usecases.listAddressBooks(
      admin,
      fixture.supportMailAddressId,
    );
    expect(books).toHaveLength(1);
    expect(books[0]?.id).toBe(fixture.addressBookId);
  });

  test("requires contact write on the target address", async () => {
    const bystander = memberViewer("usr-1", []);
    await expect(
      usecases.createContact(bystander, {
        mailAddressId: fixture.supportMailAddressId,
        displayName: "Nobody",
      }),
    ).rejects.toThrow();
  });
});

describe("listContacts: cross-address merged view and pagination", () => {
  test("omitting both id filters merges every readable address's contacts", async () => {
    const admin = adminViewer();
    await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });
    await usecases.createContact(admin, {
      mailAddressId: fixture.billingMailAddressId,
      displayName: "Grace Hopper",
    });

    const page = await usecases.listContacts(admin, {});
    expect(page.totalCount).toBe(2);
    expect(page.nodes.map((contact) => contact.displayName).sort()).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
    ]);
  });

  test("a viewer restricted to one address never sees the other address's contacts", async () => {
    const admin = adminViewer();
    await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });
    await usecases.createContact(admin, {
      mailAddressId: fixture.billingMailAddressId,
      displayName: "Grace Hopper",
    });

    const scoped = memberViewer(
      "usr-1",
      buildMailPermissions(createUserId("usr-1"), [
        {
          effect: "ALLOW",
          domainId: fixture.domainId,
          addressPattern: "support@example.com",
        },
      ]),
    );
    const page = await usecases.listContacts(scoped, {});
    expect(page.nodes.map((contact) => contact.displayName)).toEqual([
      "Ada Lovelace",
    ]);
  });

  test("paginates with a cursor across a merged listing", async () => {
    const admin = adminViewer();
    for (const name of ["Charlie", "Alice", "Bob"]) {
      await usecases.createContact(admin, {
        addressBookId: fixture.addressBookId,
        displayName: name,
      });
    }
    const firstPage = await usecases.listContacts(admin, { first: 2 });
    expect(firstPage.nodes.map((contact) => contact.displayName)).toEqual([
      "Alice",
      "Bob",
    ]);
    const cursor = firstPage.nextCursor;
    if (cursor === null) {
      throw new Error("expected a next cursor after the first page");
    }

    const secondPage = await usecases.listContacts(admin, {
      first: 2,
      after: cursor,
    });
    expect(secondPage.nodes.map((contact) => contact.displayName)).toEqual([
      "Charlie",
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.totalCount).toBe(3);
  });

  test("an addressBookIds filter silently drops books the viewer cannot read", async () => {
    const bystander = memberViewer("usr-1", []);
    const page = await usecases.listContacts(bystander, {
      addressBookIds: [fixture.addressBookId],
    });
    expect(page).toEqual({ nodes: [], nextCursor: null, totalCount: 0 });
  });
});

describe("getContact / updateContact: NOT_FOUND vs FORBIDDEN", () => {
  test("a bystander gets NOT_FOUND on read and on write", async () => {
    const admin = adminViewer();
    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });

    const bystander = memberViewer("usr-1", []);
    expect(await usecases.getContact(bystander, contact.id)).toBeNull();
    await expect(
      usecases.updateContact(bystander, contact.id, { displayName: "Stolen" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("updates modeled fields", async () => {
    const admin = adminViewer();
    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
      emails: [{ address: "ada@example.com" }],
    });
    const updated = await usecases.updateContact(admin, contact.id, {
      organization: "Analytical Engines Ltd",
    });
    expect(updated.organization).toBe("Analytical Engines Ltd");
    expect(updated.displayName).toBe("Ada Lovelace");
  });
});

describe("deleteContact: CardDAV tombstone only when linked", () => {
  test("deleting a contact in an unlinked book records no tombstone", async () => {
    const admin = adminViewer();
    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });
    expect(await usecases.deleteContact(admin, contact.id)).toBe(true);
    expect(fake.contactStores.carddavDeletions.size).toBe(0);
  });

  test("deleting a CardDAV-linked contact records a tombstone for its href", async () => {
    const admin = adminViewer();
    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });

    const account = createCarddavAccount({
      id: createCarddavAccountId("cda-1"),
      userId: createUserId("usr-admin"),
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      passwordCiphertext: "fake:secret",
      createdAt: NOW,
    });
    await fake.deps.carddavAccountRepository.saveAccount(account);
    const linkId = createCarddavBookId("cdl-1");
    await fake.deps.carddavAccountRepository.saveBookLink({
      id: linkId,
      accountId: account.id,
      addressBookId: fixture.addressBookId,
      remoteUrl: "https://contacts.icloud.com/1/carddavhome/card/",
      displayName: null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    });
    await fake.deps.carddavAccountRepository.saveContactState({
      contactId: contact.id,
      carddavBookId: linkId,
      href: "https://contacts.icloud.com/1/carddavhome/card/ada.vcf",
      etag: '"etag-1"',
      lastSyncedAt: NOW,
      remoteUnsupported: false,
    });

    expect(await usecases.deleteContact(admin, contact.id)).toBe(true);
    const deletions =
      await fake.deps.carddavAccountRepository.listDeletions(linkId);
    expect(deletions).toHaveLength(1);
    expect(deletions[0]?.href).toBe(
      "https://contacts.icloud.com/1/carddavhome/card/ada.vcf",
    );
    expect(
      await fake.deps.carddavAccountRepository.findContactState(contact.id),
    ).toBeNull();
  });
});

describe("lookupContactsByEmail: viewer-scoped", () => {
  test("finds a contact by a normalized email match, restricted to readable books", async () => {
    const admin = adminViewer();
    await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
      emails: [{ address: "Ada@Example.com" }],
    });

    const found = await usecases.lookupContactsByEmail(
      admin,
      "ada@example.com",
    );
    expect(found.map((contact) => contact.displayName)).toEqual([
      "Ada Lovelace",
    ]);

    const bystander = memberViewer("usr-1", []);
    expect(
      await usecases.lookupContactsByEmail(bystander, "ada@example.com"),
    ).toEqual([]);
  });

  test("an API key scoped to CONTACT_READ finds the match too", async () => {
    const admin = adminViewer();
    await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
      emails: [{ address: "ada@example.com" }],
    });
    const key = contactKeyViewer([Capability.ContactRead]);
    const found = await usecases.lookupContactsByEmail(key, "ada@example.com");
    expect(found).toHaveLength(1);
  });
});
