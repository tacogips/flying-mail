import type { AddressBook } from "@flying-mail/domain/entities/address-book";
import type { AddressPattern } from "@flying-mail/domain/value-objects/address-pattern";
import type {
  AddressBookId,
  MailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import type { MailPermissionFilter } from "../policies/authorization";

/** Everything a listing query can be narrowed by, mirroring
 * `MessageListFilter`'s two-mechanism split: `allowedPatterns` is an
 * API-key viewer's `CONTACT_READ`/`CONTACT_WRITE` scope allowlist (`null`
 * unrestricted, empty means nothing); `mailPermissionFilter` is a USER
 * viewer's mailbox rules, evaluated under the mail capability the requested
 * contact capability maps onto. Both are derived by the authorization
 * policy from the viewer -- never supplied by a caller directly -- and are
 * matched against each candidate book's *owning mail address*, not the book
 * itself. */
export interface AddressBookListFilter {
  readonly mailAddressIds?: readonly MailAddressId[];
  readonly allowedPatterns: readonly AddressPattern[] | null;
  readonly mailPermissionFilter: MailPermissionFilter | null;
}

export interface AddressBookRepository {
  findById(id: AddressBookId): Promise<AddressBook | null>;
  findDefaultForMailAddress(
    mailAddressId: MailAddressId,
  ): Promise<AddressBook | null>;
  listByMailAddresses(
    mailAddressIds: readonly MailAddressId[],
  ): Promise<readonly AddressBook[]>;
  /** Every book on an address a USER viewer's mail-permission rules admit
   * (baseline ADMIN sees all), or an API-key viewer's CONTACT_READ/WRITE
   * scopes admit -- see {@link AddressBookListFilter}. */
  listReadable(filter: AddressBookListFilter): Promise<readonly AddressBook[]>;
  save(book: AddressBook): Promise<void>;
  /** Hard delete; contacts cascade. */
  delete(id: AddressBookId): Promise<void>;
  countContacts(id: AddressBookId): Promise<number>;
}
