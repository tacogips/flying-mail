import type { AddressBook } from "@mailcal/domain/entities/address-book";
import { Capability } from "@mailcal/domain/entities/api-key";
import type { Contact } from "@mailcal/domain/entities/contact";
import type {
  AddressBookId,
  ContactId,
  MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  authorizesContactRead,
  authorizesContactWrite,
  type ContactBookOwnerRef,
  contactPermissionListFilter,
  readableAddressPatterns,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";

/** Shared access resolution for every contact use case.
 *
 * Authorization decisions live in `policies/authorization.ts`; this module
 * only *feeds* them -- it resolves the owner identity a decision needs (the
 * book's owning mail address, and that address's domain) and turns a denied
 * read into `NOT_FOUND`, preserving the same probe resistance as mail.
 * Resolving an owner needs no second repository call because
 * `MailAddress.domainId` is never null, so the mail address record alone is
 * `ContactBookOwnerRef`. */

/** Per-call memo. Listing a page of contacts across several books touches
 * the same handful of owning addresses repeatedly. */
export interface ContactAccessContext {
  readonly owners: Map<string, ContactBookOwnerRef | null>;
}

export function createContactAccessContext(): ContactAccessContext {
  return { owners: new Map() };
}

export async function resolveAddressBookOwner(
  deps: AppDependencies,
  mailAddressId: MailAddressId,
  context: ContactAccessContext = createContactAccessContext(),
): Promise<ContactBookOwnerRef | null> {
  const cached = context.owners.get(mailAddressId);
  if (cached !== undefined) {
    return cached;
  }
  const mailAddress = await deps.mailAddressRepository.findById(mailAddressId);
  const owner: ContactBookOwnerRef | null =
    mailAddress === null
      ? null
      : {
          mailAddressId: mailAddress.id,
          address: mailAddress.address,
          domainId: mailAddress.domainId,
        };
  context.owners.set(mailAddressId, owner);
  return owner;
}

export async function canReadAddressBook(
  deps: AppDependencies,
  viewer: Viewer,
  book: AddressBook,
  context?: ContactAccessContext,
): Promise<boolean> {
  const owner = await resolveAddressBookOwner(
    deps,
    book.mailAddressId,
    context,
  );
  return owner !== null && authorizesContactRead(viewer, owner);
}

/** `null` rather than a thrown error when the viewer may not see it: the
 * caller turns that into `NOT_FOUND`, so an unauthorized read is
 * indistinguishable from a missing book. */
export async function loadReadableAddressBook(
  deps: AppDependencies,
  viewer: Viewer,
  id: AddressBookId,
  context?: ContactAccessContext,
): Promise<AddressBook | null> {
  const book = await deps.addressBookRepository.findById(id);
  if (book === null) {
    return null;
  }
  return (await canReadAddressBook(deps, viewer, book, context)) ? book : null;
}

/** Writes report `NOT_FOUND` when the viewer cannot even read the book
 * (nothing is leaked) and `FORBIDDEN` when it can read but not write (the
 * caller already knows the book exists, so saying so leaks nothing). */
export async function loadWritableAddressBook(
  deps: AppDependencies,
  viewer: Viewer,
  id: AddressBookId,
  context?: ContactAccessContext,
): Promise<AddressBook> {
  const book = await deps.addressBookRepository.findById(id);
  if (book === null) {
    throw new NotFoundError("AddressBook", id);
  }
  const owner = await resolveAddressBookOwner(
    deps,
    book.mailAddressId,
    context,
  );
  if (owner === null || !authorizesContactRead(viewer, owner)) {
    throw new NotFoundError("AddressBook", id);
  }
  if (!authorizesContactWrite(viewer, owner)) {
    throw new ForbiddenError(
      "This credential is not permitted to modify this address book",
    );
  }
  return book;
}

/** Every address book the viewer may read, pushed down to the repository
 * exactly like `MessageListFilter`: a USER viewer's mailbox rules under
 * `CONTACT_READ`'s mapped mail capability, or an API-key viewer's
 * `CONTACT_READ` scope allowlist. */
export async function listReadableAddressBooks(
  deps: AppDependencies,
  viewer: Viewer,
): Promise<readonly AddressBook[]> {
  if (viewer.kind === "USER") {
    return deps.addressBookRepository.listReadable({
      allowedPatterns: null,
      mailPermissionFilter: contactPermissionListFilter(
        viewer,
        Capability.ContactRead,
      ),
    });
  }
  return deps.addressBookRepository.listReadable({
    allowedPatterns: readableAddressPatterns(viewer, Capability.ContactRead),
    mailPermissionFilter: null,
  });
}

export async function loadReadableContact(
  deps: AppDependencies,
  viewer: Viewer,
  id: ContactId,
  context?: ContactAccessContext,
): Promise<Contact | null> {
  const contact = await deps.contactRepository.findById(id);
  if (contact === null) {
    return null;
  }
  const book = await loadReadableAddressBook(
    deps,
    viewer,
    contact.addressBookId,
    context,
  );
  return book === null ? null : contact;
}

/** Loads a contact for mutation. Existence is only admitted to a viewer that
 * can read the contact's book; a viewer that can read but not write it is
 * reported `FORBIDDEN`, not `NOT_FOUND`. */
export async function loadWritableContact(
  deps: AppDependencies,
  viewer: Viewer,
  id: ContactId,
  context?: ContactAccessContext,
): Promise<Contact> {
  const contact = await deps.contactRepository.findById(id);
  if (contact === null) {
    throw new NotFoundError("Contact", id);
  }
  const book = await loadReadableAddressBook(
    deps,
    viewer,
    contact.addressBookId,
    context,
  );
  if (book === null) {
    throw new NotFoundError("Contact", id);
  }
  const owner = await resolveAddressBookOwner(
    deps,
    book.mailAddressId,
    context,
  );
  if (owner === null || !authorizesContactWrite(viewer, owner)) {
    throw new ForbiddenError(
      "This credential is not permitted to modify this contact",
    );
  }
  return contact;
}
