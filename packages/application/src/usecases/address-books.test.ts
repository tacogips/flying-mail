import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createMailAddressId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import {
  BILLING_ADDRESS,
  type ContactFixture,
  contactKeyViewer,
  mailOnlyKeyViewer,
  NOW,
  seedContactFixture,
  SUPPORT_ADDRESS,
} from "../test-support/contact-fixtures";
import { createFakeDependencies } from "../test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

/** The contact authorization matrix, exercised through `listAddressBooks`/
 * `createAddressBook` rather than the policy functions directly -- what
 * matters is that a denied read surfaces as an empty list (never an error)
 * and a denied write as the right error. */

let usecases: UseCases;
let fixture: ContactFixture;

beforeEach(async () => {
  const fake = createFakeDependencies({ now: NOW });
  usecases = createUseCases(fake.deps);
  fixture = await seedContactFixture(fake);
});

describe("listAddressBooks: role matrix", () => {
  test("ADMIN sees every book by baseline", async () => {
    const viewer = adminViewer();
    const books = await usecases.listAddressBooks(viewer);
    expect(books.map((book) => book.id)).toEqual([fixture.addressBookId]);
  });

  test("a mail DENY on the address hides the book even from an ADMIN", async () => {
    const viewer = adminViewer(
      "usr-admin",
      buildMailPermissions(createUserId("usr-admin"), [
        {
          effect: "DENY",
          domainId: fixture.domainId,
          addressPattern: SUPPORT_ADDRESS,
        },
      ]),
    );
    const books = await usecases.listAddressBooks(viewer);
    expect(books).toEqual([]);
  });

  test("MEMBER with a matching mail ALLOW sees the book", async () => {
    const viewer = memberViewer(
      "usr-1",
      buildMailPermissions(createUserId("usr-1"), [
        {
          effect: "ALLOW",
          domainId: fixture.domainId,
          addressPattern: SUPPORT_ADDRESS,
        },
      ]),
    );
    const books = await usecases.listAddressBooks(viewer);
    expect(books.map((book) => book.id)).toEqual([fixture.addressBookId]);
  });

  test("MEMBER with no matching rule sees nothing", async () => {
    const viewer = memberViewer("usr-1", []);
    expect(await usecases.listAddressBooks(viewer)).toEqual([]);
  });

  test("VIEWER with a matching mail ALLOW can read but never write", async () => {
    const viewer = viewerViewer(
      "usr-1",
      buildMailPermissions(createUserId("usr-1"), [
        {
          effect: "ALLOW",
          domainId: fixture.domainId,
          addressPattern: SUPPORT_ADDRESS,
        },
      ]),
    );
    expect((await usecases.listAddressBooks(viewer)).length).toBe(1);
    await expect(
      usecases.updateAddressBook(viewer, fixture.addressBookId, {
        name: "Renamed",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an API key with CONTACT_READ sees the matching address's book only", async () => {
    const key = contactKeyViewer([Capability.ContactRead]);
    const books = await usecases.listAddressBooks(key);
    expect(books.map((book) => book.id)).toEqual([fixture.addressBookId]);

    const wrongAddress = contactKeyViewer(
      [Capability.ContactRead],
      BILLING_ADDRESS,
    );
    expect(await usecases.listAddressBooks(wrongAddress)).toEqual([]);
  });

  test("a mail-only API key sees no address book at all", async () => {
    expect(await usecases.listAddressBooks(mailOnlyKeyViewer())).toEqual([]);
  });

  test("listAddressBooks(mailAddressId) returns [] rather than throwing when unauthorized", async () => {
    const viewer = memberViewer("usr-1", []);
    expect(
      await usecases.listAddressBooks(viewer, fixture.supportMailAddressId),
    ).toEqual([]);
  });
});

describe("createAddressBook", () => {
  test("requires contact write on the owning address", async () => {
    const reader = viewerViewer(
      "usr-1",
      buildMailPermissions(createUserId("usr-1"), [
        {
          effect: "ALLOW",
          domainId: fixture.domainId,
          addressPattern: SUPPORT_ADDRESS,
        },
      ]),
    );
    await expect(
      usecases.createAddressBook(reader, {
        mailAddressId: fixture.supportMailAddressId,
        name: "Personal",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("creates a non-default book alongside the seeded default", async () => {
    const admin = adminViewer();
    const book = await usecases.createAddressBook(admin, {
      mailAddressId: fixture.supportMailAddressId,
      name: "Vendors",
    });
    expect(book.isDefault).toBe(false);
    expect(
      (await usecases.listAddressBooks(admin, fixture.supportMailAddressId))
        .length,
    ).toBe(2);
  });

  test("a second explicit default conflicts with the seeded one", async () => {
    const admin = adminViewer();
    await expect(
      usecases.createAddressBook(admin, {
        mailAddressId: fixture.supportMailAddressId,
        name: "Also default",
        isDefault: true,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("an unknown mail address is NOT_FOUND", async () => {
    const admin = adminViewer();
    await expect(
      usecases.createAddressBook(admin, {
        mailAddressId: createMailAddressId("addr-missing"),
        name: "Nowhere",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateAddressBook / deleteAddressBook", () => {
  test("updates and hard-deletes a book, cascading its contacts", async () => {
    const admin = adminViewer();
    const updated = await usecases.updateAddressBook(
      admin,
      fixture.addressBookId,
      { name: "Renamed" },
    );
    expect(updated.name).toBe("Renamed");

    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });
    expect(await usecases.getContact(admin, contact.id)).not.toBeNull();

    expect(await usecases.deleteAddressBook(admin, fixture.addressBookId)).toBe(
      true,
    );
    expect(await usecases.getContact(admin, contact.id)).toBeNull();
  });

  test("a bystander gets NOT_FOUND, never FORBIDDEN, on write", async () => {
    const bystander = memberViewer("usr-1", []);
    await expect(
      usecases.updateAddressBook(bystander, fixture.addressBookId, {
        name: "Stolen",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("input validation surface", () => {
  test("createContact without addressBookId or mailAddressId is BAD_USER_INPUT", async () => {
    await expect(
      usecases.createContact(adminViewer(), { displayName: "Nobody" }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });
});
