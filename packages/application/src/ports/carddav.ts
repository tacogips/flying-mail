import type {
  CarddavAccount,
  CarddavBookLink,
  CarddavContactState,
  CarddavDeletion,
} from "@flying-mail/domain/entities/carddav-account";
import type {
  AddressBookId,
  CarddavAccountId,
  CarddavBookId,
  ContactId,
  UserId,
} from "@flying-mail/domain/value-objects/ids";

export interface CarddavAccountRepository {
  findAccountById(id: CarddavAccountId): Promise<CarddavAccount | null>;
  listAccountsByUser(userId: UserId): Promise<readonly CarddavAccount[]>;
  saveAccount(account: CarddavAccount): Promise<void>;
  deleteAccount(id: CarddavAccountId): Promise<void>;

  findBookLinkById(id: CarddavBookId): Promise<CarddavBookLink | null>;
  findBookLinkByAddressBook(
    addressBookId: AddressBookId,
  ): Promise<CarddavBookLink | null>;
  listBookLinksByAccount(
    accountId: CarddavAccountId,
  ): Promise<readonly CarddavBookLink[]>;
  saveBookLink(link: CarddavBookLink): Promise<void>;
  deleteBookLink(id: CarddavBookId): Promise<void>;

  findContactState(contactId: ContactId): Promise<CarddavContactState | null>;
  findContactStateByHref(
    carddavBookId: CarddavBookId,
    href: string,
  ): Promise<CarddavContactState | null>;
  listContactStates(
    carddavBookId: CarddavBookId,
  ): Promise<readonly CarddavContactState[]>;
  saveContactState(state: CarddavContactState): Promise<void>;
  deleteContactState(contactId: ContactId): Promise<void>;

  addDeletion(deletion: CarddavDeletion): Promise<void>;
  listDeletions(
    carddavBookId: CarddavBookId,
  ): Promise<readonly CarddavDeletion[]>;
  removeDeletion(carddavBookId: CarddavBookId, href: string): Promise<void>;
}

/** Credentials for one CardDAV conversation. The plaintext password lives
 * only in this argument, for the duration of a single use-case call. */
export interface CarddavCredentials {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

/** A remote collection plus the credentials needed to reach it. */
export interface RemoteAddressBookRef {
  readonly credentials: CarddavCredentials;
  readonly remoteUrl: string;
}

export interface CarddavDiscoveredAddressBook {
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
}

export interface CarddavDiscovery {
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly addressBooks: readonly CarddavDiscoveredAddressBook[];
}

export interface CarddavObject {
  readonly href: string;
  readonly etag: string | null;
  readonly vcard: string;
}

export interface CarddavChangeSet {
  /** Hrefs whose content changed (or is new) since the sync token. */
  readonly changedHrefs: readonly string[];
  readonly deletedHrefs: readonly string[];
  readonly syncToken: string | null;
  readonly ctag: string | null;
  /** True when the server could not honor the token and a full listing was
   * used instead -- the caller must then treat absent hrefs as deletions. */
  readonly fullResync: boolean;
}

export type CarddavPutOutcome = "CREATED" | "UPDATED" | "CONFLICT";

export interface CarddavPutResult {
  readonly outcome: CarddavPutOutcome;
  readonly etag: string | null;
}

export type CarddavDeleteOutcome = "DELETED" | "CONFLICT" | "ALREADY_ABSENT";

export interface CarddavDeleteResult {
  readonly outcome: CarddavDeleteOutcome;
}

/** Raised by the adapter for transport-level problems, so the use case can
 * map them onto application errors without knowing about HTTP. */
export class CarddavAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarddavAuthError";
  }
}

export class CarddavTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CarddavTransportError";
  }
}

/** flying-mail is a CardDAV *client* only. Nothing here serves CardDAV to
 * anyone else -- see the design doc's out-of-scope list. */
export interface CarddavClient {
  discover(credentials: CarddavCredentials): Promise<CarddavDiscovery>;
  listChanges(
    book: RemoteAddressBookRef,
    syncToken: string | null,
  ): Promise<CarddavChangeSet>;
  multigetContacts(
    book: RemoteAddressBookRef,
    hrefs: readonly string[],
  ): Promise<readonly CarddavObject[]>;
  putContact(
    book: RemoteAddressBookRef,
    href: string,
    vcard: string,
    etag: string | null,
  ): Promise<CarddavPutResult>;
  deleteContact(
    book: RemoteAddressBookRef,
    href: string,
    etag: string | null,
  ): Promise<CarddavDeleteResult>;
}
