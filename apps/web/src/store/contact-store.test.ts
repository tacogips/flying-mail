import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AddressBookView, ContactView } from "../api/contact-types";
import {
  ALL_CONTACTS_SELECTION,
  createContactStore,
  filterForSelection,
  groupAddressBooks,
} from "./contact-store";

interface GraphQLCall {
  readonly operation: string;
  readonly variables: Record<string, unknown>;
}

/** Records every GraphQL call and answers from a per-operation responder. */
function stubGraphQL(
  responders: Record<string, (variables: Record<string, unknown>) => unknown>,
): GraphQLCall[] {
  const calls: GraphQLCall[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const match = /(?:query|mutation)\s+(\w+)/.exec(body.query);
    const operation = match?.[1] ?? "unknown";
    calls.push({ operation, variables: body.variables ?? {} });
    const responder = responders[operation];
    if (responder === undefined) {
      return new Response(
        JSON.stringify({ errors: [{ message: `no stub for ${operation}` }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ data: responder(body.variables ?? {}) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return calls;
}

function book(
  id: string,
  mailAddressId: string,
  address: string,
  name = "Contacts",
): AddressBookView {
  return {
    id,
    mailAddress: { id: mailAddressId, address },
    name,
    description: null,
    isDefault: true,
    contactCount: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function contact(
  id: string,
  displayName: string,
  bookId = "book-1",
): ContactView {
  return {
    id,
    addressBook: {
      id: bookId,
      name: "Contacts",
      mailAddress: { id: "addr-1", address: "support@example.com" },
    },
    uid: `${id}@mailcal`,
    displayName,
    givenName: null,
    familyName: null,
    nickname: null,
    organization: null,
    title: null,
    emails: [],
    phones: [],
    postalAddresses: [],
    urls: [],
    note: null,
    birthday: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function contactsPage(
  nodes: readonly ContactView[],
  nextCursor: string | null = null,
  totalCount = nodes.length,
): unknown {
  return { contacts: { nodes, nextCursor, totalCount } };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("groupAddressBooks", () => {
  test("groups by mail address, sorted by address then book name", () => {
    const groups = groupAddressBooks([
      book("b2", "addr-2", "zeta@example.com", "Personal"),
      book("b1a", "addr-1", "support@example.com", "Work"),
      book("b1b", "addr-1", "support@example.com", "Family"),
    ]);
    expect(groups.map((g) => g.address)).toEqual([
      "support@example.com",
      "zeta@example.com",
    ]);
    expect(groups[0]?.books.map((b) => b.name)).toEqual(["Family", "Work"]);
    expect(groups[0]?.books).toHaveLength(2);
    expect(groups[1]?.books).toHaveLength(1);
  });

  test("an empty list groups to nothing", () => {
    expect(groupAddressBooks([])).toEqual([]);
  });
});

describe("filterForSelection", () => {
  test("ALL omits both id filters, yielding the merged view", () => {
    expect(filterForSelection(ALL_CONTACTS_SELECTION, "")).toEqual({});
  });

  test("ADDRESS scopes to the mail address, BOOK to the book", () => {
    expect(
      filterForSelection({ kind: "ADDRESS", mailAddressId: "addr-1" }, ""),
    ).toEqual({ mailAddressIds: ["addr-1"] });
    expect(
      filterForSelection({ kind: "BOOK", addressBookId: "book-1" }, ""),
    ).toEqual({ addressBookIds: ["book-1"] });
  });

  test("a non-empty query is trimmed and attached regardless of selection", () => {
    expect(filterForSelection(ALL_CONTACTS_SELECTION, "  ada  ")).toEqual({
      query: "ada",
    });
    expect(filterForSelection(ALL_CONTACTS_SELECTION, "   ")).toEqual({});
  });
});

describe("rail selection", () => {
  test("changing the selection re-fetches with the derived filter", async () => {
    const calls = stubGraphQL({
      Contacts: (vars) =>
        contactsPage([
          contact(
            "c1",
            "Ada",
            String(
              (vars["filter"] as Record<string, unknown> | undefined)?.[
                "addressBookIds"
              ] ?? "book",
            ),
          ),
        ]),
    });
    const store = createContactStore();
    await store.setSelection({ kind: "BOOK", addressBookId: "book-9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables["filter"]).toEqual({
      addressBookIds: ["book-9"],
    });
    expect(store.contacts()).toHaveLength(1);
  });

  test("changing the search query re-fetches too", async () => {
    const calls = stubGraphQL({
      Contacts: () => contactsPage([]),
    });
    const store = createContactStore();
    await store.setQuery("ada");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables["filter"]).toEqual({ query: "ada" });
  });
});

describe("cursor pagination", () => {
  test("loadMore appends and keeps the running cursor", async () => {
    stubGraphQL({
      Contacts: (vars) =>
        vars["after"] === null
          ? contactsPage([contact("c1", "Ada")], "cursor-1", 3)
          : contactsPage([contact("c2", "Bea"), contact("c3", "Cid")], null, 3),
    });
    const store = createContactStore();
    await store.loadContacts();
    expect(store.contacts()).toHaveLength(1);
    expect(store.hasMore()).toBe(true);

    await store.loadMore();
    expect(store.contacts().map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(store.hasMore()).toBe(false);
  });

  test("a rail change resets the cursor rather than paging from it", async () => {
    const calls = stubGraphQL({
      Contacts: () => contactsPage([contact("c1", "Ada")], "cursor-1", 5),
    });
    const store = createContactStore();
    await store.loadContacts();
    expect(store.hasMore()).toBe(true);

    await store.setSelection({ kind: "ADDRESS", mailAddressId: "addr-1" });
    const afterSelectionChange = calls.at(-1);
    expect(afterSelectionChange?.variables["after"]).toBeNull();
  });
});

describe("optimistic contact mutations", () => {
  test("update patches in place immediately and keeps the server copy on success", async () => {
    stubGraphQL({
      Contacts: () => contactsPage([contact("c1", "Ada Lovelace")]),
      UpdateContact: () => ({
        updateContact: contact("c1", "Ada L."),
      }),
    });
    const store = createContactStore();
    await store.loadContacts();

    const updating = store.updateContact("c1", { displayName: "Ada L." });
    // The patch is visible before the round trip resolves.
    expect(store.contacts()[0]?.displayName).toBe("Ada L.");
    await updating;
    expect(store.contacts()[0]?.displayName).toBe("Ada L.");
  });

  test("update rolls back on a failed mutation", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("UpdateContact")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "nope", extensions: { code: "FORBIDDEN" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: contactsPage([contact("c1", "Ada Lovelace")]) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const store = createContactStore();
    await store.loadContacts();

    const result = await store.updateContact("c1", { displayName: "Broken" });
    expect(result).toBeNull();
    expect(store.contacts()[0]?.displayName).toBe("Ada Lovelace");
  });

  test("delete removes immediately and stays removed on success", async () => {
    stubGraphQL({
      Contacts: () => contactsPage([contact("c1", "Ada")], null, 1),
      DeleteContact: () => ({ deleteContact: true }),
    });
    const store = createContactStore();
    await store.loadContacts();
    expect(store.contacts()).toHaveLength(1);

    expect(await store.deleteContact("c1")).toBe(true);
    expect(store.contacts()).toHaveLength(0);
    expect(store.totalCount()).toBe(0);
  });

  test("delete restores the contact when the server refuses", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("DeleteContact")) {
        return new Response(
          JSON.stringify({
            errors: [{ message: "nope", extensions: { code: "FORBIDDEN" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: contactsPage([contact("c1", "Ada")], null, 1) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const store = createContactStore();
    await store.loadContacts();

    expect(await store.deleteContact("c1")).toBe(false);
    expect(store.contacts()).toHaveLength(1);
    expect(store.totalCount()).toBe(1);
  });

  test("create inserts the server-returned contact in name order", async () => {
    stubGraphQL({
      Contacts: () => contactsPage([contact("c1", "Bea")], null, 1),
      CreateContact: () => ({ createContact: contact("c2", "Ada") }),
    });
    const store = createContactStore();
    await store.loadContacts();

    const created = await store.createContact({ displayName: "Ada" });
    expect(created?.id).toBe("c2");
    expect(store.contacts().map((c) => c.displayName)).toEqual(["Ada", "Bea"]);
    expect(store.totalCount()).toBe(2);
  });

  test("a failed create leaves the list untouched", async () => {
    stubGraphQL({
      Contacts: () => contactsPage([contact("c1", "Bea")], null, 1),
    });
    const store = createContactStore();
    await store.loadContacts();

    const created = await store.createContact({ displayName: "Ada" });
    expect(created).toBeNull();
    expect(store.contacts()).toHaveLength(1);
    expect(store.totalCount()).toBe(1);
  });
});

describe("address books and CardDAV", () => {
  test("loads and groups address books", async () => {
    stubGraphQL({
      AddressBooks: () => ({
        addressBooks: [book("b1", "addr-1", "support@example.com")],
      }),
    });
    const store = createContactStore();
    await store.loadAddressBooks();
    expect(store.addressBooks()).toHaveLength(1);
    expect(store.addressBookGroups()).toHaveLength(1);
  });

  test("connect records the account and never sends the password back", async () => {
    const calls = stubGraphQL({
      ConnectCarddavAccount: () => ({
        connectCarddavAccount: {
          account: {
            id: "acc-1",
            userId: "usr-1",
            serverUrl: "https://contacts.icloud.com/",
            username: "me@example.com",
            principalUrl: null,
            homeSetUrl: null,
            createdAt: "2026-08-24T00:00:00.000Z",
            updatedAt: "2026-08-24T00:00:00.000Z",
          },
          addressBooks: [
            {
              remoteUrl: "https://p1-contacts.icloud.com/1/carddavhome/card/",
              displayName: "iCloud",
              ctag: "ctag-1",
              syncToken: "token-1",
            },
          ],
        },
      }),
    });
    const store = createContactStore();
    const result = await store.connectCarddavAccount({
      serverUrl: "https://contacts.icloud.com/",
      username: "me@example.com",
      appPassword: "abcd-efgh-ijkl-mnop",
    });

    expect(result?.addressBooks).toHaveLength(1);
    expect(store.carddavAccounts()).toHaveLength(1);
    expect(JSON.stringify(store.carddavAccounts())).not.toContain(
      "abcd-efgh-ijkl-mnop",
    );
    expect(
      JSON.stringify(
        calls.find((c) => c.operation === "ConnectCarddavAccount")?.variables,
      ),
    ).toContain("abcd-efgh-ijkl-mnop");
  });

  test("linking IMPORT_NEW sends the target mail address, not a book id", async () => {
    const calls = stubGraphQL({
      Contacts: () => contactsPage([]),
      AddressBooks: () => ({ addressBooks: [] }),
      LinkCarddavBook: () => ({
        linkCarddavBook: {
          id: "link-1",
          accountId: "acc-1",
          addressBookId: "book-new",
          remoteUrl: "https://p1-contacts.icloud.com/1/carddavhome/card/",
          displayName: "iCloud",
          ctag: "ctag-1",
          syncToken: "token-1",
          lastSyncedAt: null,
        },
      }),
    });
    const store = createContactStore();
    const linked = await store.linkCarddavBook({
      accountId: "acc-1",
      remoteUrl: "https://p1-contacts.icloud.com/1/carddavhome/card/",
      mode: "IMPORT_NEW",
      mailAddressId: "addr-1",
    });
    expect(linked?.addressBookId).toBe("book-new");
    expect(store.carddavBookLinks()).toHaveLength(1);
    const call = calls.find((c) => c.operation === "LinkCarddavBook");
    expect(call?.variables["input"]).toMatchObject({
      mode: "IMPORT_NEW",
      mailAddressId: "addr-1",
    });
  });

  test("sync returns its summary and refreshes the current page", async () => {
    const calls = stubGraphQL({
      Contacts: () => contactsPage([]),
      SyncCarddavBook: () => ({
        syncCarddavBook: {
          pulled: 2,
          pushed: 1,
          deleted: 0,
          skipped: 1,
          conflictsResolvedRemoteWins: 1,
          truncated: false,
          warnings: ["Unsupported property PHOTO"],
        },
      }),
    });
    const store = createContactStore();
    await store.loadContacts();
    const result = await store.syncCarddavBook("link-1");
    expect(result).toMatchObject({ pulled: 2, skipped: 1 });
    expect(calls.filter((c) => c.operation === "Contacts")).toHaveLength(2);
  });
});
