/**
 * Hand-written transport types for the contacts and CardDAV surface,
 * mirroring `schema-contacts.graphql.ts`.
 *
 * Kept apart from `schema-types.ts` so neither file has to carry two
 * features' worth of shapes.
 * There is no photo, group/`MEMBER`, or free-form extension-property field
 * here, by design.
 */

export type CarddavLinkMode = "IMPORT_NEW" | "BIND_EXISTING";

/** The subset of `MailAddress` every contacts view actually needs: enough
 * to label a rail entry and group books by owning address. */
export interface ContactMailAddressRefView {
  readonly id: string;
  readonly address: string;
}

export interface AddressBookView {
  readonly id: string;
  readonly mailAddress: ContactMailAddressRefView;
  readonly name: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly contactCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContactAddressBookRefView {
  readonly id: string;
  readonly name: string;
  readonly mailAddress: ContactMailAddressRefView;
}

export interface ContactEmailView {
  readonly address: string;
  readonly label: string | null;
}

export interface ContactPhoneView {
  readonly number: string;
  readonly label: string | null;
}

export interface ContactPostalAddressView {
  readonly formatted: string;
  readonly label: string | null;
}

export interface ContactView {
  readonly id: string;
  readonly addressBook: ContactAddressBookRefView;
  readonly uid: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly emails: readonly ContactEmailView[];
  readonly phones: readonly ContactPhoneView[];
  readonly postalAddresses: readonly ContactPostalAddressView[];
  readonly urls: readonly string[];
  readonly note: string | null;
  readonly birthday: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContactPageView {
  readonly nodes: readonly ContactView[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface ContactFilterInput {
  readonly mailAddressIds?: readonly string[];
  readonly addressBookIds?: readonly string[];
  readonly query?: string;
  readonly email?: string;
}

export interface ContactEmailInput {
  readonly address: string;
  readonly label?: string;
}

export interface ContactPhoneInput {
  readonly number: string;
  readonly label?: string;
}

export interface ContactPostalAddressInput {
  readonly formatted: string;
  readonly label?: string;
}

export interface CreateAddressBookInput {
  readonly mailAddressId: string;
  readonly name: string;
  readonly description?: string;
}

export interface UpdateAddressBookInput {
  readonly name?: string;
  readonly description?: string;
}

export interface CreateContactInput {
  /** Required when `addressBookId` is omitted: targets that address's
   * default book, creating it if absent. */
  readonly mailAddressId?: string;
  /** Defaults to the target address's default book when omitted. */
  readonly addressBookId?: string;
  readonly displayName: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly nickname?: string;
  readonly organization?: string;
  readonly title?: string;
  readonly emails?: readonly ContactEmailInput[];
  readonly phones?: readonly ContactPhoneInput[];
  readonly postalAddresses?: readonly ContactPostalAddressInput[];
  readonly urls?: readonly string[];
  readonly note?: string;
  readonly birthday?: string;
}

/** Every field is an optional patch; the contact keeps its address book. */
export interface UpdateContactInput {
  readonly displayName?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly nickname?: string;
  readonly organization?: string;
  readonly title?: string;
  readonly emails?: readonly ContactEmailInput[];
  readonly phones?: readonly ContactPhoneInput[];
  readonly postalAddresses?: readonly ContactPostalAddressInput[];
  readonly urls?: readonly string[];
  readonly note?: string;
  readonly birthday?: string;
}

export interface CarddavAccountView {
  readonly id: string;
  readonly userId: string;
  readonly serverUrl: string;
  readonly username: string;
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CarddavDiscoveredAddressBookView {
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
}

/** An established local-to-remote link reported for one CardDAV account. */
export interface CarddavBookLinkView {
  readonly id: string;
  readonly accountId: string;
  readonly addressBookId: string;
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
}

export interface ConnectCarddavAccountResultView {
  readonly account: CarddavAccountView;
  readonly addressBooks: readonly CarddavDiscoveredAddressBookView[];
}

export interface CarddavSyncSummaryView {
  readonly pulled: number;
  readonly pushed: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly conflictsResolvedRemoteWins: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export interface ConnectCarddavAccountInput {
  readonly serverUrl: string;
  readonly username: string;
  readonly appPassword: string;
}

export interface LinkCarddavBookInput {
  readonly accountId: string;
  readonly remoteUrl: string;
  readonly mode: CarddavLinkMode;
  /** Required for `BIND_EXISTING`. */
  readonly addressBookId?: string;
  /** Required for `IMPORT_NEW`: the address whose new book the remote
   * collection binds to. */
  readonly mailAddressId?: string;
  readonly displayName?: string;
}
