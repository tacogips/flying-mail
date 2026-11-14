# Contacts Web Client Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-contacts.md#web-client
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-contacts.md

### Summary
SolidJS `/contacts` route: an address-book-filterable, cross-address
merged contact list with search, a contact editor dialog, CardDAV
account/link management, and a message-view "who is this sender?" lookup
hook, over the GraphQL API.

### Scope
**Included**: `apps/web` additions (route, pages, components, store, api
documents/types) and an additive hook into the existing message view.
**Excluded**: server-side code. No contact-groups, photo, or free-form
extension-property UI, matching the domain's excluded scope.

---

## Tasks

### TASK-001: API documents and types
**Status**: Completed
**Parallelizable**: Yes (contract from `contacts-graphql.md` TASK-001 SDL)
**Deliverables**:
- `apps/web/src/api/contact-documents.ts` (new): string operation
  documents for every contact/address-book/CardDAV query and mutation in
  the SDL (`addressBooks`, `contacts`, `contact`, `contactsByEmail`,
  `carddavAccounts`, `carddavRemoteBooks`, and all eleven mutations),
  following the existing naming convention
  (`SCREAMING_SNAKE_CASE` constants ending `_QUERY`/`_MUTATION`).
- `apps/web/src/api/contact-types.ts` (new): hand-written TS types
  mirroring the SDL (no codegen) -- `AddressBookView`, `ContactView`,
  `ContactEmailView`/`ContactPhoneView`/`ContactPostalAddressView`,
  `ContactPageView`, `ContactFilterInput`, `CreateContactInput`/
  `UpdateContactInput` and their child-list input shapes,
  `CarddavAccountView`, `CarddavBookLinkView`,
  `ConnectCarddavAccountResultView`, `CarddavSyncSummaryView`,
  `CarddavLinkMode`.
- `documents.ts`/`schema-types.ts` (the mail-side files) untouched.
**Completion Criteria**:
- [x] Types compile under maximum strictness; names mirror the SDL exactly
- [x] Every mutation/query in `schema-contacts.graphql.ts` has exactly one
      corresponding document constant

