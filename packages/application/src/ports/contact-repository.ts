import type { Contact } from "@mailcal/domain/entities/contact";
import type { EmailAddress } from "@mailcal/domain/value-objects/email-address";
import type {
  AddressBookId,
  ContactId,
} from "@mailcal/domain/value-objects/ids";

export interface ContactListPageInput {
  readonly addressBookIds: readonly AddressBookId[];
  /** Case-insensitive substring match over display name, organization and
   * email. */
  readonly query?: string;
  readonly email?: EmailAddress;
  readonly first: number;
  readonly after?: string;
}

export interface ContactPage {
  readonly nodes: readonly Contact[];
  /** `null` once the result set is exhausted. */
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface ContactRepository {
  findById(id: ContactId): Promise<Contact | null>;
  /** `(addressBookId, uid)` is the CardDAV upsert key -- the only stable
   * identity a remote server and mailcal share. */
  findByUid(addressBookId: AddressBookId, uid: string): Promise<Contact | null>;
  /** Atomic write of the contact row plus its emails/phones/postal
   * addresses/urls child rows. */
  createContact(contact: Contact): Promise<void>;
  updateContact(contact: Contact): Promise<void>;
  deleteContact(id: ContactId): Promise<void>;
  listByAddressBook(addressBookId: AddressBookId): Promise<readonly Contact[]>;
  /** Cross-address "who is this?" lookup via the indexed `contact_emails.address`
   * column, restricted to `addressBookIds`. */
  listByEmail(
    address: EmailAddress,
    addressBookIds: readonly AddressBookId[],
  ): Promise<readonly Contact[]>;
  /** Cursor-paginated, filtered listing over a caller-resolved set of
   * readable address books -- authorization has already happened by the
   * time this is called. */
  listPage(input: ContactListPageInput): Promise<ContactPage>;
}
