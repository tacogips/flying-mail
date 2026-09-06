# Contacts Domain Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-contacts.md#domain-model
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-contacts.md (also see
design-docs/specs/design-user-mail-permissions.md for the permission model
`CONTACT_READ`/`CONTACT_WRITE` derive from)

### Summary
Domain layer for address books and contacts: branded IDs, the two new
`Capability` values, the `AddressBook` and `Contact` (+ `ContactEmail` /
`ContactPhone` / `ContactPostalAddress`) entities with their smart
constructors, and the CardDAV *client* sync entities (`CarddavAccount`,
`CarddavBookLink`, `CarddavContactState`, `CarddavDeletion`).

### Scope
**Included**: `packages/domain` additions only.
**Excluded**: the `0010_contacts.sql` migration (owned by
`contacts-adapter.md`), ports/use cases (`contacts-application.md`),
adapters (`contacts-adapter.md`), GraphQL/web. No CardDAV *server* entities;
mailcal remains a CardDAV client only. No contact groups, `PHOTO`, or
modeled `X-*` properties -- see the design doc's out-of-scope list.

---

## Tasks

### TASK-001: Branded IDs
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `packages/domain/src/value-objects/ids.ts` (extend):
```typescript
type AddressBookId = Brand<string, "AddressBookId">;
type ContactId = Brand<string, "ContactId">;
type CarddavAccountId = Brand<string, "CarddavAccountId">;
type CarddavBookId = Brand<string, "CarddavBookId">;

function createAddressBookId(value: string): AddressBookId;
function createContactId(value: string): ContactId;
function createCarddavAccountId(value: string): CarddavAccountId;
function createCarddavBookId(value: string): CarddavBookId;
```
`CarddavAccountId`/`CarddavBookId` are new, distinct brands. They follow the
existing `requireNonEmptyId` + caller-supplied-id pattern exactly.
**Completion Criteria**:
- [x] Four new brands and constructors added, alphabetically placed among
      the existing ones
- [x] Unit tests in `ids.test.ts`: valid non-empty values, empty-string
      rejection, per constructor

### TASK-002: `CONTACT_READ`/`CONTACT_WRITE` capabilities
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `packages/domain/src/entities/api-key.ts` (extend):
```typescript
enum Capability {
  // ...existing 12 members unchanged...
  ContactRead = "CONTACT_READ",
  ContactWrite = "CONTACT_WRITE",
}

type ContactCapability = Capability.ContactRead | Capability.ContactWrite;

const CONTACT_CAPABILITIES: readonly ContactCapability[];
function isContactCapability(capability: Capability): capability is ContactCapability;
```
`CONTACT_READ`/`CONTACT_WRITE` are **not** added to
`GLOBAL_CAPABILITIES`: like mail capabilities (and unlike templates), they
are per-address, matched against the address book's owning mail address.
**Completion Criteria**:
- [x] Capability enum grows from 12 to 14 members; existing values and
      their string literals are unchanged. `contacts-adapter.md` TASK-001
      rebuilds `api_key_scopes`' `CHECK` constraint (SQLite cannot widen
      one in place, same as the `0006`/`0007` precedent) from this exact
      14-member literal set -- any renamed or reordered existing literal
      here would desync that migration
- [x] `isGlobalCapability(ContactRead|ContactWrite)` is `false`
- [x] Unit test in `api-key.test.ts` pins the 14-member enum and the two
      new capabilities' global/non-global classification

### TASK-003: `AddressBook` and `Contact` entities
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**:
- `packages/domain/src/entities/address-book.ts` (new):
```typescript
interface AddressBook {
  readonly id: AddressBookId;
  readonly mailAddressId: MailAddressId;
  readonly name: string;            // 1..120
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface CreateAddressBookInput {
  readonly id: AddressBookId;
  readonly mailAddressId: MailAddressId;
  readonly name: string;
  readonly description?: string | null;
  readonly isDefault?: boolean;
  readonly createdAt: string;
  readonly updatedAt?: string;
}
function createAddressBook(input: CreateAddressBookInput): AddressBook;   // throws ValidationError
interface UpdateAddressBookInput {
  readonly name?: string;
  readonly description?: string | null;
}
function updateAddressBook(book: AddressBook, input: UpdateAddressBookInput, updatedAt: string): AddressBook;
```
  The "at most one default book per address" invariant is a repository-level
  unique index (surfaced as `CONFLICT` by the adapter/application layer),
  **not** enforced here -- the domain constructor has no way to see sibling
  rows.
