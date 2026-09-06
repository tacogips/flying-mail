import { createSignal } from "solid-js";
import {
  ADDRESS_BOOKS_QUERY,
  CARDDAV_ACCOUNTS_QUERY,
  CARDDAV_REMOTE_BOOKS_QUERY,
  CONNECT_CARDDAV_ACCOUNT_MUTATION,
  CONTACTS_BY_EMAIL_QUERY,
  CONTACTS_QUERY,
  CREATE_ADDRESS_BOOK_MUTATION,
  CREATE_CONTACT_MUTATION,
  DELETE_ADDRESS_BOOK_MUTATION,
  DELETE_CONTACT_MUTATION,
  DISCONNECT_CARDDAV_ACCOUNT_MUTATION,
  LINK_CARDDAV_BOOK_MUTATION,
  SYNC_CARDDAV_BOOK_MUTATION,
  UNLINK_CARDDAV_BOOK_MUTATION,
  UPDATE_ADDRESS_BOOK_MUTATION,
  UPDATE_CONTACT_MUTATION,
} from "../api/contact-documents";
import type {
  AddressBookView,
  CarddavAccountView,
  CarddavBookLinkView,
  CarddavSyncSummaryView,
  ConnectCarddavAccountResultView,
  ContactFilterInput,
  ContactView,
  CreateContactInput,
  LinkCarddavBookInput,
  UpdateContactInput,
} from "../api/contact-types";
import { graphqlRequest, type GraphQLResult } from "../api/graphql-client";
import { describeErrors } from "../lib/mutation-error";
import { pushToast } from "../lib/toast";

const PAGE_SIZE = 50;

/** Which slice of the merged contact space the rail has selected. Omitting
 * both id filters (the `ALL` case) is what makes `contacts` return the
 * cross-address merged view, per the GraphQL contract. */
export type ContactRailSelection =
  | { readonly kind: "ALL" }
  | { readonly kind: "ADDRESS"; readonly mailAddressId: string }
  | { readonly kind: "BOOK"; readonly addressBookId: string };

export const ALL_CONTACTS_SELECTION: ContactRailSelection = { kind: "ALL" };

export interface ContactDialogTarget {
  /** The contact being edited, or `null` for a new contact. */
  readonly contact: ContactView | null;
  /** Seed/target book for a new contact; ignored when editing. */
  readonly addressBookId: string | null;
}

/** One rail group: a readable mail address and its books, nested when there
 * is more than one -- pure so it is unit-testable apart from the store. */
export interface AddressBookGroup {
  readonly mailAddressId: string;
  readonly address: string;
  readonly books: readonly AddressBookView[];
}

/** Groups the flat `addressBooks` list (every address the viewer may read,
 * per the omitted-`mailAddressId` query) by owning mail address, sorted by
 * address and then by book name within each group. */
