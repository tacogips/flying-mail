import type { AddressBook } from "@mailcal/domain/entities/address-book";
import type {
  CarddavAccount,
  CarddavBookLink,
} from "@mailcal/domain/entities/carddav-account";
import type { Contact } from "@mailcal/domain/entities/contact";
import type {
  AddressBookId,
  CarddavAccountId,
  CarddavBookId,
  ContactId,
  MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import type { Viewer } from "../policies/viewer";
import type { ContactPage } from "../ports/contact-repository";
import {
  type CreateAddressBookUseCaseInput,
  createCreateAddressBookUseCase,
  createDeleteAddressBookUseCase,
  createListAddressBooksUseCase,
  createUpdateAddressBookUseCase,
  type UpdateAddressBookUseCaseInput,
} from "./address-books";
import {
  type ConnectCarddavAccountInput,
  type ConnectCarddavAccountResult,
  createConnectCarddavAccountUseCase,
  createDisconnectCarddavAccountUseCase,
  createLinkRemoteAddressBookUseCase,
  createListCarddavAccountsUseCase,
  createListRemoteAddressBooksUseCase,
  createUnlinkRemoteAddressBookUseCase,
  type LinkRemoteAddressBookInput,
} from "./carddav";
import {
  createSyncCarddavBookUseCase,
  type SyncCarddavBookResult,
} from "./carddav-sync";
import {
  type CreateContactUseCaseInput,
  createCreateContactUseCase,
  createDeleteContactUseCase,
  createGetContactUseCase,
  createListContactsUseCase,
  createLookupContactsByEmailUseCase,
  createUpdateContactUseCase,
  type ListContactsInput,
  type UpdateContactUseCaseInput,
} from "./contacts";

/** The contact half of `UseCases`, assembled here so `usecases.ts` gains a
 * single spread rather than another feature's worth of entries. */
export interface ContactUseCases {
  readonly listAddressBooks: (
    viewer: Viewer,
    mailAddressId?: MailAddressId,
  ) => Promise<readonly AddressBook[]>;
  readonly createAddressBook: (
    viewer: Viewer,
    input: CreateAddressBookUseCaseInput,
  ) => Promise<AddressBook>;
  readonly updateAddressBook: (
    viewer: Viewer,
    id: AddressBookId,
    input: UpdateAddressBookUseCaseInput,
  ) => Promise<AddressBook>;
  readonly deleteAddressBook: (
    viewer: Viewer,
    id: AddressBookId,
  ) => Promise<boolean>;

  readonly listContacts: (
    viewer: Viewer,
    input: ListContactsInput,
  ) => Promise<ContactPage>;
  readonly getContact: (
    viewer: Viewer,
    id: ContactId,
  ) => Promise<Contact | null>;
  readonly createContact: (
    viewer: Viewer,
    input: CreateContactUseCaseInput,
  ) => Promise<Contact>;
  readonly updateContact: (
    viewer: Viewer,
    id: ContactId,
    input: UpdateContactUseCaseInput,
  ) => Promise<Contact>;
  readonly deleteContact: (viewer: Viewer, id: ContactId) => Promise<boolean>;
  readonly lookupContactsByEmail: (
    viewer: Viewer,
    email: string,
  ) => Promise<readonly Contact[]>;

  readonly listCarddavAccounts: (
    viewer: Viewer,
  ) => Promise<readonly CarddavAccount[]>;
  readonly connectCarddavAccount: (
    viewer: Viewer,
    input: ConnectCarddavAccountInput,
  ) => Promise<ConnectCarddavAccountResult>;
  readonly listRemoteAddressBooks: (
    viewer: Viewer,
    accountId: CarddavAccountId,
  ) => Promise<readonly CarddavBookLink[]>;
  readonly linkRemoteAddressBook: (
    viewer: Viewer,
    input: LinkRemoteAddressBookInput,
  ) => Promise<CarddavBookLink>;
  readonly unlinkRemoteAddressBook: (
    viewer: Viewer,
    id: CarddavBookId,
  ) => Promise<boolean>;
  readonly syncCarddavBook: (
    viewer: Viewer,
    carddavBookId: CarddavBookId,
  ) => Promise<SyncCarddavBookResult>;
  readonly disconnectCarddavAccount: (
    viewer: Viewer,
    id: CarddavAccountId,
  ) => Promise<boolean>;
}

export function createContactUseCases(deps: AppDependencies): ContactUseCases {
  return {
    listAddressBooks: createListAddressBooksUseCase(deps),
    createAddressBook: createCreateAddressBookUseCase(deps),
    updateAddressBook: createUpdateAddressBookUseCase(deps),
    deleteAddressBook: createDeleteAddressBookUseCase(deps),

    listContacts: createListContactsUseCase(deps),
    getContact: createGetContactUseCase(deps),
    createContact: createCreateContactUseCase(deps),
    updateContact: createUpdateContactUseCase(deps),
    deleteContact: createDeleteContactUseCase(deps),
    lookupContactsByEmail: createLookupContactsByEmailUseCase(deps),

    listCarddavAccounts: createListCarddavAccountsUseCase(deps),
    connectCarddavAccount: createConnectCarddavAccountUseCase(deps),
    listRemoteAddressBooks: createListRemoteAddressBooksUseCase(deps),
    linkRemoteAddressBook: createLinkRemoteAddressBookUseCase(deps),
    unlinkRemoteAddressBook: createUnlinkRemoteAddressBookUseCase(deps),
    syncCarddavBook: createSyncCarddavBookUseCase(deps),
    disconnectCarddavAccount: createDisconnectCarddavAccountUseCase(deps),
  };
}

export type {
  ConnectCarddavAccountInput,
  ConnectCarddavAccountResult,
  CreateAddressBookUseCaseInput,
  CreateContactUseCaseInput,
  LinkRemoteAddressBookInput,
  ListContactsInput,
  SyncCarddavBookResult,
  UpdateAddressBookUseCaseInput,
  UpdateContactUseCaseInput,
};
