import type { AddressBook } from "@flying-mail/domain/entities/address-book";
import { createAddressBook } from "@flying-mail/domain/entities/address-book";
import {
  type Contact,
  type ContactEmailInput,
  type ContactPhoneInput,
  type ContactPostalAddressInput,
  createContact,
  updateContact,
} from "@flying-mail/domain/entities/contact";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  type AddressBookId,
  createAddressBookId,
  createContactId,
  type ContactId,
  type MailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import {
  authorizesContactRead,
  requireContactWrite,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type { ContactPage } from "../ports/contact-repository";
import {
  type ContactAccessContext,
  createContactAccessContext,
  listReadableAddressBooks,
  loadReadableAddressBook,
  loadReadableContact,
  loadWritableContact,
  resolveAddressBookOwner,
} from "./contact-access";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

export interface ListContactsInput {
  readonly mailAddressIds?: readonly MailAddressId[];
  readonly addressBookIds?: readonly AddressBookId[];
  /** Name/organization/email substring. */
  readonly query?: string;
  readonly email?: string;
  readonly first?: number;
  readonly after?: string;
}

export interface CreateContactUseCaseInput {
  /** Explicit target book. Omit together with `mailAddressId` to target that
   * address's default book (auto-created, named "Contacts", if absent). */
  readonly addressBookId?: AddressBookId;
  /** Required when `addressBookId` is omitted. */
  readonly mailAddressId?: MailAddressId;
  readonly displayName: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[];
  readonly phones?: readonly ContactPhoneInput[];
  readonly postalAddresses?: readonly ContactPostalAddressInput[];
  readonly urls?: readonly string[];
  readonly note?: string | null;
  readonly birthday?: string | null;
}

export interface UpdateContactUseCaseInput {
  readonly displayName?: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly ContactEmailInput[];
  readonly phones?: readonly ContactPhoneInput[];
  readonly postalAddresses?: readonly ContactPostalAddressInput[];
  readonly urls?: readonly string[];
  readonly note?: string | null;
  readonly birthday?: string | null;
}

const DEFAULT_CONTACT_PAGE_SIZE = 50;
const MAX_CONTACT_PAGE_SIZE = 200;

/** Resolves the set of address books a `listContacts`/`lookupContactsByEmail`
 * call is restricted to, filtering out anything the viewer cannot read
 * rather than erroring -- an explicit id list behaves like a filter, not an
 * assertion, mirroring how a message filter silently narrows rather than
 * rejecting an out-of-scope id. Omitting both id filters yields the merged
 * cross-address view. */
async function resolveTargetAddressBookIds(
  deps: AppDependencies,
  viewer: Viewer,
  input: Pick<ListContactsInput, "addressBookIds" | "mailAddressIds">,
  context: ContactAccessContext,
): Promise<readonly AddressBookId[]> {
  if (input.addressBookIds !== undefined) {
    const readable: AddressBookId[] = [];
    for (const id of input.addressBookIds) {
      const book = await loadReadableAddressBook(deps, viewer, id, context);
      if (book !== null) {
        readable.push(book.id);
      }
    }
    return readable;
  }
  if (input.mailAddressIds !== undefined) {
    const allowed: MailAddressId[] = [];
    for (const mailAddressId of input.mailAddressIds) {
      const owner = await resolveAddressBookOwner(deps, mailAddressId, context);
      if (owner !== null && authorizesContactRead(viewer, owner)) {
        allowed.push(mailAddressId);
      }
    }
    if (allowed.length === 0) {
      return [];
    }
    const books = await deps.addressBookRepository.listByMailAddresses(allowed);
    return books.map((book) => book.id);
  }
  const books = await listReadableAddressBooks(deps, viewer);
  return books.map((book) => book.id);
}

export function createListContactsUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: ListContactsInput) => Promise<ContactPage> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const context = createContactAccessContext();
      const addressBookIds = await resolveTargetAddressBookIds(
        deps,
        viewer,
        input,
        context,
      );
      if (addressBookIds.length === 0) {
        return { nodes: [], nextCursor: null, totalCount: 0 };
      }
      const first = Math.min(
        input.first ?? DEFAULT_CONTACT_PAGE_SIZE,
        MAX_CONTACT_PAGE_SIZE,
      );
      return deps.contactRepository.listPage({
        addressBookIds,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.email === undefined
          ? {}
          : { email: createEmailAddress(input.email, "email") }),
        first,
        ...(input.after === undefined ? {} : { after: input.after }),
      });
    });
}

export function createGetContactUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ContactId) => Promise<Contact | null> {
  return (viewer, id) => loadReadableContact(deps, viewer, id);
}

/** Resolves (or lazily creates) the book a new contact lands in. With no
 * `addressBookId`, the caller's `mailAddressId` is required and its default
 * book is used, created on first use -- the single-book case needs no book
 * management at all, per the design doc. */
