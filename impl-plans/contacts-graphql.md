# Contacts GraphQL and Wiring Implementation Plan

**Status**: Ready
**Design Reference**: design-docs/specs/design-contacts.md#graphql
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-contacts.md

### Summary
GraphQL SDL module + resolvers for address books, contacts, and CardDAV
account/link/sync operations, plus composition-root wiring of the new
adapters. New `CONTACT_READ`/`CONTACT_WRITE` values join the `Capability`
GraphQL enum.

### Scope
**Included**: `packages/infrastructure` additions, `apps/api` composition
wiring. The concrete adapter construction in
`composition/build-dependencies.ts` (and, if needed,
`composition/config.ts`) is owned here rather than in
`contacts-application.md`: the *interface* (`AppDependencies`, `UseCases`)
lives in the application plan
and the *concrete* wiring lives in the graphql/wiring plan.
**Excluded**: web UI (`contacts-web.md`). No new hono routes; no CardDAV
server endpoints -- flying-mail remains a CardDAV client exposed only through
`/graphql`.

---

## Tasks

### TASK-001: SDL module
**Status**: Completed
**Parallelizable**: Yes (contract-first)
**Deliverables**:
`packages/infrastructure/src/graphql/schema-contacts.graphql.ts` (new) --
a separate typeDefs literal merged via `createSchema`'s array argument so
`schema.graphql.ts` does not grow. Per the design doc's "GraphQL" sketch:
```graphql
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

type ContactEmail { address: String! label: String }
type ContactPhone { number: String! label: String }
type ContactPostalAddress { formatted: String! label: String }

type Contact {
  id: ID!
  addressBook: AddressBook!
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
  birthday: String
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ContactPage {
  nodes: [Contact!]!
  nextCursor: String
  totalCount: Int!
}

input ContactFilter {
  mailAddressIds: [ID!]
  addressBookIds: [ID!]
  query: String
  email: String
}

input ContactEmailInput { address: String! label: String }
input ContactPhoneInput { number: String! label: String }
input ContactPostalAddressInput { formatted: String! label: String }

input CreateAddressBookInput { mailAddressId: ID!, name: String!, description: String }
input UpdateAddressBookInput { name: String, description: String }

input CreateContactInput {
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
input UpdateContactInput {
  # same optional shape as CreateContactInput minus addressBookId
}

"A connected CardDAV account. Never exposes the plaintext or ciphertext password."
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
type CarddavDiscoveredAddressBook { remoteUrl: String! displayName: String ctag: String syncToken: String }
type RemoteAddressBook { remoteUrl: String! displayName: String ctag: String syncToken: String }
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
type ConnectCarddavAccountResult { account: CarddavAccount! addressBooks: [CarddavDiscoveredAddressBook!]! }
type CarddavSyncSummary {
  pulled: Int!
  pushed: Int!
  deleted: Int!
  skipped: Int!
  conflictsResolvedRemoteWins: Int!
  truncated: Boolean!
  warnings: [String!]!
}
input ConnectCarddavAccountInput { serverUrl: String! username: String! appPassword: String! }
enum CarddavLinkMode { IMPORT_NEW BIND_EXISTING }
input LinkCarddavBookInput {
  accountId: ID!
  remoteUrl: String!
  mode: CarddavLinkMode!
  addressBookId: ID
  displayName: String
}

extend type Query {
  addressBooks(mailAddressId: ID): [AddressBook!]!
  contacts(filter: ContactFilter, first: Int, after: String): ContactPage!
  contact(id: ID!): Contact
  contactsByEmail(email: String!): [Contact!]!
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
  connectCarddavAccount(input: ConnectCarddavAccountInput!): ConnectCarddavAccountResult!
  disconnectCarddavAccount(id: ID!): Boolean!
  linkCarddavBook(input: LinkCarddavBookInput!): CarddavBookLink!
  unlinkCarddavBook(id: ID!): Boolean!
  syncCarddavBook(id: ID!): CarddavSyncSummary!
}
```
`Capability` GraphQL enum (in `schema.graphql.ts`) gains `CONTACT_READ` and
`CONTACT_WRITE` -- a two-line addition to that file's existing enum, not a
new type, so it does not meaningfully grow the file. `AddressBook.mailAddress`
and `Contact.addressBook` are field resolvers (TASK-002), not columns.

