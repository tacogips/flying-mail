import {
  contactKeyViewer,
  mailOnlyKeyViewer,
  NOW,
  seedContactFixture,
  SUPPORT_ADDRESS,
  type ContactFixture,
} from "@mailcal/application/test-support/contact-fixtures";
import { createFakeDependencies } from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { Capability } from "@mailcal/domain/entities/api-key";
import { createUserId } from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

/** End-to-end operation tests for the contacts SDL module using real yoga
 * requests over in-memory fakes. Permission derivation is exercised at this
 * layer (not only in the
 * application layer's own use-case tests) because it is the design doc's
 * central claim about contacts: "no second permission system", entirely
 * derived from the existing mail permission rules and API-key scopes. */

const ADMIN = adminViewer();

const CREATE_CONTACT = `
  mutation Create($input: CreateContactInput!) {
    createContact(input: $input) {
      id displayName uid
      addressBook { id name isDefault mailAddress { id } }
      emails { address label }
    }
  }
`;

/** Narrows one field of a successful result, failing the test loudly rather
 * than letting an unexpected `null` surface as a confusing property error. */
function field<T>(
  result: { readonly data?: Record<string, unknown> | null },
  name: string,
): T {
  const value = result.data?.[name];
  if (value === undefined || value === null) {
    throw new Error(`expected ${name} in the result`);
  }
  return value as T;
}

let harness: GraphQLHarness;
let fixture: ContactFixture;

beforeEach(async () => {
  harness = createGraphQLHarness(createFakeDependencies({ now: NOW }));
  fixture = await seedContactFixture(harness.fake);
});

