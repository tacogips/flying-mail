/**
 * Every contacts and CardDAV GraphQL document the client sends. Keeping these
 * in a separate module prevents the shared documents file from carrying a
 * second feature's worth of queries.
 */

const MAIL_ADDRESS_REF_FIELDS = `
  id
  address
`;

const ADDRESS_BOOK_FIELDS = `
  id
  mailAddress { ${MAIL_ADDRESS_REF_FIELDS} }
  name
  description
  isDefault
  contactCount
  createdAt
  updatedAt
`;

const CONTACT_FIELDS = `
  id
  addressBook { id name mailAddress { ${MAIL_ADDRESS_REF_FIELDS} } }
  uid
  displayName
  givenName
  familyName
  nickname
  organization
  title
  emails { address label }
  phones { number label }
  postalAddresses { formatted label }
  urls
  note
  birthday
  createdAt
  updatedAt
`;

export const ADDRESS_BOOKS_QUERY = `
  query AddressBooks($mailAddressId: ID) {
    addressBooks(mailAddressId: $mailAddressId) { ${ADDRESS_BOOK_FIELDS} }
  }
`;

export const CONTACTS_QUERY = `
  query Contacts($filter: ContactFilter, $first: Int, $after: String) {
    contacts(filter: $filter, first: $first, after: $after) {
      nodes { ${CONTACT_FIELDS} }
      nextCursor
      totalCount
    }
  }
`;

export const CONTACT_QUERY = `
  query Contact($id: ID!) {
    contact(id: $id) { ${CONTACT_FIELDS} }
  }
`;

export const CONTACTS_BY_EMAIL_QUERY = `
  query ContactsByEmail($email: String!) {
    contactsByEmail(email: $email) { ${CONTACT_FIELDS} }
  }
`;

const CARDDAV_ACCOUNT_FIELDS = `
  id
  userId
  serverUrl
  username
  principalUrl
  homeSetUrl
  createdAt
  updatedAt
`;

const CARDDAV_BOOK_LINK_FIELDS = `
  id
  accountId
  addressBookId
  remoteUrl
  displayName
  ctag
  syncToken
  lastSyncedAt
`;

export const CARDDAV_ACCOUNTS_QUERY = `
  query CarddavAccounts { carddavAccounts { ${CARDDAV_ACCOUNT_FIELDS} } }
`;

export const CARDDAV_REMOTE_BOOKS_QUERY = `
  query CarddavRemoteBooks($accountId: ID!) {
    carddavRemoteBooks(accountId: $accountId) { ${CARDDAV_BOOK_LINK_FIELDS} }
  }
`;

export const CREATE_ADDRESS_BOOK_MUTATION = `
  mutation CreateAddressBook($input: CreateAddressBookInput!) {
    createAddressBook(input: $input) { ${ADDRESS_BOOK_FIELDS} }
  }
`;

export const UPDATE_ADDRESS_BOOK_MUTATION = `
  mutation UpdateAddressBook($id: ID!, $input: UpdateAddressBookInput!) {
    updateAddressBook(id: $id, input: $input) { ${ADDRESS_BOOK_FIELDS} }
  }
`;

export const DELETE_ADDRESS_BOOK_MUTATION = `
  mutation DeleteAddressBook($id: ID!) { deleteAddressBook(id: $id) }
`;

export const CREATE_CONTACT_MUTATION = `
  mutation CreateContact($input: CreateContactInput!) {
    createContact(input: $input) { ${CONTACT_FIELDS} }
  }
`;

export const UPDATE_CONTACT_MUTATION = `
  mutation UpdateContact($id: ID!, $input: UpdateContactInput!) {
    updateContact(id: $id, input: $input) { ${CONTACT_FIELDS} }
  }
`;

export const DELETE_CONTACT_MUTATION = `
  mutation DeleteContact($id: ID!) { deleteContact(id: $id) }
`;

export const CONNECT_CARDDAV_ACCOUNT_MUTATION = `
  mutation ConnectCarddavAccount($input: ConnectCarddavAccountInput!) {
    connectCarddavAccount(input: $input) {
      account { ${CARDDAV_ACCOUNT_FIELDS} }
      addressBooks { remoteUrl displayName ctag syncToken }
    }
  }
`;

export const DISCONNECT_CARDDAV_ACCOUNT_MUTATION = `
  mutation DisconnectCarddavAccount($id: ID!) {
    disconnectCarddavAccount(id: $id)
  }
`;

export const LINK_CARDDAV_BOOK_MUTATION = `
  mutation LinkCarddavBook($input: LinkCarddavBookInput!) {
    linkCarddavBook(input: $input) { ${CARDDAV_BOOK_LINK_FIELDS} }
  }
`;

export const UNLINK_CARDDAV_BOOK_MUTATION = `
  mutation UnlinkCarddavBook($id: ID!) { unlinkCarddavBook(id: $id) }
`;

export const SYNC_CARDDAV_BOOK_MUTATION = `
  mutation SyncCarddavBook($id: ID!) {
    syncCarddavBook(id: $id) {
      pulled pushed deleted skipped conflictsResolvedRemoteWins truncated warnings
    }
  }
`;