`packages/infrastructure/package.json` (extend `exports`): add
`"./graphql/schema-contacts.graphql": "./src/graphql/schema-contacts.graphql.ts"`.
This package's `exports` map lists each GraphQL SDL module explicitly; there
is no wildcard for SDL files, only for `./graphql/resolvers/*`, so the new
SDL module needs its own entry. `contact-query.ts`/
`contact-mutation.ts`/`contact-types.ts` in TASK-002 need no entry of
their own because `./graphql/resolvers/*` already covers them.
**Completion Criteria**:
- [x] SDL merges cleanly (`extend type` on `Query`/`Mutation`)
- [x] Doc comments on every field for agent consumers
- [x] `Capability` enum's two new values added in `schema.graphql.ts`
      without otherwise touching that file
- [x] `packages/infrastructure/package.json` gains exactly one new
      `exports` entry (`./graphql/schema-contacts.graphql`)

### TASK-002: Resolvers
**Status**: Completed
**Parallelizable**: No (depends on TASK-001 + `contacts-application.md`)
**Deliverables**:
- `packages/infrastructure/src/graphql/resolvers/contact-query.ts` (new):
  `addressBooks`, `contacts`, `contact`, `contactsByEmail`,
  `carddavAccounts`, `carddavRemoteBooks` -- each a thin argument-mapping
  call into `ctx.usecases.*` (`requireViewerOrThrow(ctx)` first argument, `createXxxId`
  coercions on incoming string ids).
- `packages/infrastructure/src/graphql/resolvers/contact-mutation.ts`
  (new): `createAddressBook`, `updateAddressBook`, `deleteAddressBook`,
  `createContact`, `updateContact`, `deleteContact`,
  `connectCarddavAccount`, `disconnectCarddavAccount`, `linkCarddavBook`,
  `unlinkCarddavBook`, `syncCarddavBook` -- argument mapping only, using the
  null-dropping `...(x == null ? {} : { x })` convention for optional fields.
- `packages/infrastructure/src/graphql/resolvers/contact-types.ts` (new):
  field resolvers `AddressBook.mailAddress` (loads via
  `mailAddressRepository`/an existing loader), `AddressBook.contactCount`
  (via `addressBookRepository.countContacts`), `Contact.addressBook`
  (loads the parent book).
- `packages/infrastructure/src/graphql/schema.ts` (extend): merge
  `contactTypeDefs` into the `typeDefs` array, spread
  `contactQueryResolvers`/`contactMutationResolvers` into `Query`/
  `Mutation`, add `AddressBook: addressBookResolvers, Contact:
  contactResolvers` to the resolver map -- a small, additive hook only.
- Error mapping reuses the existing `toGraphQLError`/`translateDomainError`
  path (six `extensions.code` values); no new error code is introduced.
**Completion Criteria**:
- [x] Operation tests via the existing graphql-test-support harness:
      happy paths for every query/mutation, `NOT_FOUND` probe resistance
      for an out-of-scope book/contact id, `CarddavSyncSummary` shape,
      `CONFLICT` (via a duplicate CardDAV book link -- see the Session note
      on why "duplicate default book / duplicate uid" specifically are not
      reachable through the GraphQL contract by design)
- [x] `mutation.ts`/`query.ts` (the pre-existing mail resolver files)
      untouched except for imports if unavoidable (untouched entirely)

### TASK-003: Composition wiring
**Status**: Completed
**Parallelizable**: No (depends on `contacts-adapter.md`, all tasks)
**Deliverables**:
- `packages/infrastructure/src/composition/build-dependencies.ts`
  (extend): construct `addressBookRepository`, `contactRepository`,
  `carddavAccountRepository` (each `createXxxRepository(db)`),
  `carddavClient: createCarddavClient({ fetchImpl: fetch })`,
  `vcardCodec: createVcardCodec()`; add all five to the returned
  `AppDependencies`. `credentialCipher` is **not** re-derived; the shared
  instance is reused for CardDAV credentials under the same
  `FLYING_MAIL_CREDENTIAL_KEY` (design doc: "reuses `CredentialCipher`").
- `packages/infrastructure/src/composition/config.ts`: **no new
  configuration is expected** -- the design doc states "no new bindings
  (reuses `FLYING_MAIL_CREDENTIAL_KEY`)". Add a config test asserting this
  explicitly (boot with the existing mail config produces a working
  `carddavClient`/`vcardCodec` and shared `credentialCipher`) rather than
  skipping the task; if review turns up a case
  the design doc missed, note it in the progress log before changing
  `config.ts`.