- `packages/domain/src/entities/contact.ts` (new):
```typescript
interface ContactEmail { readonly address: EmailAddress; readonly label: string | null }
interface ContactPhone { readonly number: string; readonly label: string | null }        // number 1..50
interface ContactPostalAddress { readonly formatted: string; readonly label: string | null } // formatted 1..1000

interface Contact {
  readonly id: ContactId;
  readonly addressBookId: AddressBookId;
  readonly uid: string;                         // vCard UID, app-generated
  readonly displayName: string;                 // 1..500, FN
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly emails: readonly ContactEmail[];      // <=32, deduped case-insensitively by address
  readonly phones: readonly ContactPhone[];      // <=32
  readonly postalAddresses: readonly ContactPostalAddress[]; // <=32
  readonly urls: readonly string[];              // <=32, absolute http(s), deduplicated
  readonly note: string | null;                  // ..10000
  readonly birthday: string | null;              // YYYY-MM-DD
  readonly extraVcardLines: string | null;        // fidelity payload, never rendered raw
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface CreateContactInput {
  readonly id: ContactId;
  readonly addressBookId: AddressBookId;
  readonly uid: string;
  readonly displayName: string;
  readonly givenName?: string | null;
  readonly familyName?: string | null;
  readonly nickname?: string | null;
  readonly organization?: string | null;
  readonly title?: string | null;
  readonly emails?: readonly { readonly address: string; readonly label?: string | null }[];
  readonly phones?: readonly { readonly number: string; readonly label?: string | null }[];
  readonly postalAddresses?: readonly { readonly formatted: string; readonly label?: string | null }[];
  readonly urls?: readonly string[];
  readonly note?: string | null;
  readonly birthday?: string | null;
  readonly extraVcardLines?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}
function createContact(input: CreateContactInput): Contact;   // throws ValidationError, field-named
interface UpdateContactInput { /* same optional shape as CreateContactInput minus id/addressBookId/uid/createdAt */ }
function updateContact(contact: Contact, input: UpdateContactInput, updatedAt: string): Contact;
```
  Invariants (design doc "Domain model"): `displayName` non-empty after
  trim; each `emails[].address` goes through `createEmailAddress` and the
  list is deduplicated case-insensitively; `urls` must be absolute
  `http(s)`; every list capped at 32 (a hostile CardDAV server's
  vCard bomb must not become a megabyte row); `labels` are free text 1..40,
  never an enum -- an enum would drop iCloud's arbitrary labels on round
  trip. `extraVcardLines` is opaque to the domain: stored and returned
  verbatim, never parsed or validated here.
**Completion Criteria**:
- [x] `createAddressBook`/`updateAddressBook` use consistent entity shapes
      and error messages
- [x] `createContact` enforces every invariant above with a field-named
      `ValidationError`; `updateContact` re-validates by rebuilding via
      `createContact`
- [x] Unit tests: each invariant and its rejection, list-cap boundary
      (32 vs 33), case-insensitive email dedup, label length boundary
      (40 vs 41), all-optional-fields-omitted minimal contact

