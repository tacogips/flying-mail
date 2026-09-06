# Contacts Application Layer Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-contacts.md#ownership-model-per-mail-address-visible-across-addresses
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-contacts.md (permission derivation:
design-docs/specs/design-user-mail-permissions.md)

### Summary
Ports, authorization, use cases, and in-memory test fakes for address
books, contacts, and CardDAV client sync orchestration. Contact
authorization introduces **no second permission system**: `CONTACT_READ`/
`CONTACT_WRITE` are derived from the *existing* mail-permission machinery
(`MAIL_READ`/`MAIL_MANAGE` on the address book's owning mail address) for
`USER` viewers, and are explicit `ApiKeyScope` entries for `API_KEY`
viewers, matched by address exactly like a mail scope.

### Scope
**Included**: `packages/application` additions (ports, policies, usecases,
test-support), `AppDependencies` extension, `UseCases` aggregation hook.
**Excluded**: concrete adapters (`contacts-adapter.md`), the migration
(also `contacts-adapter.md`), GraphQL, web. `dependencies.ts` (the
`AppDependencies` *interface*) and the `usecases.ts` aggregation spread are
owned here; the *concrete* wiring in
`composition/build-dependencies.ts` is `contacts-graphql.md` TASK-003.

---

## Tasks

### TASK-001: Ports and AppDependencies
**Status**: Completed
**Parallelizable**: Yes (needs `contacts-domain` TASK-003/004 types)
**Deliverables**:
- `packages/application/src/ports/address-book-repository.ts` (new):
```typescript
interface AddressBookRepository {
  findById(id: AddressBookId): Promise<AddressBook | null>;
  findDefaultForMailAddress(mailAddressId: MailAddressId): Promise<AddressBook | null>;
  listByMailAddresses(mailAddressIds: readonly MailAddressId[]): Promise<readonly AddressBook[]>;
  /** Every book on an address a USER viewer's mail-permission rules admit
   * (baseline ADMIN sees all), or an API-key viewer's CONTACT_READ/WRITE
   * scopes admit -- the two mechanisms are pushed down exactly like
   * `MessageListFilter.allowedPatterns` + `.mailPermissionFilter`. */
  listReadable(filter: AddressBookListFilter): Promise<readonly AddressBook[]>;
  save(book: AddressBook): Promise<void>;
  delete(id: AddressBookId): Promise<void>;
  countContacts(id: AddressBookId): Promise<number>;
}
interface AddressBookListFilter {
  readonly mailAddressIds?: readonly MailAddressId[];
  readonly allowedPatterns: readonly AddressPattern[] | null;
  readonly mailPermissionFilter: MailPermissionFilter | null;
}
```
- `packages/application/src/ports/contact-repository.ts` (new):
```typescript
interface ContactRepository {
  findById(id: ContactId): Promise<Contact | null>;
  findByUid(addressBookId: AddressBookId, uid: string): Promise<Contact | null>;
  /** Atomic write of the contact row plus its emails/phones/postal
   * addresses/urls child rows in one batch. */
  createContact(contact: Contact): Promise<void>;
  updateContact(contact: Contact): Promise<void>;
  deleteContact(id: ContactId): Promise<void>;
  listByAddressBook(addressBookId: AddressBookId): Promise<readonly Contact[]>;
  /** Cross-address "who is this?" lookup via the indexed `contact_emails.address`
   * column, restricted to `addressBookIds`. */
  listByEmail(address: EmailAddress, addressBookIds: readonly AddressBookId[]): Promise<readonly Contact[]>;
  /** Cursor-paginated, filtered listing over a caller-resolved set of
   * readable address books -- authorization has already happened by the
   * time this is called. */
  listPage(input: ContactListPageInput): Promise<ContactPage>;
}
interface ContactListPageInput {
  readonly addressBookIds: readonly AddressBookId[];
  readonly query?: string;   // name/org/email substring
  readonly email?: EmailAddress;
  readonly first: number;
  readonly after?: string;
}
interface ContactPage {
  readonly nodes: readonly Contact[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}
```
- `packages/application/src/ports/carddav.ts` (new), with CardDAV-specific names:
```typescript
interface CarddavAccountRepository {
  findAccountById(id: CarddavAccountId): Promise<CarddavAccount | null>;
  listAccountsByUser(userId: UserId): Promise<readonly CarddavAccount[]>;
  saveAccount(account: CarddavAccount): Promise<void>;
  deleteAccount(id: CarddavAccountId): Promise<void>;
  findBookLinkById(id: CarddavBookId): Promise<CarddavBookLink | null>;
  findBookLinkByAddressBook(addressBookId: AddressBookId): Promise<CarddavBookLink | null>;
  listBookLinksByAccount(accountId: CarddavAccountId): Promise<readonly CarddavBookLink[]>;
  saveBookLink(link: CarddavBookLink): Promise<void>;
  deleteBookLink(id: CarddavBookId): Promise<void>;
  findContactState(contactId: ContactId): Promise<CarddavContactState | null>;
  findContactStateByHref(carddavBookId: CarddavBookId, href: string): Promise<CarddavContactState | null>;
  listContactStates(carddavBookId: CarddavBookId): Promise<readonly CarddavContactState[]>;
  saveContactState(state: CarddavContactState): Promise<void>;
  deleteContactState(contactId: ContactId): Promise<void>;
  addDeletion(deletion: CarddavDeletion): Promise<void>;
  listDeletions(carddavBookId: CarddavBookId): Promise<readonly CarddavDeletion[]>;
  removeDeletion(carddavBookId: CarddavBookId, href: string): Promise<void>;
}
interface CarddavCredentials { readonly serverUrl: string; readonly username: string; readonly password: string }
interface RemoteAddressBookRef { readonly credentials: CarddavCredentials; readonly remoteUrl: string }
interface CarddavDiscoveredAddressBook { readonly remoteUrl: string; readonly displayName: string | null; readonly ctag: string | null; readonly syncToken: string | null }
interface CarddavDiscovery { readonly principalUrl: string | null; readonly homeSetUrl: string | null; readonly addressBooks: readonly CarddavDiscoveredAddressBook[] }
interface CarddavObject { readonly href: string; readonly etag: string | null; readonly vcard: string }
interface CarddavChangeSet { readonly changedHrefs: readonly string[]; readonly deletedHrefs: readonly string[]; readonly syncToken: string | null; readonly ctag: string | null; readonly fullResync: boolean }
type CarddavPutOutcome = "CREATED" | "UPDATED" | "CONFLICT";
interface CarddavPutResult { readonly outcome: CarddavPutOutcome; readonly etag: string | null }
type CarddavDeleteOutcome = "DELETED" | "CONFLICT" | "ALREADY_ABSENT";
interface CarddavDeleteResult { readonly outcome: CarddavDeleteOutcome }
class CarddavAuthError extends Error {}
class CarddavTransportError extends Error { readonly cause?: unknown }
interface CarddavClient {
  discover(credentials: CarddavCredentials): Promise<CarddavDiscovery>;
  listChanges(book: RemoteAddressBookRef, syncToken: string | null): Promise<CarddavChangeSet>;
  multigetContacts(book: RemoteAddressBookRef, hrefs: readonly string[]): Promise<readonly CarddavObject[]>;
  putContact(book: RemoteAddressBookRef, href: string, vcard: string, etag: string | null): Promise<CarddavPutResult>;
  deleteContact(book: RemoteAddressBookRef, href: string, etag: string | null): Promise<CarddavDeleteResult>;
}
```
- `packages/application/src/ports/vcard-codec.ts` (new):
```typescript
interface ParsedVcardContact {
  readonly uid: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly emails: readonly { readonly address: string; readonly label: string | null }[];
  readonly phones: readonly { readonly number: string; readonly label: string | null }[];
  readonly postalAddresses: readonly { readonly formatted: string; readonly label: string | null }[];
  readonly urls: readonly string[];
  readonly note: string | null;
  readonly birthday: string | null;
  /** Every unsupported line (PHOTO, X-*, item1.-grouped, ...) verbatim,
   * folded/unfolded but otherwise untouched, for round-trip fidelity. */
  readonly extraVcardLines: string | null;
  /** True only when the vCard could not be parsed at all. A
   * partially-modeled vCard is NOT flagged here; it imports what it can
   * and keeps the rest in extraVcardLines. */
  readonly unparsable: boolean;
}
interface VcardCodec {
  parseVcard(vcard: string): ParsedVcardContact | null;   // null when unparsable
  formatVcard(contact: Contact): string;                  // vCard 3.0 output (iCloud's dialect)
}
```
- `packages/application/src/dependencies.ts` (extend): add
  `addressBookRepository`, `contactRepository`, `carddavAccountRepository`,
  `carddavClient`, `vcardCodec` to `AppDependencies`. `credentialCipher` is
  **reused** as-is -- no new field.
**Completion Criteria**:
- [x] Ports contain no adapter imports; typecheck passes
- [x] `CarddavAuthError`/`CarddavTransportError` have stable shapes for
      `translateCarddavError` (TASK-004)

### TASK-002: Authorization rules
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**: `packages/application/src/policies/authorization.ts`
(extend, single choke point):
```typescript
interface ContactBookOwnerRef {
  readonly mailAddressId: MailAddressId;
  readonly address: EmailAddress;
  readonly domainId: DomainId;
}
/** Maps CONTACT_READ -> MAIL_READ, CONTACT_WRITE -> MAIL_MANAGE: the mail
 * capability a USER viewer's existing permission rules must grant for the
 * corresponding contact capability to hold. */
function mailCapabilityForContact(capability: ContactCapability): Capability.MailRead | Capability.MailManage;

function authorizesContactCapability(viewer: Viewer, capability: ContactCapability, owner: ContactBookOwnerRef): boolean;
function authorizesContactRead(viewer: Viewer, owner: ContactBookOwnerRef): boolean;
function authorizesContactWrite(viewer: Viewer, owner: ContactBookOwnerRef): boolean;
function requireContactWrite(viewer: Viewer, owner: ContactBookOwnerRef): void;   // throws ForbiddenError

/** USER-viewer listing filter, reusing mailPermissionListFilter under the
 * mapped mail capability; `null` for an API-key viewer (which instead uses
 * the existing readableAddressPatterns/scopedDomainIds under the CONTACT_*
 * capability directly -- no new function needed for that half). */
function contactPermissionListFilter(viewer: Viewer, capability: ContactCapability): MailPermissionFilter | null;
```
`authorizesContactCapability` for a `USER` viewer is a thin wrapper over
the **existing** `authorizesAnyAddress(viewer, mailCapabilityForContact(capability), owner.domainId, [owner.address])`
-- this is the concrete mechanism behind the design doc's "no second
permission system" claim, and it is why this task has no dependency on a
new per-resource permission table. For an `API_KEY` viewer it is
`scopesAuthorize(viewer.scopes, {
capability, domainId: owner.domainId, address: owner.address })` -- an
explicit `CONTACT_READ`/`CONTACT_WRITE` scope, exactly like a mail scope.
CardDAV *account* management adds
`requireCarddavAccountUser(viewer): UserId` (USER-viewer-only: an API key
must not exfiltrate a person's iCloud credential).
**Completion Criteria**:
- [x] Matrix unit tests: ADMIN (baseline, all books minus DENY),
      MEMBER (ALLOW-scoped read+write), VIEWER (ALLOW-scoped read only,
      never write), DENY-beats-ADMIN, API-key with CONTACT_READ only,
      API-key with CONTACT_WRITE, mail-only API-key (no contact access at
      all), unauthorized read -> caller reports NOT_FOUND (this function
      itself is non-throwing for reads)
- [x] No change to existing mail/template authorization tests

### TASK-003: Address book + contact use cases
**Status**: Completed
**Parallelizable**: No (depends on TASK-002)
**Deliverables**:
- `packages/application/src/usecases/contact-access.ts` (new): resolves a
  book's owning mail address into
  a `ContactBookOwnerRef` (via `mailAddressRepository.findById` +
  `mailDomainRepository` for `domainId`), memoized per call; exports
  `createContactAccessContext()`, `resolveAddressBookOwner`,
  `canReadAddressBook`, `loadReadableAddressBook`, `loadWritableAddressBook`,
  `listReadableAddressBooks`, `loadReadableContact`, `loadWritableContact`
  (the last two resolve a contact's parent book, then delegate).
- `packages/application/src/usecases/address-books.ts` (new):
  `listAddressBooks(viewer, mailAddressId?)`, `createAddressBook`
  (requires contact write on the owning address; enforces the "one default
  per address" rule by catching the repository's `CONFLICT` on the
  partial-unique-index violation, translated via `translateDomainError`),
  `updateAddressBook`, `deleteAddressBook` (hard delete, cascades contacts).
- `packages/application/src/usecases/contacts.ts` (new):
```typescript
interface ListContactsInput {
  readonly mailAddressIds?: readonly MailAddressId[];
  readonly addressBookIds?: readonly AddressBookId[];
  readonly query?: string;
  readonly email?: string;
  readonly first?: number;
  readonly after?: string;
}
function createListContactsUseCase(deps): (viewer: Viewer, input: ListContactsInput) => Promise<ContactPage>;
function createGetContactUseCase(deps): (viewer: Viewer, id: ContactId) => Promise<Contact | null>;
function createCreateContactUseCase(deps): (viewer: Viewer, input: CreateContactUseCaseInput) => Promise<Contact>;
function createUpdateContactUseCase(deps): (viewer: Viewer, id: ContactId, input: UpdateContactUseCaseInput) => Promise<Contact>;
function createDeleteContactUseCase(deps): (viewer: Viewer, id: ContactId) => Promise<boolean>;
function createLookupContactsByEmailUseCase(deps): (viewer: Viewer, email: string) => Promise<readonly Contact[]>;
```
  Omitting both `mailAddressIds` and `addressBookIds` in `listContacts`
  yields the merged cross-address view: resolve
  `listReadableAddressBooks(deps, viewer)` first, then pass their ids to
  `ContactRepository.listPage`. `createContact` with no `addressBookId`
  resolves (or lazily creates, named `"Contacts"`) the caller's target
  address's default book via `AddressBookRepository.findDefaultForMailAddress`
  -- the single-book case needs no book management at all, per the design
  doc. `deleteContact` on a CardDAV-linked contact additionally records a
  `carddav_deletions` tombstone (looked up via
  `carddavAccountRepository.findBookLinkByAddressBook`); a contact in an
  unlinked book skips that step. `lookupContactsByEmail` restricts to the
  viewer's readable books, same authorization path as `listContacts`.
**Completion Criteria**:
- [x] Use-case tests over fakes: default-book auto-creation, default-book
      CONFLICT on a second explicit default, cross-address merged listing,
      cascade delete, tombstone recorded only for CardDAV-linked contacts,
      viewer-scoped `lookupContactsByEmail`
- [x] IDs generated at the application layer (random port), never in the domain

### TASK-004: CardDAV use cases
**Status**: Completed
**Parallelizable**: No (depends on TASK-003)
**Deliverables**:
- `packages/application/src/usecases/carddav.ts` (new):
```typescript
interface ConnectCarddavAccountInput { readonly serverUrl: string; readonly username: string; readonly appPassword: string }
interface ConnectCarddavAccountResult { readonly account: CarddavAccount; readonly addressBooks: readonly CarddavDiscoveredAddressBook[] }
type LinkRemoteAddressBookMode = "IMPORT_NEW" | "BIND_EXISTING";
interface LinkRemoteAddressBookInput {
  readonly accountId: CarddavAccountId;
  readonly remoteUrl: string;
  readonly mode: LinkRemoteAddressBookMode;
  readonly addressBookId?: AddressBookId;   // required for BIND_EXISTING
  readonly displayName?: string | null;
}
function translateCarddavError(error: unknown): never;   // CarddavAuthError -> BAD_USER_INPUT, CarddavTransportError -> SERVICE_UNAVAILABLE
function requireCipher(deps): void;                        // shared credential availability check
function loadCarddavCredentials(deps, account: CarddavAccount): Promise<CarddavCredentials>;
function createListCarddavAccountsUseCase(deps): (viewer: Viewer) => Promise<readonly CarddavAccount[]>;
function createConnectCarddavAccountUseCase(deps): (viewer: Viewer, input: ConnectCarddavAccountInput) => Promise<ConnectCarddavAccountResult>;
function createListRemoteAddressBooksUseCase(deps): (viewer: Viewer, accountId: CarddavAccountId) => Promise<readonly CarddavBookLink[]>;
function createLinkRemoteAddressBookUseCase(deps): (viewer: Viewer, input: LinkRemoteAddressBookInput) => Promise<CarddavBookLink>;
function createUnlinkRemoteAddressBookUseCase(deps): (viewer: Viewer, id: CarddavBookId) => Promise<boolean>;
function createDisconnectCarddavAccountUseCase(deps): (viewer: Viewer, id: CarddavAccountId) => Promise<boolean>;
```
  Discovery runs before persistence; the server URL is validated
  (https-only) *before* the credential goes on
  the wire; a `BIND_EXISTING` `remoteUrl` is constrained to the connected
  account's own origin; disconnecting an account leaves local address
  books and contacts untouched.
- `packages/application/src/usecases/carddav-sync.ts` (new):
```typescript
interface SyncCarddavBookResult {
  readonly pulled: number;
  readonly pushed: number;
  readonly deleted: number;
  readonly skipped: number;          // wholly unparsable vCards only
  readonly conflictsResolvedRemoteWins: number;
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
const MAX_OBJECTS_PER_SYNC = 500;    // request-budget cap
function createSyncCarddavBookUseCase(deps): (viewer: Viewer, carddavBookId: CarddavBookId) => Promise<SyncCarddavBookResult>;
```
  Pull/push structure uses `pull`/`push`/`pushDeletions`/
  `resolveRemoteWins` internals. A vCard is always one contact and one href;
  a
  partially-modeled vCard (`ParsedVcardContact.unparsable === false` but
  carrying `extraVcardLines`) still imports **and is still pushed** --
  only `unparsable === true` is counted in `skipped` and excluded from
  both directions. Upsert key is `(addressBookId, uid)` via
  `ContactRepository.findByUid`.
**Completion Criteria**:
- [x] Sync tests with a scripted fake `CarddavClient`: initial import,
      incremental pull, both-sides-changed remote-wins conflict, 412 on
      push, local delete tombstone push, remote delete, unparsable vCard
      excluded from both push and the `pulled` count (but not from
      `extraVcardLines`-only partial import, which *is* pushed)
- [x] Credentials never appear in a result or a thrown error

### TASK-005: Test-support fakes and aggregation
**Status**: Completed
**Parallelizable**: No (depends on TASK-001 for fake shapes, TASK-004 for
the full use-case surface to aggregate)
**Deliverables**:
- `packages/application/src/test-support/contact-fakes.ts` (new):
  in-memory `fakeAddressBookRepository`, `fakeContactRepository`,
  `fakeCarddavAccountRepository`, `scriptedCarddavClient(script)`,
  `identityVcardCodec` (or a minimal real codec passthrough sufficient for
  deterministic use-case tests).
- `packages/application/src/test-support/fakes.ts` (extend):
  `createFakeDependencies()` includes the five new fakes plus
  `vcardCodec`.
- `packages/application/src/usecases/contact-usecases.ts` (new):
```typescript
interface ContactUseCases {
  readonly listAddressBooks: (viewer: Viewer, mailAddressId?: MailAddressId) => Promise<readonly AddressBook[]>;
  readonly createAddressBook: (viewer: Viewer, input: CreateAddressBookUseCaseInput) => Promise<AddressBook>;
  readonly updateAddressBook: (viewer: Viewer, id: AddressBookId, input: UpdateAddressBookUseCaseInput) => Promise<AddressBook>;
  readonly deleteAddressBook: (viewer: Viewer, id: AddressBookId) => Promise<boolean>;
  readonly listContacts: (viewer: Viewer, input: ListContactsInput) => Promise<ContactPage>;
  readonly getContact: (viewer: Viewer, id: ContactId) => Promise<Contact | null>;
  readonly createContact: (viewer: Viewer, input: CreateContactUseCaseInput) => Promise<Contact>;
  readonly updateContact: (viewer: Viewer, id: ContactId, input: UpdateContactUseCaseInput) => Promise<Contact>;
  readonly deleteContact: (viewer: Viewer, id: ContactId) => Promise<boolean>;
  readonly lookupContactsByEmail: (viewer: Viewer, email: string) => Promise<readonly Contact[]>;
  readonly listCarddavAccounts: (viewer: Viewer) => Promise<readonly CarddavAccount[]>;
  readonly connectCarddavAccount: (viewer: Viewer, input: ConnectCarddavAccountInput) => Promise<ConnectCarddavAccountResult>;
  readonly listRemoteAddressBooks: (viewer: Viewer, accountId: CarddavAccountId) => Promise<readonly CarddavBookLink[]>;
  readonly linkRemoteAddressBook: (viewer: Viewer, input: LinkRemoteAddressBookInput) => Promise<CarddavBookLink>;
  readonly unlinkRemoteAddressBook: (viewer: Viewer, id: CarddavBookId) => Promise<boolean>;
  readonly syncCarddavBook: (viewer: Viewer, carddavBookId: CarddavBookId) => Promise<SyncCarddavBookResult>;
  readonly disconnectCarddavAccount: (viewer: Viewer, id: CarddavAccountId) => Promise<boolean>;
}
function createContactUseCases(deps: AppDependencies): ContactUseCases;
```
- `packages/application/src/usecases.ts` (extend): add `ContactUseCases` to
  `UseCases`; `createUseCases` spreads `...createContactUseCases(deps)`.
**Completion Criteria**:
- [x] Fakes honor authz-relevant shapes (address/domain fields present)
- [x] Existing fake consumers (mail/template tests) unaffected
- [x] `usecases.ts` gains one spread line and one `extends` clause, no
      inline duplication of the contact surface

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Ports | `packages/application/src/ports/{address-book-repository,contact-repository,carddav,vcard-codec}.ts` | DONE | - |
| Authorization | `packages/application/src/policies/authorization.ts` | DONE | `policies/authorization.test.ts` |
| Address book + contact use cases | `packages/application/src/usecases/{contact-access,address-books,contacts}.ts` | DONE | `usecases/address-books.test.ts`, `usecases/contacts.test.ts` |
| CardDAV use cases | `packages/application/src/usecases/{carddav,carddav-sync}.ts` | DONE | `usecases/carddav.test.ts`, `usecases/carddav-sync.test.ts` |
| Fakes + aggregation | `packages/application/src/test-support/contact-fakes.ts`, `packages/application/src/usecases/contact-usecases.ts` | DONE | exercised transitively by all use-case tests above |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `contacts-domain.md` TASK-001..004, `design-user-mail-permissions.md` machinery (existing) | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] `usecases.ts` stays under 1000 lines (bulk in `contact-usecases.ts`)
- [x] No new per-resource permission table introduced; contact
      authorization is provably a function of existing `UserMailPermission`
      rows and `ApiKeyScope` rows only
- [x] `packages/application/package.json` requires **no** `exports` edit:
      `"./ports/*"`, `"./usecases/*"`, and `"./test-support/*"` are
      wildcards, so every new file in this plan resolves without a
      package.json change; only `dependencies.ts` and `usecases.ts`
      (existing, already-exported files) are modified
- [x] Every id passed into a domain `createXxx` call in TASK-003/004 comes
      from `deps.random.uuid()`, and every timestamp from
      `deps.clock.now().toISOString()`, at the use-case call site -- never
      generated inside `packages/domain`

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-contacts.md.

### Session: 2026-08-24 (implementation)
**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005 (all)
**Notes**:
- Ports (`address-book-repository.ts`, `contact-repository.ts`,
  `carddav.ts`, `vcard-codec.ts`) added; `AppDependencies` extended with
  `addressBookRepository`, `contactRepository`, `carddavAccountRepository`,
  `carddavClient`, `vcardCodec` (reusing `credentialCipher`).
- Authorization: `mailCapabilityForContact`, `authorizesContactCapability`
  (+ Read/Write/require variants), `contactPermissionListFilter`,
  `requireCarddavAccountUser` added to `policies/authorization.ts` and
  re-exported from `policies/index.ts`. No new permission table -- USER
  viewers derive through the existing mail-permission machinery, API keys
  through explicit `CONTACT_READ`/`CONTACT_WRITE` scopes.
- `usecases/contact-access.ts`, `usecases/address-books.ts`, and
  `usecases/contacts.ts` implemented. Simplification vs. the plan text:
  `resolveAddressBookOwner`
  needs only `mailAddressRepository.findById` (not `mailDomainRepository`
  too) because `MailAddress.domainId` is never null.
- `usecases/carddav.ts`, `usecases/carddav-sync.ts` implemented. Deviation
  from the plan's literal
  `LinkRemoteAddressBookInput` shape: added a `mailAddressId` field
  (required for `IMPORT_NEW`) because `AddressBook.mailAddressId` has no
  default; the plan's snippet omitted this, which would leave
  `IMPORT_NEW` unable to pick a target mail address.
- `test-support/contact-fakes.ts` (fakes + `scriptedCarddavClient` +
  `identityVcardCodec`, a JSON-round-trip codec made a reusable default since
  it has no failure mode to guard against), `test-support/fakes.ts`
  extended, `usecases/contact-usecases.ts` (+ `usecases.ts` `extends`/spread)
  added. Also added `test-support/contact-fixtures.ts` (not separately
  listed in the plan) to share seeding
  across the four new use-case test files without duplication.
- Tests added: `policies/authorization.test.ts` (contact capability
  matrix, +12 tests), `usecases/address-books.test.ts` (15),
  `usecases/contacts.test.ts` (14), `usecases/carddav.test.ts` (15),
  `usecases/carddav-sync.test.ts` (10). `bunx vitest run packages/application`
  is 488/488 green; `bunx tsc --noEmit` and
  `biome check packages/application --diagnostic-level=warn` are both clean.
- Known, explicitly out-of-scope consequence: extending `AppDependencies`
  breaks `tsc --noEmit` (not `vitest`) on
  `packages/infrastructure/src/composition/build-dependencies.ts`, which
  does not yet construct the five new fields -- that wiring is
  `contacts-graphql.md` TASK-003, per this plan's stated split. Vitest for
  `packages/infrastructure`/`apps/api` still passes in full (192/192)
  because vitest transpiles rather than type-checks.

## Related Plans

- **Depends On**: `contacts-domain.md`
- **Next**: `contacts-adapter.md`, `contacts-graphql.md`