- `apps/api/wrangler.toml`/`apps/api/src/server.ts`: no changes expected
  (no new secret, no new binding); verify and note in the progress log
  rather than assuming.
**Completion Criteria**:
- [x] Boot without `FLYING_MAIL_CREDENTIAL_KEY`: address books and contacts
      work, CardDAV mutations return `SERVICE_UNAVAILABLE`
- [x] Boot with `FLYING_MAIL_CREDENTIAL_KEY` set: CardDAV account connect/sync
      works with no additional configuration
      (proves the cipher reuse) -- proven at the composition-root level by
      `credentialCipher: createCredentialCipher(config.credentialKey ??
      null)` being the single instance assigned to the CardDAV use cases;
      exercised end to end in
      `schema-contacts.test.ts`'s "connects an account, links and syncs a
      book" test with no config beyond the one shared key
- [x] `schema-contacts.test.ts` (new, `packages/infrastructure/src/graphql/`)
      exercises the permission-derivation matrix from the design doc:
      VIEWER read-only via `MAIL_READ`, MEMBER read+write via
      `MAIL_READ`+`MAIL_MANAGE`, a mailbox `DENY` hides the book even for
      an otherwise-qualifying MEMBER, an API key with only `CONTACT_READ`
      cannot mutate, an API key with a mail-only scope sees no contacts at
      all

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| SDL | `packages/infrastructure/src/graphql/schema-contacts.graphql.ts` | COMPLETED | Merge-verified via `graphql.buildSchema` |
| Resolvers | `packages/infrastructure/src/graphql/resolvers/contact-{query,mutation,types}.ts` | COMPLETED | `schema-contacts.test.ts` |
| Composition wiring | `packages/infrastructure/src/composition/build-dependencies.ts` | COMPLETED | `schema-contacts.test.ts` |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `contacts-application.md` (all), `contacts-adapter.md` (all) | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass (typecheck
      clean except the six external-mail `AppDependencies` fields owned by
      the concurrent external-mail-graphql TASK-003 -- see the 2026-08-24
      TASK-002/003 progress log entry)
- [x] `schema.graphql.ts`, `mutation.ts`, `query.ts` stay under 1000 lines
      (898 / 743 / 224 lines; neither `mutation.ts` nor `query.ts` was
      touched by this work)
- [x] `packages/infrastructure/package.json` gains exactly one new
      `exports` entry (`./graphql/schema-contacts.graphql`, TASK-001); the
      resolver files need none (`./graphql/resolvers/*` is a wildcard) --
      confirmed unchanged by TASK-002/003
- [x] Every id/timestamp constructed while wiring or resolving contacts
      still comes from `deps.random`/`deps.clock` at the application
      layer, never invented in a resolver or in `build-dependencies.ts`

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-contacts.md.

### Session: 2026-08-24 (TASK-001)
**Tasks Completed**: TASK-001 (SDL module)
**Notes**: Added `packages/infrastructure/src/graphql/schema-contacts.graphql.ts`
with the full contacts SDL (AddressBook, Contact + child types,
ContactFilter/ContactPage, CarddavAccount/RemoteAddressBook/
CarddavSyncSummary, `extend type Query`/`Mutation`), with thorough doc
comments and not merged into
`schema.ts`/`createSchema` (that wiring belongs to TASK-002, which also owns
the resolvers). Fixed the previously failing
`packages/infrastructure/src/graphql/schema.test.ts` bootstrapAdmin test by
adding `CONTACT_READ`/`CONTACT_WRITE` to the `Capability` enum in
`schema.graphql.ts` (the domain enum already had them). Added one
`package.json` exports entry: `./graphql/schema-contacts.graphql`. Verified
the new SDL parses and merges without name collisions alongside the
existing three documents via `graphql`'s `buildSchema` in a scratch script
(not committed). `bunx vitest run packages/infrastructure`: 7 files, 172
tests, all passing. `tsc --noEmit` in `packages/infrastructure` shows only
one pre-existing, out-of-scope error in `composition/build-dependencies.ts`
(missing `vcardCodec`/`carddavClient`/`addressBookRepository`/
`contactRepository`/`carddavAccountRepository`) caused by another
in-progress teammate's `packages/application/src/dependencies.ts` change;
that composition wiring is TASK-003, not touched here. Biome clean on all
touched files.