### TASK-004: CardDAV client entity family
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**: `packages/domain/src/entities/carddav-account.ts` (new):
```typescript
interface CarddavAccount {
  readonly id: CarddavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;   // ciphertext only
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
interface CarddavBookLink {
  readonly id: CarddavBookId;
  readonly accountId: CarddavAccountId;
  readonly addressBookId: AddressBookId;
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
}
interface CarddavContactState {
  readonly contactId: ContactId;
  readonly carddavBookId: CarddavBookId;
  readonly href: string;
  readonly etag: string | null;
  readonly lastSyncedAt: string;
  readonly remoteUnsupported: boolean;  // an unparsable-in-full vCard; import still lossless via extraVcardLines
}
interface CarddavDeletion {
  readonly carddavBookId: CarddavBookId;
  readonly href: string;
  readonly etag: string | null;
  readonly deletedAt: string;
}
interface CreateCarddavAccountInput {
  readonly id: CarddavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;
  readonly principalUrl?: string | null;
  readonly homeSetUrl?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}
function normalizeCarddavServerUrl(value: string): string;   // HTTPS, with localhost HTTP exception
function createCarddavAccount(input: CreateCarddavAccountInput): CarddavAccount;
```
`CarddavContactState.remoteUnsupported` means "this vCard's extra properties
are preserved but the row could not be fully modeled." Per the design doc,
a partially-modeled vCard still round-trips via
`extraVcardLines` and is **not** excluded from push; only a wholly
unparsable vCard is skipped. Document this distinction inline.
**Completion Criteria**:
- [x] `normalizeCarddavServerUrl` enforces the exact HTTPS/localhost rule
- [x] `createCarddavAccount` rejects an empty username or empty ciphertext
- [x] Unit tests: server URL normalization (https accepted, http rejected
      except localhost/127.0.0.1), empty username/ciphertext rejection

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Branded IDs | `packages/domain/src/value-objects/ids.ts` | DONE | `ids.test.ts` |
| Capabilities | `packages/domain/src/entities/api-key.ts` | DONE | `api-key.test.ts` |
| AddressBook + Contact | `packages/domain/src/entities/{address-book,contact}.ts` | DONE | `address-book.test.ts`, `contact.test.ts` |
| CarddavAccount family | `packages/domain/src/entities/carddav-account.ts` | DONE | `carddav-account.test.ts` |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | existing domain-model plan, `mail_addresses` (migration 0009) | Available |

## Completion Criteria

- [x] All tasks complete, unit tests passing (vitest run)
- [x] `bun run typecheck` and `biome check` pass
- [x] No touched file at 1000+ lines
- [x] `Capability` enum grows to exactly 14 members; no existing literal
      changed
- [x] `packages/domain/package.json` requires **no** `exports` edit: its
      `"./entities/*"` and `"./value-objects/*"` subpaths are wildcards,
      so `address-book.ts`, `contact.ts`, and `carddav-account.ts` (new
      files) and the extended `ids.ts`/`api-key.ts` (existing files) are
      all already resolvable -- verify this rather than assuming, since
      `packages/adapter` and `packages/infrastructure` use explicit,
      non-wildcard entries for several of their own subpaths and do
      require edits (see `contacts-adapter.md`, `contacts-graphql.md`)
- [x] No entity constructor generates an id, a timestamp, or a random
      value: every `createXxxInput` above takes `id`/`createdAt` (and any
      random-derived field) as a required caller-supplied argument, so
      the application layer's `RandomSource`/`Clock` ports remain the only
      source of either

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-contacts.md.

### Session: 2026-08-24 (later)
**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004 (all)
**Notes**: Implemented all four tasks in one pass.
`packages/domain/src/value-objects/ids.ts` gained `AddressBookId`,
`CarddavAccountId`, `CarddavBookId`, `ContactId` plus `ExternalAccountId`
(the sibling `external-mail-core.md` TASK-001 brand, added here per that
plan's explicit request to keep `ids.ts` single-owner this session) as one
alphabetically-ordered block, appended after the existing declarations
rather than fully re-sorting the pre-existing, non-alphabetical list (a
full re-sort was judged out of scope / needlessly disruptive for this
change). `api-key.ts` gained `Capability.ContactRead`/`ContactWrite`,
`ContactCapability`, `CONTACT_CAPABILITIES`, `isContactCapability`; the two
new values are not in `GLOBAL_CAPABILITIES`. Created `address-book.ts` and
`contact.ts` with every invariant from the design doc. Created
`carddav-account.ts`, including `normalizeCarddavServerUrl`. Colocated tests
added for all
five touched/new files. `bunx biome check packages/domain
--diagnostic-level=warn`, `bun run typecheck` (in `packages/domain`), and
`bunx vitest run packages/domain` all pass (31 test files, 490 tests). The
full repo `bun run test` has two pre-existing/expected failures outside
this plan's scope: `packages/infrastructure/src/graphql/schema.test.ts`
and `apps/api/src/server.test.ts` both fail because the `api_key_scopes`
SQL `CHECK` constraint and the GraphQL `Capability` enum do not yet know
about `CONTACT_READ`/`CONTACT_WRITE` -- both are explicitly owned by
`contacts-adapter.md` and `contacts-graphql.md` per this plan's Scope
section, not by this domain-layer plan.

## Related Plans

- **Next**: `contacts-application.md`, `contacts-adapter.md`