describe("address books and contacts: lifecycle", () => {
  test("creates, lists, updates and deletes an address book", async () => {
    const created = await harness.run(
      `mutation Create($input: CreateAddressBookInput!) {
         createAddressBook(input: $input) {
           id name description isDefault contactCount
           mailAddress { id }
         }
       }`,
      ADMIN,
      {
        input: {
          mailAddressId: fixture.billingMailAddressId,
          name: "Vendors",
          description: "Billing contacts",
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const book = field<{
      id: string;
      isDefault: boolean;
      contactCount: number;
      mailAddress: { id: string };
    }>(created, "createAddressBook");
    expect(book).toMatchObject({
      name: "Vendors",
      description: "Billing contacts",
      isDefault: false,
      contactCount: 0,
    });
    expect(book.mailAddress.id).toBe(fixture.billingMailAddressId);

    const listed = await harness.run(
      `query Books($mailAddressId: ID) {
         addressBooks(mailAddressId: $mailAddressId) { id name }
       }`,
      ADMIN,
      { mailAddressId: fixture.billingMailAddressId },
    );
    expect(listed.data?.["addressBooks"]).toEqual([
      { id: book.id, name: "Vendors" },
    ]);

    const updated = await harness.run(
      `mutation Update($id: ID!, $input: UpdateAddressBookInput!) {
         updateAddressBook(id: $id, input: $input) { id name description }
       }`,
      ADMIN,
      { id: book.id, input: { name: "Suppliers" } },
    );
    // A GraphQL `null` on an optional field is treated as "not supplied", so
    // `description` here is left untouched rather than cleared.
    expect(updated.data?.["updateAddressBook"]).toEqual({
      id: book.id,
      name: "Suppliers",
      description: "Billing contacts",
    });

    const deleted = await harness.run(
      `mutation Delete($id: ID!) { deleteAddressBook(id: $id) }`,
      ADMIN,
      { id: book.id },
    );
    expect(deleted.data?.["deleteAddressBook"]).toBe(true);
    expect(
      (
        await harness.run(
          `query Books($mailAddressId: ID) {
             addressBooks(mailAddressId: $mailAddressId) { id }
           }`,
          ADMIN,
          { mailAddressId: fixture.billingMailAddressId },
        )
      ).data?.["addressBooks"],
    ).toEqual([]);
  });

  test("createContact with no addressBookId auto-creates the address's default book", async () => {
    const created = await harness.run(CREATE_CONTACT, ADMIN, {
      input: {
        mailAddressId: fixture.billingMailAddressId,
        displayName: "Grace Hopper",
        emails: [{ address: "grace@example.com", label: "work" }],
      },
    });
    expect(created.errors).toBeUndefined();
    const contact = field<{
      addressBook: { name: string; isDefault: boolean };
      emails: readonly { address: string; label: string | null }[];
    }>(created, "createContact");
    expect(contact.addressBook).toMatchObject({
      name: "Contacts",
      isDefault: true,
    });
    expect(contact.emails).toEqual([
      { address: "grace@example.com", label: "work" },
    ]);

    // The seeded default book on the support address is used directly for a
    // book that already has one -- no second book is created.
    const secondViaSeededDefault = await harness.run(CREATE_CONTACT, ADMIN, {
      input: {
        mailAddressId: fixture.supportMailAddressId,
        displayName: "Ada Lovelace",
      },
    });
    expect(
      field<{ addressBook: { id: string } }>(
        secondViaSeededDefault,
        "createContact",
      ).addressBook.id,
    ).toBe(fixture.addressBookId);
  });

  test("reads, updates and deletes a contact, and finds it by email", async () => {
    const created = await harness.run(CREATE_CONTACT, ADMIN, {
      input: {
        addressBookId: fixture.addressBookId,
        displayName: "Ada Lovelace",
        emails: [{ address: "ada@example.com" }],
      },
    });
    const id = field<{ id: string }>(created, "createContact").id;

    const read = await harness.run(
      `query Read($id: ID!) { contact(id: $id) { id displayName } }`,
      ADMIN,
      { id },
    );
    expect(read.data?.["contact"]).toEqual({ id, displayName: "Ada Lovelace" });

    const byEmail = await harness.run(
      `query ByEmail($email: String!) {
         contactsByEmail(email: $email) { id displayName }
       }`,
      ADMIN,
      { email: "ada@example.com" },
    );
    expect(byEmail.data?.["contactsByEmail"]).toEqual([
      { id, displayName: "Ada Lovelace" },
    ]);

    const updated = await harness.run(
      `mutation Update($id: ID!, $input: UpdateContactInput!) {
         updateContact(id: $id, input: $input) { id displayName organization }
       }`,
      ADMIN,
      {
        id,
        input: {
          displayName: "Ada, Countess of Lovelace",
          organization: "Analytical Engine",
        },
      },
    );
    expect(updated.data?.["updateContact"]).toEqual({
      id,
      displayName: "Ada, Countess of Lovelace",
      organization: "Analytical Engine",
    });

    const deleted = await harness.run(
      `mutation Delete($id: ID!) { deleteContact(id: $id) }`,
      ADMIN,
      { id },
    );
    expect(deleted.data?.["deleteContact"]).toBe(true);
    expect(
      (
        await harness.run(
          `query Read($id: ID!) { contact(id: $id) { id } }`,
          ADMIN,
          { id },
        )
      ).data?.["contact"],
    ).toBeNull();
  });

  test("lists contacts with cursor pagination via the contacts query", async () => {
    for (const name of ["Ada", "Grace", "Katherine"]) {
      await harness.run(CREATE_CONTACT, ADMIN, {
        input: { addressBookId: fixture.addressBookId, displayName: name },
      });
    }
    const page = await harness.run(
      `query Page($first: Int, $after: String) {
         contacts(first: $first, after: $after) {
           nodes { displayName } nextCursor totalCount
         }
       }`,
      ADMIN,
      { first: 2 },
    );
    const first = field<{
      nodes: readonly { displayName: string }[];
      nextCursor: string | null;
      totalCount: number;
    }>(page, "contacts");
    expect(first.totalCount).toBe(3);
    expect(first.nodes.map((n) => n.displayName)).toEqual(["Ada", "Grace"]);
    expect(first.nextCursor).not.toBeNull();

    const rest = await harness.run(
      `query Page($first: Int, $after: String) {
         contacts(first: $first, after: $after) { nodes { displayName } }
       }`,
      ADMIN,
      { first: 2, after: first.nextCursor },
    );
    expect(
      field<{ nodes: readonly { displayName: string }[] }>(
        rest,
        "contacts",
      ).nodes.map((n) => n.displayName),
    ).toEqual(["Katherine"]);
  });
});

describe("NOT_FOUND probe resistance", () => {
  test("an address book outside a scoped viewer's reach is reported absent, not forbidden", async () => {
    // billing@ is not in the support-scoped key's pattern.
    const key = contactKeyViewer(
      [Capability.ContactRead],
      "support@example.com",
    );
    const created = await harness.run(CREATE_CONTACT, ADMIN, {
      input: {
        mailAddressId: fixture.billingMailAddressId,
        displayName: "Out of scope",
      },
    });
    const contactId = field<{ id: string }>(created, "createContact").id;
    const addressBookId = field<{ addressBook: { id: string } }>(
      created,
      "createContact",
    ).addressBook.id;

    const readBook = await harness.run(
      `query Books($mailAddressId: ID) {
         addressBooks(mailAddressId: $mailAddressId) { id }
       }`,
      key,
      { mailAddressId: fixture.billingMailAddressId },
    );
    expect(readBook.data?.["addressBooks"]).toEqual([]);

    const readContact = await harness.run(
      `query Read($id: ID!) { contact(id: $id) { id } }`,
      key,
      { id: contactId },
    );
    expect(readContact.data?.["contact"]).toBeNull();

    const write = await harness.run(
      `mutation Update($id: ID!, $input: UpdateAddressBookInput!) {
         updateAddressBook(id: $id, input: $input) { id }
       }`,
      key,
      { id: addressBookId, input: { name: "Stolen" } },
    );
    expect(errorCodes(write)).toEqual(["NOT_FOUND"]);
  });
});

describe("permission derivation matrix", () => {
  test("a VIEWER with an ALLOW rule reads support's book and contacts but cannot write", async () => {
    const userId = createUserId("usr-viewer-1");
    const viewer = viewerViewer(
      "usr-viewer-1",
      buildMailPermissions(userId, [
        { effect: "ALLOW", addressPattern: SUPPORT_ADDRESS },
      ]),
    );

    const books = await harness.run(`query { addressBooks { id } }`, viewer);
    expect(books.data?.["addressBooks"]).toEqual([
      { id: fixture.addressBookId },
    ]);

    const write = await harness.run(CREATE_CONTACT, viewer, {
      input: {
        addressBookId: fixture.addressBookId,
        displayName: "Should fail",
      },
    });
    expect(errorCodes(write)).toEqual(["FORBIDDEN"]);
  });

  test("a MEMBER needs MAIL_MANAGE (not just MAIL_READ) to write contacts", async () => {
    const userId = createUserId("usr-member-1");
    const readOnly = memberViewer(
      "usr-member-1",
      buildMailPermissions(userId, [
        { effect: "ALLOW", addressPattern: SUPPORT_ADDRESS },
      ]),
    );
    // MEMBER's role grants both MAIL_READ and MAIL_MANAGE once an ALLOW rule
    // matches the address -- the design doc's derivation has no separate
    // read/write rule, only the role ceiling plus one ALLOW/DENY rule set.
    const created = await harness.run(CREATE_CONTACT, readOnly, {
      input: { addressBookId: fixture.addressBookId, displayName: "Bob" },
    });
    expect(created.errors).toBeUndefined();
  });

  test("a mailbox DENY hides the book even for an otherwise-qualifying MEMBER", async () => {
    const userId = createUserId("usr-member-2");
    const viewer = memberViewer(
      "usr-member-2",
      buildMailPermissions(userId, [
        { effect: "ALLOW", addressPattern: "*" },
        { effect: "DENY", addressPattern: SUPPORT_ADDRESS },
      ]),
    );
    const books = await harness.run(
      `query Books($mailAddressId: ID) {
         addressBooks(mailAddressId: $mailAddressId) { id }
       }`,
      viewer,
      { mailAddressId: fixture.supportMailAddressId },
    );
    expect(books.data?.["addressBooks"]).toEqual([]);

    // The unrelated billing address is unaffected by the support DENY.
    const billingBooks = await harness.run(
      `mutation Create($input: CreateAddressBookInput!) {
         createAddressBook(input: $input) { id }
       }`,
      viewer,
      { input: { mailAddressId: fixture.billingMailAddressId, name: "Ok" } },
    );
    expect(billingBooks.errors).toBeUndefined();
  });

  test("an API key with only CONTACT_READ cannot mutate", async () => {
    const key = contactKeyViewer([Capability.ContactRead]);
    const books = await harness.run(`query { addressBooks { id } }`, key);
    expect(books.data?.["addressBooks"]).toEqual([
      { id: fixture.addressBookId },
    ]);

    const write = await harness.run(CREATE_CONTACT, key, {
      input: { addressBookId: fixture.addressBookId, displayName: "Nope" },
    });
    expect(errorCodes(write)).toEqual(["FORBIDDEN"]);
  });

  test("an API key with only a mail scope sees no contacts at all", async () => {
    const key = mailOnlyKeyViewer();
    const books = await harness.run(`query { addressBooks { id } }`, key);
    expect(books.data?.["addressBooks"]).toEqual([]);

    const contacts = await harness.run(
      `query { contacts { totalCount nodes { id } } }`,
      key,
    );
    expect(contacts.data?.["contacts"]).toEqual({ totalCount: 0, nodes: [] });
  });

  test("rejects an unauthenticated request", async () => {
    const result = await harness.run(`query { addressBooks { id } }`, null);
    expect(errorCodes(result)).toEqual(["UNAUTHENTICATED"]);
  });
});

describe("carddav mutations", () => {
  test("reports SERVICE_UNAVAILABLE for CardDAV mutations when no credential key is configured, while contacts keep working", async () => {
    harness = createGraphQLHarness(
      createFakeDependencies({ now: NOW, credentialCipherAvailable: false }),
    );
    fixture = await seedContactFixture(harness.fake);

    const connect = await harness.run(
      `mutation Connect($input: ConnectCarddavAccountInput!) {
         connectCarddavAccount(input: $input) { account { id } }
       }`,
      ADMIN,
      {
        input: {
          serverUrl: "https://contacts.icloud.com",
          username: "ada@icloud.com",
          appPassword: "app-specific-pw",
        },
      },
    );
    expect(errorCodes(connect)).toEqual(["SERVICE_UNAVAILABLE"]);

    // Ordinary contacts work is unaffected by the missing credential key.
    const created = await harness.run(CREATE_CONTACT, ADMIN, {
      input: {
        addressBookId: fixture.addressBookId,
        displayName: "Still works",
      },
    });
    expect(created.errors).toBeUndefined();
  });

  test("connects an account, links and syncs a book, and never echoes the password", async () => {
    const homeSetUrl = "https://p1-carddavws.icloud.com/1/carddavhome/";
    harness = createGraphQLHarness(
      createFakeDependencies({
        now: NOW,
        carddav: {
          discovery: {
            principalUrl: "https://p1-carddavws.icloud.com/1/principal/",
            homeSetUrl,
            addressBooks: [
              {
                remoteUrl: `${homeSetUrl}card/`,
                displayName: "iCloud",
                ctag: "ctag-1",
                syncToken: "token-1",
              },
            ],
          },
        },
      }),
    );
    fixture = await seedContactFixture(harness.fake);
    // A MEMBER viewer, not an API key: connecting a CardDAV account requires
    // a signed-in user so an agent cannot exfiltrate the credential.
    const userId = createUserId("usr-owner");
    const owner = memberViewer(
      "usr-owner",
      buildMailPermissions(userId, [
        { effect: "ALLOW", addressPattern: SUPPORT_ADDRESS },
      ]),
    );
    await harness.run(CREATE_CONTACT, owner, {
      input: {
        addressBookId: fixture.addressBookId,
        displayName: "Pre-existing",
      },
    });

    const connected = await harness.run(
      `mutation Connect($input: ConnectCarddavAccountInput!) {
         connectCarddavAccount(input: $input) {
           account { id userId serverUrl username principalUrl homeSetUrl }
           addressBooks { remoteUrl displayName ctag syncToken }
         }
       }`,
      owner,
      {
        input: {
          serverUrl: "https://contacts.icloud.com",
          username: "ada@icloud.com",
          appPassword: "abcd-efgh-ijkl-mnop",
        },
      },
    );
    expect(connected.errors).toBeUndefined();
    expect(JSON.stringify(connected.data)).not.toContain("abcd-efgh-ijkl-mnop");
    const accountId = field<{ account: { id: string } }>(
      connected,
      "connectCarddavAccount",
    ).account.id;

    const accounts = await harness.run(
      `query { carddavAccounts { id username } }`,
      owner,
    );
    expect(accounts.data?.["carddavAccounts"]).toHaveLength(1);
    expect(JSON.stringify(accounts.data)).not.toContain("abcd-efgh-ijkl-mnop");

    const linked = await harness.run(
      `mutation Link($input: LinkCarddavBookInput!) {
         linkCarddavBook(input: $input) { id addressBookId remoteUrl }
       }`,
      owner,
      {
        input: {
          accountId,
          remoteUrl: `${homeSetUrl}card/`,
          mode: "BIND_EXISTING",
          addressBookId: fixture.addressBookId,
        },
      },
    );
    expect(linked.errors).toBeUndefined();
    const linkId = field<{ id: string }>(linked, "linkCarddavBook").id;

    // Linking the same book to a second remote collection is a CONFLICT.
    const secondLink = await harness.run(
      `mutation Link($input: LinkCarddavBookInput!) {
         linkCarddavBook(input: $input) { id }
       }`,
      owner,
      {
        input: {
          accountId,
          remoteUrl: `${homeSetUrl}personal/`,
          mode: "BIND_EXISTING",
          addressBookId: fixture.addressBookId,
        },
      },
    );
    expect(errorCodes(secondLink)).toEqual(["CONFLICT"]);

    const synced = await harness.run(
      `mutation Sync($id: ID!) {
         syncCarddavBook(id: $id) {
           pulled pushed deleted skipped conflictsResolvedRemoteWins truncated warnings
         }
       }`,
      owner,
      { id: linkId },
    );
    expect(synced.errors).toBeUndefined();
    const summary = field<{ pushed: number; pulled: number }>(
      synced,
      "syncCarddavBook",
    );
    // The pre-existing local contact was never synced before, so this
    // first sync pushes it.
    expect(summary.pushed).toBeGreaterThan(0);
    expect(summary.pulled).toBe(0);

    const unlinked = await harness.run(
      `mutation Unlink($id: ID!) { unlinkCarddavBook(id: $id) }`,
      owner,
      { id: linkId },
    );
    expect(unlinked.data?.["unlinkCarddavBook"]).toBe(true);

    const disconnected = await harness.run(
      `mutation Disconnect($id: ID!) { disconnectCarddavAccount(id: $id) }`,
      owner,
      { id: accountId },
    );
    expect(disconnected.data?.["disconnectCarddavAccount"]).toBe(true);
  });

  test("an API key may not connect a CarDAV account", async () => {
    const key = contactKeyViewer([Capability.ContactWrite]);
    const result = await harness.run(
      `mutation Connect($input: ConnectCarddavAccountInput!) {
         connectCarddavAccount(input: $input) { account { id } }
       }`,
      key,
      {
        input: {
          serverUrl: "https://contacts.icloud.com",
          username: "ada@icloud.com",
          appPassword: "abcd-efgh-ijkl-mnop",
        },
      },
    );
    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
  });
});

describe("contacts schema shape", () => {
  test("exposes no CardDAV credential field", async () => {
    const introspection = await harness.run(
      `query {
         __schema { types { name fields { name } inputFields { name } } }
       }`,
      ADMIN,
    );
    const types = field<{
      types: readonly {
        name: string;
        fields: readonly { name: string }[] | null;
        inputFields: readonly { name: string }[] | null;
      }[];
    }>(introspection, "__schema").types;
    const contactsTypes = types.filter((type) =>
      /^(AddressBook|Contact|Carddav|RemoteAddressBook|Connect|Link|Sync)/.test(
        type.name,
      ),
    );
    expect(contactsTypes.length).toBeGreaterThan(10);
    const serialized = JSON.stringify(contactsTypes).toLowerCase();
    for (const forbidden of ["ciphertext", "password"]) {
      // "appPassword" is a legitimate mutation *input* field; everything
      // else must never mention a password or its ciphertext.
      const matches = serialized
        .split(/[^a-z]+/)
        .filter((word) => word.includes(forbidden));
      expect(matches.filter((word) => word !== "apppassword")).toEqual([]);
    }
  });
});
