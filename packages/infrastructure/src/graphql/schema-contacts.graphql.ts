/**
 * The contacts and CardDAV half of the GraphQL contract, mirroring
 * `design-docs/specs/design-contacts.md#graphql`.
 *
 * A separate SDL module keeps the contacts contract cohesive while
 * `createSchema` merges it with the other feature documents at runtime.
 *
 * `Capability.CONTACT_READ`/`CONTACT_WRITE` live in `schema.graphql.ts`
 * beside the other capability values, not here. `AddressBook.mailAddress`
 * and `Contact.addressBook` are field resolvers, not columns.
 */
export const contactTypeDefs = /* GraphQL */ `
  """
  A named collection of contacts owned by one managed mail address. Every
  address gets a default book automatically; additional books are optional.
  """
  type AddressBook {
    id: ID!
    mailAddress: MailAddress!
    name: String!
    description: String
    isDefault: Boolean!
    contactCount: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type ContactEmail {
    address: String!
    label: String
  }

  type ContactPhone {
    number: String!
    label: String
  }

  type ContactPostalAddress {
    formatted: String!
    label: String
  }

  """
  A single person or organization entry in an address book. CardDAV-synced
  contacts carry a stable uid so re-import and push do not duplicate rows.
  """
  type Contact {
    id: ID!
    addressBook: AddressBook!
    "vCard UID; stable across CardDAV sync."
    uid: String!
    displayName: String!
    givenName: String
    familyName: String
    nickname: String
    organization: String
    title: String
    emails: [ContactEmail!]!
    phones: [ContactPhone!]!
    postalAddresses: [ContactPostalAddress!]!
    urls: [String!]!
    note: String
    "ISO date (YYYY-MM-DD); no year-optional or timezone handling."
    birthday: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type ContactPage {
    nodes: [Contact!]!
    """
    Null once the result set is exhausted.
    """
    nextCursor: String
    totalCount: Int!
  }

  input ContactFilter {
    "Restricts to contacts in an address book owned by one of these addresses."
    mailAddressIds: [ID!]
    addressBookIds: [ID!]
    "Case-insensitive match over displayName, organization and note."
    query: String
    "Exact match against any of a contact's emails."
    email: String
  }

  input ContactEmailInput {
    address: String!
    label: String
  }

  input ContactPhoneInput {
    number: String!
    label: String
  }

  input ContactPostalAddressInput {
    formatted: String!
    label: String
  }

  input CreateAddressBookInput {
    mailAddressId: ID!
    name: String!
    description: String
  }

  input UpdateAddressBookInput {
    name: String
    description: String
  }

  input CreateContactInput {
    "Required when addressBookId is omitted: targets that address's default book, creating it if absent."
    mailAddressId: ID
    "Defaults to the target address's default book when omitted."
    addressBookId: ID
    displayName: String!
    givenName: String
    familyName: String
    nickname: String
    organization: String
    title: String
    emails: [ContactEmailInput!]
    phones: [ContactPhoneInput!]
    postalAddresses: [ContactPostalAddressInput!]
    urls: [String!]
    note: String
    birthday: String
  }

  """
  Every field is an optional patch; the contact keeps its address book.
  """
  input UpdateContactInput {
    displayName: String
    givenName: String
    familyName: String
    nickname: String
    organization: String
    title: String
    emails: [ContactEmailInput!]
    phones: [ContactPhoneInput!]
    postalAddresses: [ContactPostalAddressInput!]
    urls: [String!]
    note: String
    birthday: String
  }

  """
  A connected CardDAV account. Neither the plaintext app-specific password
  nor its ciphertext is exposed here, by construction.
  """
  type CarddavAccount {
    id: ID!
    userId: ID!
    serverUrl: String!
    username: String!
    principalUrl: String
    homeSetUrl: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "A remote address book found during discovery, not yet linked."
  type CarddavDiscoveredAddressBook {
    remoteUrl: String!
    displayName: String
    ctag: String
    syncToken: String
  }

  "A remote address book collection, as reported by the CardDAV server."
  type RemoteAddressBook {
    remoteUrl: String!
    displayName: String
    ctag: String
    syncToken: String
  }

  "A local address book bound to a remote CardDAV collection."
  type CarddavBookLink {
    id: ID!
    accountId: ID!
    addressBookId: ID!
    remoteUrl: String!
    displayName: String
    ctag: String
    syncToken: String
    lastSyncedAt: DateTime
  }

  type ConnectCarddavAccountResult {
    account: CarddavAccount!
    addressBooks: [CarddavDiscoveredAddressBook!]!
  }

  type CarddavSyncSummary {
    pulled: Int!
    pushed: Int!
    deleted: Int!
    skipped: Int!
    "Both sides changed, or a PUT was refused: the remote version won."
    conflictsResolvedRemoteWins: Int!
    "True when the change set exceeded one request's budget; sync again."
    truncated: Boolean!
    warnings: [String!]!
  }

  input ConnectCarddavAccountInput {
    serverUrl: String!
    username: String!
    "An app-specific password. Stored only as ciphertext."
    appPassword: String!
  }

  """
  IMPORT_NEW creates a fresh flying-mail address book for the remote collection;
  BIND_EXISTING attaches the remote collection to a book that already
  exists (and then requires addressBookId).
  """
  enum CarddavLinkMode {
    IMPORT_NEW
    BIND_EXISTING
  }

  input LinkCarddavBookInput {
    accountId: ID!
    remoteUrl: String!
    mode: CarddavLinkMode!
    "Required for BIND_EXISTING."
    addressBookId: ID
    "Required for IMPORT_NEW: the address whose new book the remote collection binds to."
    mailAddressId: ID
    displayName: String
  }

  extend type Query {
    "Omitted mailAddressId lists every address's books the viewer may read."
    addressBooks(mailAddressId: ID): [AddressBook!]!
    contacts(filter: ContactFilter, first: Int, after: String): ContactPage!
    contact(id: ID!): Contact
    "Every contact across readable address books carrying this email."
    contactsByEmail(email: String!): [Contact!]!
    "The viewer's own connected accounts, never secrets."
    carddavAccounts: [CarddavAccount!]!
    carddavRemoteBooks(accountId: ID!): [CarddavBookLink!]!
  }

  extend type Mutation {
    createAddressBook(input: CreateAddressBookInput!): AddressBook!
    updateAddressBook(id: ID!, input: UpdateAddressBookInput!): AddressBook!
    deleteAddressBook(id: ID!): Boolean!

    createContact(input: CreateContactInput!): Contact!
    updateContact(id: ID!, input: UpdateContactInput!): Contact!
    deleteContact(id: ID!): Boolean!

    """
    Requires a USER viewer: an API key must not be able to rotate or
    exfiltrate a person's CardDAV credentials.
    """
    connectCarddavAccount(
      input: ConnectCarddavAccountInput!
    ): ConnectCarddavAccountResult!
    disconnectCarddavAccount(id: ID!): Boolean!
    linkCarddavBook(input: LinkCarddavBookInput!): CarddavBookLink!
    unlinkCarddavBook(id: ID!): Boolean!
    "On-demand sync. Conflicts resolve remote-wins, deterministically."
    syncCarddavBook(id: ID!): CarddavSyncSummary!
  }
`;