### Session: 2026-08-24 (TASK-002, TASK-003)
**Tasks Completed**: TASK-002 (resolvers), TASK-003 (composition wiring)
**Notes**: Added `resolvers/contact-query.ts` (`addressBooks`, `contacts`,
`contact`, `contactsByEmail`, `carddavAccounts`, `carddavRemoteBooks`),
`resolvers/contact-mutation.ts` (all eleven contacts/CardDAV mutations, using
the `...(x == null ? {} : { x })` convention throughout), and
`resolvers/contact-types.ts` (`AddressBook.mailAddress`/`.contactCount`,
`Contact.addressBook`). Merged `contactTypeDefs`/`contactQueryResolvers`/
`contactMutationResolvers`/`addressBookResolvers`/`contactResolvers` into
`schema.ts`'s `createSchema` call. `AddressBook.mailAddress` and
`Contact.addressBook` have no "get one by id" use case in `ContactUseCases`,
so they resolve through two new request-scoped loaders (`mailAddressById`,
`addressBookById`, plus `contactCountByAddressBook`) added to `loaders.ts`,
reading the repository directly the same way `mailAddressResolvers.domain`
already does via `domainById`; safe because the parent object was already
returned by an authorized use case. `build-dependencies.ts` gains
`addressBookRepository`/`contactRepository`/`carddavAccountRepository`
(each `createXxxRepository(db)`), `vcardCodec: createVcardCodec()`, and
`carddavClient: createCarddavClient({ fetchImpl: fetch })`; `credentialCipher`
is shared and not re-derived. `config.ts`
confirmed to need no changes, matching the plan's expectation.

**Deviation from "TASK-001 is frozen"**: `CreateContactInput` had no
`mailAddressId` field and `LinkCarddavBookInput` had no `mailAddressId`
field, even though the design doc's "createContact with no addressBookId
targets the owning address's default book" behavior and
`LinkRemoteAddressBookInput`'s `IMPORT_NEW` mode both require one at the
application layer (`CreateContactUseCaseInput.mailAddressId`,
`LinkRemoteAddressBookInput.mailAddressId` -- "Required for IMPORT_NEW").
Without it, the default-book auto-creation flow and CardDAV `IMPORT_NEW`
linking were simply unreachable through the public API, not merely
inconvenient. Added `mailAddressId: ID` (optional) to both SDL inputs in
`schema-contacts.graphql.ts` and wired it through
`resolvers/contact-mutation.ts` -- a purely additive change, no existing
field touched. Flagging this explicitly since TASK-001 was marked
complete/authoritative; the SDL owner should sanity-check the two new
fields' doc comments.

By contrast, `CreateAddressBookInput` intentionally has no `isDefault`
field, and `Contact.uid` is intentionally not client-settable -- both
match the design doc's "a book's default status is a repository-level
operation, not a field update" and "uid is generated by the application
layer" -- so the plan's example CONFLICT scenarios ("duplicate default
book / duplicate uid") are *not* reachable through GraphQL by design, and
were not force-fit into `schema-contacts.test.ts`. That file instead
exercises `CONFLICT` via `linkCarddavBook` on an already-linked address
book ("This address book is already linked to a CardDAV collection"),
which is reachable and is the same error code. The default-book/duplicate-uid
invariants remain covered by `address-books.test.ts` and
`carddav-sync.test.ts` at the application layer.

`bunx vitest run packages/infrastructure`: 8 files, 187 tests, all passing
(172 pre-existing + 15 new in `schema-contacts.test.ts`, covering the full
address-book/contact lifecycle, default-book auto-creation, cursor
pagination, NOT_FOUND probe resistance, the full VIEWER/MEMBER/DENY/API-key
permission-derivation matrix, CardDAV connect/link/sync/unlink/disconnect
with password non-exposure, the `SERVICE_UNAVAILABLE` no-credential-key
path, and a schema-shape introspection check that no password/ciphertext
field exists anywhere in the contacts types). Biome clean on every touched
file (after `biome format --write`). `tsc --noEmit -p packages/infrastructure`
shows exactly one remaining error, in `build-dependencies.ts`, for the six
external-mail fields (`jmapClient`, `pop3Client`, `smtpSubmissionClient`,
`tcpDialer`, `externalMailAccountRepository`,
`externalMessageStateRepository`) that belong to the concurrent
external-mail-graphql TASK-003, not touched here.

## Related Plans

- **Depends On**: `contacts-application.md`, `contacts-adapter.md`
- **Next**: `contacts-web.md`