### TASK-002: Contact store
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**: `apps/web/src/store/contact-store.ts` (new): signals for
the address-book rail selection (a specific book id, a specific mail
address's "all its books", or the cross-address "All contacts" entry),
the loaded `ContactPageView` (with its cursor), the search `query` signal,
dialog state, and the CardDAV account/link lists; actions
`loadAddressBooks`, `loadContacts(options?: { force?: boolean })`
(re-fetches on `query`/selection change, cursor-appends on `loadMore`),
`createAddressBook`/`updateAddressBook`/`deleteAddressBook`,
`createContact`/`updateContact`/`deleteContact` (optimistic patch of the
loaded page with rollback on failure), `lookupContactsByEmail(address)`
(a bare query call with no store-side caching -- the message-view hook in
TASK-005 owns its own short-lived cache), `carddav` actions
(`connectCarddavAccount`, `disconnectCarddavAccount`, `linkCarddavBook`,
`unlinkCarddavBook`, `syncCarddavBook` surfacing `CarddavSyncSummaryView`
via a toast). This store is **not** registered in `app-store.ts` or
`store-context.tsx`'s
global provider -- it is instantiated by `contacts-page.tsx` itself, so a
mailbox-only visitor does not pay for it.
**Completion Criteria**:
- [x] Store unit tests: rail-selection-driven re-fetch, optimistic
      create/update/delete with rollback on a failed mutation, cursor
      pagination (`loadMore` appends, a rail change resets the cursor)

### TASK-003: Views and components
**Status**: Completed
**Parallelizable**: No (depends on TASK-002)
**Deliverables**:
- Route `/contacts` (`AuthGuard`, `lazy`) added to `apps/web/src/app.tsx`;
  a topbar navigation entry added in `apps/web/src/components/topbar.tsx`.
- `apps/web/src/pages/contacts-page.tsx` (new): instantiates
  `contact-store.ts` (see TASK-002) and lays out the rail + list +
  detail/editor panes.
- `apps/web/src/components/contacts/` (new directory), each with a
  sibling `.css` reusing `styles/tokens.css`:
  - `address-book-rail.tsx`: "All contacts" entry plus one entry per
    readable mail address, its books nested underneath when an address
    has more than one.
  - `contact-list.tsx`: name-sorted list, search box bound to
    `query`, per-contact email chips, click selects into the detail pane.
  - `contact-detail.tsx`: read-only rendering of the modeled fields for
    the selected contact, with an edit affordance that opens
    `contact-dialog.tsx` (TASK-004) -- read-only entirely for a VIEWER
    role, matching the design doc's permission table.
**Completion Criteria**:
- [x] Rail selection filters the list correctly for a single address, a
      single book under a multi-book address, and "All contacts"
- [x] Search box filters via `ContactFilter.query` (server-side, not a
      client-side re-filter of an already-loaded page)
- [x] A VIEWER-role signed-in user sees no create/edit/delete affordances
      anywhere on this page (gated on the `CONTACT_WRITE` capability, which a
      VIEWER never holds per the design's permission table)

### TASK-004: Contact editor dialog and CardDAV settings
**Status**: Completed
**Parallelizable**: No (depends on TASK-003)
**Deliverables**:
- `apps/web/src/components/contacts/contact-dialog.tsx` (new): display
  name, given/family name, nickname, organization, title, repeatable
  email/phone/postal-address rows (each with a free-text label field, not
  a dropdown -- per the design doc, labels are free text so an enum would
  drop iCloud's arbitrary labels), repeatable URL rows, note, birthday
  (date picker), address-book select (defaults to the book the contact
  was opened from, or the target address's default book for a new
  contact created from "All contacts"). No photo field, no group/`MEMBER`
  field -- out of scope per the design doc.
- `apps/web/src/components/contacts/carddav-settings.tsx` (new):
  connect account (server URL defaulting to `contacts.icloud.com`,
  Apple-ID username, app-specific password -- input never persisted
  client-side), list discovered remote address books, link/unlink to a
  local book, per-link "Sync now" button rendering the
  `CarddavSyncSummaryView`, delete account.
**Completion Criteria**:
- [x] Email address fields validate the `EmailAddress` format client-side
      before submit (server re-validates regardless, per the domain
      invariants); duplicate case-insensitive emails are rejected/deduped
      in the UI before submit, matching the domain's dedup rule
- [x] `apps/web` `bun run build` (vite build) passes
- [x] `bun run --cwd apps/web test` green

### TASK-005: Message-view contact lookup hook
**Status**: Completed
**Parallelizable**: Yes (needs only TASK-001's contract; independent of
the store and pages built in TASK-002..004)
**Deliverables**:
- `apps/web/src/lib/contact-lookup.ts` (new): a small module wrapping
  `CONTACTS_BY_EMAIL_QUERY` with a short-lived in-memory cache keyed by
  normalized address (per-session, not persisted), so re-rendering the
  same message view does not re-query on every paint.
- `apps/web/src/components/message-view.tsx` (extend, additive only):
  next to each rendered sender/recipient address (`formatMailbox`/
  `formatRecipients`, per the existing imports), resolve through
  `contact-lookup.ts`; a match renders the contact's `displayName`
  alongside the raw address and links to `/contacts?contactId=...` (or an
  equivalent deep-link the `contacts-page.tsx` router `search` param
  understands). No match renders exactly as today -- this task must not
  change the no-match rendering path.
**Completion Criteria**:
- [x] A message from/to an address matching an existing contact shows
      that contact's name in `message-view.tsx`
- [x] An address with no matching contact renders identically to the
      current (pre-contacts) behavior -- a snapshot/regression test on
      the no-match path
- [x] The lookup never blocks initial message render (resolves
      asynchronously, message body and controls are interactive
      immediately)

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| API layer | `apps/web/src/api/contact-{documents,types}.ts` | DONE | covered indirectly by store/lookup tests |
| Store | `apps/web/src/store/contact-store.ts` | DONE | `contact-store.test.ts` (19 tests) |
| Views | `apps/web/src/pages/contacts-page.tsx`, `apps/web/src/components/contacts/{address-book-rail,contact-list,contact-detail}.tsx` | DONE | exercised via store tests + typecheck/build; no dedicated component test (no smoke-test precedent existed before this feature) |
| Dialog + CardDAV UI | `apps/web/src/components/contacts/{contact-dialog,carddav-settings}.tsx` | DONE | exercised via store tests (`createContact`/`updateContact`/`linkCarddavBook`) + typecheck/build |
| Message-view lookup | `apps/web/src/lib/contact-lookup.ts`, `apps/web/src/components/message-view.tsx` | DONE | `contact-lookup.test.ts` (7 tests), `message-view.test.tsx` (3 tests, incl. no-match regression) |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `contacts-graphql.md` TASK-001/002 (live API for manual verify; TASK-001 SDL is enough to start TASK-001/005 here) | Pending |

## Completion Criteria

- [x] All tasks complete; web tests green; vite build passes
- [x] typecheck + biome pass; no file at 1000+ lines
- [x] No attendee/RSVP-style field anywhere (not applicable to contacts,
      but the CardDAV settings UI must not accrue a photo/group field
      either -- both are explicitly out of scope)

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-contacts.md.

### Session: 2026-08-24 (implementation)
**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005 (all)
**Notes**:
- Built `api/contact-documents.ts` / `api/contact-types.ts` against
  `schema-contacts.graphql.ts` exactly, including the `mailAddressId`
  field that landed on `CreateContactInput`/`LinkCarddavBookInput` mid-session
  (the SDL and `contact-mutation.ts` resolver were updated concurrently by
  another agent; the web types and `carddav-settings.tsx`'s link-target
  select were adjusted to match once that landed).
- `store/contact-store.ts`: rail selection (`ALL`/`ADDRESS`/`BOOK`), cursor
  pagination, genuinely optimistic update/delete with rollback (create
  patches in on success only, since there is no safe placeholder
  `ContactView` to roll back from), CardDAV account/link actions. Pure
  helpers `groupAddressBooks` and `filterForSelection` are exported and
  unit-tested directly. The store is instantiated inside `contacts-page.tsx`,
  not the global app store.
- The address-book rail is built entirely from the unfiltered `addressBooks`
  query grouped by mail address (`AddressBook.mailAddress`); there is no
  separate "list of readable mail addresses" endpoint available to a
  non-`DOMAIN_ADMIN` viewer (`mailAddresses` requires `DOMAIN_ADMIN`), so an
  address with zero books has no rail entry yet, and a `CardDAV` `IMPORT_NEW`
  link can only target an address that already has at least one book. This
  matches the design's "the common single-book case needs no book
  management at all" framing but is a real edge case worth flagging: the
  very first book on a fresh instance must come from `createContact` (or an
  agent/admin call), not from the CardDAV import UI.
- `/contacts` route registered `lazy()` behind `AuthGuard` in `app.tsx`, with
  a "Contacts" link added to `topbar.tsx`.
- `UpdateContactInput` carries no `addressBookId`, so the contact dialog only
  offers the address-book select for a *new* contact; editing shows the
  existing book as read-only text.
- Extended the shared `Capability` union in `api/schema-types.ts` with
  `CONTACT_READ`/`CONTACT_WRITE` (already present server-side in
  `schema.graphql.ts`) and `scope-format.ts`'s `CAPABILITY_LABELS` map, since
  both are `apps/web`-scoped and the union is otherwise non-exhaustive.
  `/contacts` gates every create/edit/delete affordance on
  `viewer.capabilities.includes("CONTACT_WRITE")`.
- Message-view hook (`lib/contact-lookup.ts`) wraps `contactsByEmail` with a
  per-session, TTL'd, in-flight-deduplicated cache; `message-view.tsx` is
  extended additively (a `Show`-gated hint next to the sender, a separate
  sibling line for matched recipients) so the no-match path's DOM is
  byte-for-byte what it was before contacts existed.
- Tests: `contact-store.test.ts` (19), `contact-lookup.test.ts` (7),
  `message-view.test.tsx` (3, using `solid-js/web`'s own `render` -- no new
  test dependency, since no `@solidjs/testing-library` precedent existed in
  this repo). Full `apps/web` suite: 224 tests green. Scoped typecheck
  (`bunx tsc --noEmit` in `apps/web`), `biome check apps/web
  --diagnostic-level=warn`, and `bun run build` (vite) all clean.
- Files created: `api/contact-documents.ts`, `api/contact-types.ts`,
  `store/contact-store.ts` (+ `.test.ts`), `pages/contacts-page.tsx`,
  `components/contacts/{address-book-rail,contact-list,contact-detail,
  contact-dialog,carddav-settings}.tsx`, `components/contacts/contacts.css`,
  `lib/contact-lookup.ts` (+ `.test.ts`), `components/message-view.test.tsx`.
  Files modified: `app.tsx`, `components/topbar.tsx`,
  `components/message-view.{tsx,css}`, `api/schema-types.ts`,
  `lib/scope-format.ts`.

## Related Plans

- **Depends On**: `contacts-graphql.md`