async function resolveTargetAddressBook(
  deps: AppDependencies,
  viewer: Viewer,
  input: CreateContactUseCaseInput,
): Promise<AddressBook> {
  if (input.addressBookId !== undefined) {
    const context = createContactAccessContext();
    const book = await loadReadableAddressBook(
      deps,
      viewer,
      input.addressBookId,
      context,
    );
    if (book === null) {
      throw new NotFoundError("AddressBook", input.addressBookId);
    }
    const owner = await resolveAddressBookOwner(
      deps,
      book.mailAddressId,
      context,
    );
    if (owner === null) {
      throw new NotFoundError("AddressBook", input.addressBookId);
    }
    requireContactWrite(viewer, owner);
    return book;
  }
  if (input.mailAddressId === undefined) {
    throw new BadUserInputError(
      "Either addressBookId or mailAddressId is required",
      "addressBookId",
    );
  }
  const owner = await resolveAddressBookOwner(deps, input.mailAddressId);
  if (owner === null) {
    throw new NotFoundError("MailAddress", input.mailAddressId);
  }
  requireContactWrite(viewer, owner);
  const existing = await deps.addressBookRepository.findDefaultForMailAddress(
    input.mailAddressId,
  );
  if (existing !== null) {
    return existing;
  }
  const now = deps.clock.now().toISOString();
  const book = createAddressBook({
    id: createAddressBookId(deps.random.uuid()),
    mailAddressId: input.mailAddressId,
    name: "Contacts",
    isDefault: true,
    createdAt: now,
  });
  await deps.addressBookRepository.save(book);
  return book;
}

export function createCreateContactUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateContactUseCaseInput) => Promise<Contact> {
  return async (viewer, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const book = await resolveTargetAddressBook(deps, viewer, input);
      const now = deps.clock.now().toISOString();
      const contact = createContact({
        id: createContactId(deps.random.uuid()),
        addressBookId: book.id,
        // A vCard UID for a locally created contact: flying-mail mints it once
        // and preserves it verbatim thereafter.
        uid: deps.random.uuid(),
        displayName: input.displayName,
        ...(input.givenName === undefined
          ? {}
          : { givenName: input.givenName }),
        ...(input.familyName === undefined
          ? {}
          : { familyName: input.familyName }),
        ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
        ...(input.organization === undefined
          ? {}
          : { organization: input.organization }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.emails === undefined ? {} : { emails: input.emails }),
        ...(input.phones === undefined ? {} : { phones: input.phones }),
        ...(input.postalAddresses === undefined
          ? {}
          : { postalAddresses: input.postalAddresses }),
        ...(input.urls === undefined ? {} : { urls: input.urls }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.birthday === undefined ? {} : { birthday: input.birthday }),
        createdAt: now,
      });
      await deps.contactRepository.createContact(contact);
      return contact;
    });
}

export function createUpdateContactUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: ContactId,
  input: UpdateContactUseCaseInput,
) => Promise<Contact> {
  return async (viewer, id, input) =>
    withAsyncDomainErrorTranslation(async () => {
      const contact = await loadWritableContact(deps, viewer, id);
      const now = deps.clock.now().toISOString();
      const updated = updateContact(
        contact,
        {
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...(input.givenName === undefined
            ? {}
            : { givenName: input.givenName }),
          ...(input.familyName === undefined
            ? {}
            : { familyName: input.familyName }),
          ...(input.nickname === undefined ? {} : { nickname: input.nickname }),
          ...(input.organization === undefined
            ? {}
            : { organization: input.organization }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.emails === undefined ? {} : { emails: input.emails }),
          ...(input.phones === undefined ? {} : { phones: input.phones }),
          ...(input.postalAddresses === undefined
            ? {}
            : { postalAddresses: input.postalAddresses }),
          ...(input.urls === undefined ? {} : { urls: input.urls }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.birthday === undefined ? {} : { birthday: input.birthday }),
        },
        now,
      );
      await deps.contactRepository.updateContact(updated);
      return updated;
    });
}

/** Deleting a CardDAV-linked contact records a `carddav_deletions`
 * tombstone so the next sync pushes the deletion; a contact in an unlinked
 * book skips that step entirely. */
export function createDeleteContactUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: ContactId) => Promise<boolean> {
  return async (viewer, id) => {
    const contact = await loadWritableContact(deps, viewer, id);
    const link = await deps.carddavAccountRepository.findBookLinkByAddressBook(
      contact.addressBookId,
    );
    if (link !== null) {
      const state = await deps.carddavAccountRepository.findContactState(
        contact.id,
      );
      if (state !== null) {
        await deps.carddavAccountRepository.addDeletion({
          carddavBookId: link.id,
          href: state.href,
          etag: state.etag,
          deletedAt: deps.clock.now().toISOString(),
        });
        await deps.carddavAccountRepository.deleteContactState(contact.id);
      }
    }
    await deps.contactRepository.deleteContact(id);
    return true;
  };
}

/** The "who is this sender?" hook: restricted to the viewer's readable
 * books, same authorization path as `listContacts`. */
export function createLookupContactsByEmailUseCase(
  deps: AppDependencies,
): (viewer: Viewer, email: string) => Promise<readonly Contact[]> {
  return async (viewer, email) =>
    withAsyncDomainErrorTranslation(async () => {
      const address = createEmailAddress(email, "email");
      const books = await listReadableAddressBooks(deps, viewer);
      if (books.length === 0) {
        return [];
      }
      return deps.contactRepository.listByEmail(
        address,
        books.map((book) => book.id),
      );
    });
}