export function groupAddressBooks(
  books: readonly AddressBookView[],
): readonly AddressBookGroup[] {
  const byAddress = new Map<string, AddressBookGroup>();
  for (const book of books) {
    const key = book.mailAddress.id;
    const existing = byAddress.get(key);
    if (existing === undefined) {
      byAddress.set(key, {
        mailAddressId: key,
        address: book.mailAddress.address,
        books: [book],
      });
    } else {
      byAddress.set(key, { ...existing, books: [...existing.books, book] });
    }
  }
  return [...byAddress.values()]
    .sort((a, b) => a.address.localeCompare(b.address))
    .map((group) => ({
      ...group,
      books: [...group.books].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/** Builds the server-side `ContactFilter` for the current rail selection and
 * search text. Pure so the "which filter for which selection" rule is
 * unit-testable without a network stub. */
export function filterForSelection(
  selection: ContactRailSelection,
  query: string,
): ContactFilterInput {
  const trimmed = query.trim();
  const base: ContactFilterInput =
    trimmed.length === 0 ? {} : { query: trimmed };
  switch (selection.kind) {
    case "ALL":
      return base;
    case "ADDRESS":
      return { ...base, mailAddressIds: [selection.mailAddressId] };
    case "BOOK":
      return { ...base, addressBookIds: [selection.addressBookId] };
    default: {
      const exhaustive: never = selection;
      throw new Error(
        `Unhandled rail selection: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

function sortedInsert(
  list: readonly ContactView[],
  contact: ContactView,
): readonly ContactView[] {
  const next = [...list.filter((entry) => entry.id !== contact.id), contact];
  next.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return next;
}

/** `UpdateContactInput`'s child-list shapes carry `label?: string`, while
 * the view's carry `label: string | null`; a blind spread would type-check
 * as `any` at best, so each list field is re-shaped explicitly. */
function applyUpdatePatch(
  contact: ContactView,
  input: UpdateContactInput,
): ContactView {
  return {
    ...contact,
    ...(input.displayName === undefined
      ? {}
      : { displayName: input.displayName }),
    ...(input.givenName === undefined ? {} : { givenName: input.givenName }),
    ...(input.familyName === undefined ? {} : { familyName: input.familyName }),
    ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
    ...(input.organization === undefined
      ? {}
      : { organization: input.organization }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.birthday === undefined ? {} : { birthday: input.birthday }),
    ...(input.urls === undefined ? {} : { urls: input.urls }),
    ...(input.emails === undefined
      ? {}
      : {
          emails: input.emails.map((email) => ({
            address: email.address,
            label: email.label ?? null,
          })),
        }),
    ...(input.phones === undefined
      ? {}
      : {
          phones: input.phones.map((phone) => ({
            number: phone.number,
            label: phone.label ?? null,
          })),
        }),
    ...(input.postalAddresses === undefined
      ? {}
      : {
          postalAddresses: input.postalAddresses.map((address) => ({
            formatted: address.formatted,
            label: address.label ?? null,
          })),
        }),
  };
}

export interface ContactStore {
  readonly addressBooks: () => readonly AddressBookView[];
  readonly addressBookGroups: () => readonly AddressBookGroup[];
  readonly selection: () => ContactRailSelection;
  readonly query: () => string;
  readonly contacts: () => readonly ContactView[];
  readonly totalCount: () => number;
  readonly hasMore: () => boolean;
  readonly loading: () => boolean;
  readonly dialog: () => ContactDialogTarget | null;
  readonly carddavAccounts: () => readonly CarddavAccountView[];
  readonly carddavBookLinks: () => readonly CarddavBookLinkView[];

  setSelection(selection: ContactRailSelection): Promise<void>;
  setQuery(query: string): Promise<void>;
  loadAddressBooks(): Promise<void>;
  loadContacts(options?: { readonly force?: boolean }): Promise<void>;
  loadMore(): Promise<void>;

  openDialog(target: ContactDialogTarget): void;
  closeDialog(): void;

  createAddressBook(input: {
    readonly mailAddressId: string;
    readonly name: string;
    readonly description?: string;
  }): Promise<AddressBookView | null>;
  updateAddressBook(
    id: string,
    input: { readonly name?: string; readonly description?: string },
  ): Promise<AddressBookView | null>;
  deleteAddressBook(id: string): Promise<boolean>;

  createContact(input: CreateContactInput): Promise<ContactView | null>;
  updateContact(
    id: string,
    input: UpdateContactInput,
  ): Promise<ContactView | null>;
  deleteContact(id: string): Promise<boolean>;

  /** A bare, uncached query call: the message-view lookup hook (TASK-005)
   * owns its own short-lived cache, so the store does not duplicate one. */
  lookupContactsByEmail(address: string): Promise<readonly ContactView[]>;

  loadCarddavAccounts(): Promise<void>;
  loadCarddavRemoteBooks(accountId: string): Promise<void>;
  connectCarddavAccount(input: {
    readonly serverUrl: string;
    readonly username: string;
    readonly appPassword: string;
  }): Promise<ConnectCarddavAccountResultView | null>;
  disconnectCarddavAccount(id: string): Promise<boolean>;
  linkCarddavBook(
    input: LinkCarddavBookInput,
  ): Promise<CarddavBookLinkView | null>;
  unlinkCarddavBook(id: string): Promise<boolean>;
  syncCarddavBook(id: string): Promise<CarddavSyncSummaryView | null>;
}

export function createContactStore(): ContactStore {
  const [addressBooks, setAddressBooks] = createSignal<
    readonly AddressBookView[]
  >([]);
  const [selection, setSelectionSignal] = createSignal<ContactRailSelection>(
    ALL_CONTACTS_SELECTION,
  );
  const [query, setQuerySignal] = createSignal("");
  const [contacts, setContacts] = createSignal<readonly ContactView[]>([]);
  const [nextCursor, setNextCursor] = createSignal<string | null>(null);
  const [totalCount, setTotalCount] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [dialog, setDialog] = createSignal<ContactDialogTarget | null>(null);
  const [carddavAccounts, setCarddavAccounts] = createSignal<
    readonly CarddavAccountView[]
  >([]);
  const [carddavBookLinks, setCarddavBookLinks] = createSignal<
    readonly CarddavBookLinkView[]
  >([]);

  function reportFailure(result: GraphQLResult<unknown>): boolean {
    if (result.ok) {
      return false;
    }
    pushToast("error", describeErrors(result.errors));
    return true;
  }

  async function loadContacts(
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    // Guards against overlapping requests from rapid rail/search changes,
    // while still letting an explicit forced reload (after a CardDAV sync,
    // say) proceed regardless of an in-flight load.
    if (loading() && options.force !== true) {
      return;
    }
    setLoading(true);
    const result = await graphqlRequest<
      {
        readonly contacts: {
          readonly nodes: readonly ContactView[];
          readonly nextCursor: string | null;
          readonly totalCount: number;
        };
      },
      { filter: ContactFilterInput; first: number; after: string | null }
    >(CONTACTS_QUERY, {
      filter: filterForSelection(selection(), query()),
      first: PAGE_SIZE,
      after: null,
    });
    setLoading(false);
    if (reportFailure(result) || !result.ok) {
      return;
    }
    setContacts(result.data.contacts.nodes);
    setNextCursor(result.data.contacts.nextCursor);
    setTotalCount(result.data.contacts.totalCount);
  }

  async function loadMore(): Promise<void> {
    const after = nextCursor();
    if (after === null || loading()) {
      return;
    }
    setLoading(true);
    const result = await graphqlRequest<
      {
        readonly contacts: {
          readonly nodes: readonly ContactView[];
          readonly nextCursor: string | null;
          readonly totalCount: number;
        };
      },
      { filter: ContactFilterInput; first: number; after: string | null }
    >(CONTACTS_QUERY, {
      filter: filterForSelection(selection(), query()),
      first: PAGE_SIZE,
      after,
    });
    setLoading(false);
    if (reportFailure(result) || !result.ok) {
      return;
    }
    setContacts((current) => [...current, ...result.data.contacts.nodes]);
    setNextCursor(result.data.contacts.nextCursor);
    setTotalCount(result.data.contacts.totalCount);
  }

  return {
    addressBooks,
    addressBookGroups: () => groupAddressBooks(addressBooks()),
    selection,
    query,
    contacts,
    totalCount,
    hasMore: () => nextCursor() !== null,
    loading,
    dialog,
    carddavAccounts,
    carddavBookLinks,

    async setSelection(next) {
      setSelectionSignal(next);
      setNextCursor(null);
      await loadContacts({ force: true });
    },

    async setQuery(next) {
      setQuerySignal(next);
      setNextCursor(null);
      await loadContacts({ force: true });
    },

    async loadAddressBooks() {
      const result = await graphqlRequest<{
        readonly addressBooks: readonly AddressBookView[];
      }>(ADDRESS_BOOKS_QUERY);
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setAddressBooks(result.data.addressBooks);
    },

    loadContacts,
    loadMore,

    openDialog(target) {
      setDialog(target);
    },
    closeDialog() {
      setDialog(null);
    },

    async createAddressBook(input) {
      const result = await graphqlRequest<
        { readonly createAddressBook: AddressBookView },
        { input: Record<string, unknown> }
      >(CREATE_ADDRESS_BOOK_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setAddressBooks((current) => [...current, result.data.createAddressBook]);
      return result.data.createAddressBook;
    },

    async updateAddressBook(id, input) {
      const result = await graphqlRequest<
        { readonly updateAddressBook: AddressBookView },
        { id: string; input: Record<string, unknown> }
      >(UPDATE_ADDRESS_BOOK_MUTATION, { id, input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setAddressBooks((current) =>
        current.map((book) =>
          book.id === id ? result.data.updateAddressBook : book,
        ),
      );
      return result.data.updateAddressBook;
    },

    async deleteAddressBook(id) {
      const result = await graphqlRequest<
        { readonly deleteAddressBook: boolean },
        { id: string }
      >(DELETE_ADDRESS_BOOK_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      setAddressBooks((current) => current.filter((book) => book.id !== id));
      // A deleted book hard-deletes its contacts server-side; the loaded
      // page may now contain rows that no longer exist.
      await loadContacts({ force: true });
      return result.data.deleteAddressBook;
    },

    async createContact(input) {
      const result = await graphqlRequest<
        { readonly createContact: ContactView },
        { input: CreateContactInput }
      >(CREATE_CONTACT_MUTATION, { input });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setContacts((current) =>
        sortedInsert(current, result.data.createContact),
      );
      setTotalCount((current) => current + 1);
      return result.data.createContact;
    },

    async updateContact(id, input) {
      const before = contacts();
      const existing = before.find((entry) => entry.id === id);
      if (existing !== undefined) {
        // Patch in place immediately because a contact's shown fields are
        // exactly what the caller sent, so there is nothing left for the
        // server to compute before it is safe to show.
        setContacts((current) =>
          current.map((entry) =>
            entry.id === id ? applyUpdatePatch(entry, input) : entry,
          ),
        );
      }
      const result = await graphqlRequest<
        { readonly updateContact: ContactView },
        { id: string; input: UpdateContactInput }
      >(UPDATE_CONTACT_MUTATION, { id, input });
      if (!result.ok) {
        setContacts(before);
        reportFailure(result);
        return null;
      }
      setContacts((current) =>
        current.map((entry) =>
          entry.id === id ? result.data.updateContact : entry,
        ),
      );
      return result.data.updateContact;
    },

    async deleteContact(id) {
      const before = contacts();
      const beforeTotal = totalCount();
      setContacts(before.filter((entry) => entry.id !== id));
      setTotalCount(Math.max(0, beforeTotal - 1));
      const result = await graphqlRequest<
        { readonly deleteContact: boolean },
        { id: string }
      >(DELETE_CONTACT_MUTATION, { id });
      if (!result.ok) {
        setContacts(before);
        setTotalCount(beforeTotal);
        reportFailure(result);
        return false;
      }
      return result.data.deleteContact;
    },

    async lookupContactsByEmail(address) {
      const result = await graphqlRequest<
        { readonly contactsByEmail: readonly ContactView[] },
        { email: string }
      >(CONTACTS_BY_EMAIL_QUERY, { email: address });
      if (!result.ok) {
        return [];
      }
      return result.data.contactsByEmail;
    },

    async loadCarddavAccounts() {
      const result = await graphqlRequest<{
        readonly carddavAccounts: readonly CarddavAccountView[];
      }>(CARDDAV_ACCOUNTS_QUERY);
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setCarddavAccounts(result.data.carddavAccounts);
    },

    async loadCarddavRemoteBooks(accountId) {
      const result = await graphqlRequest<
        { readonly carddavRemoteBooks: readonly CarddavBookLinkView[] },
        { accountId: string }
      >(CARDDAV_REMOTE_BOOKS_QUERY, { accountId });
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setCarddavBookLinks(result.data.carddavRemoteBooks);
    },

    async connectCarddavAccount(input) {
      const result = await graphqlRequest<
        { readonly connectCarddavAccount: ConnectCarddavAccountResultView },
        { input: Record<string, unknown> }
      >(CONNECT_CARDDAV_ACCOUNT_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCarddavAccounts((current) => [
        ...current,
        result.data.connectCarddavAccount.account,
      ]);
      return result.data.connectCarddavAccount;
    },

    async disconnectCarddavAccount(id) {
      const result = await graphqlRequest<
        { readonly disconnectCarddavAccount: boolean },
        { id: string }
      >(DISCONNECT_CARDDAV_ACCOUNT_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      setCarddavAccounts((current) =>
        current.filter((account) => account.id !== id),
      );
      setCarddavBookLinks((current) =>
        current.filter((link) => link.accountId !== id),
      );
      return result.data.disconnectCarddavAccount;
    },

    async linkCarddavBook(input) {
      const result = await graphqlRequest<
        { readonly linkCarddavBook: CarddavBookLinkView },
        { input: Record<string, unknown> }
      >(LINK_CARDDAV_BOOK_MUTATION, { input: { ...input } });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      setCarddavBookLinks((current) => [
        ...current.filter((link) => link.id !== result.data.linkCarddavBook.id),
        result.data.linkCarddavBook,
      ]);
      await loadContactStoreDependents();
      return result.data.linkCarddavBook;

      /** Refreshes the data a new/rebound link can change: the address
       * book catalogue (a fresh `IMPORT_NEW` book) and the current page. */
      async function loadContactStoreDependents(): Promise<void> {
        const booksResult = await graphqlRequest<{
          readonly addressBooks: readonly AddressBookView[];
        }>(ADDRESS_BOOKS_QUERY);
        if (booksResult.ok) {
          setAddressBooks(booksResult.data.addressBooks);
        }
        await loadContacts({ force: true });
      }
    },

    async unlinkCarddavBook(id) {
      const result = await graphqlRequest<
        { readonly unlinkCarddavBook: boolean },
        { id: string }
      >(UNLINK_CARDDAV_BOOK_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      setCarddavBookLinks((current) =>
        current.filter((link) => link.id !== id),
      );
      return result.data.unlinkCarddavBook;
    },

    async syncCarddavBook(id) {
      const result = await graphqlRequest<
        { readonly syncCarddavBook: CarddavSyncSummaryView },
        { id: string }
      >(SYNC_CARDDAV_BOOK_MUTATION, { id });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      await loadContacts({ force: true });
      return result.data.syncCarddavBook;
    },
  };
}
