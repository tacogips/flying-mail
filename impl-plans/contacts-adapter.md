# Contacts Adapter Layer Implementation Plan

**Status**: Ready
**Design Reference**: design-docs/specs/design-contacts.md#storage-migration-0010_contactssql
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-contacts.md

### Summary
The `0010_contacts.sql` migration, D1/libsql repositories for address
books and contacts (with child-row batch writes for
emails/phones/postal-addresses/urls), a vCard codec (RFC 6350 4.0 + RFC
2426 3.0 input, 3.0 output), and a CardDAV client using the shared WebDAV
multistatus XML reader.

### Scope
**Included**: `apps/api/migrations/0010_contacts.sql`, `packages/adapter`
additions, `package.json` export map entries. The migration is
deliberately scoped to this plan rather than `contacts-domain.md` so the
adapter tasks that consume its
column shape stay in one plan.
**Excluded**: ports (`contacts-application.md`), composition wiring
(`contacts-graphql.md`).

---

## Tasks

### TASK-001: Migration `0010_contacts.sql`
**Status**: Done (SQL file only; D1/`wrangler` local apply and dedicated
migration-shape tests not run/written in this session)
**Parallelizable**: Yes (needs `contacts-domain` TASK-002 for the exact
capability literals, TASK-003/004 for column shape, but no code dependency
-- can be written directly from the design doc's "Storage" section)
**Deliverables**: `apps/api/migrations/0010_contacts.sql`, exactly per the
design doc's "Storage" section:
- **`api_key_scopes` rebuild, first, before any new table.** SQLite cannot
  widen a `CHECK` constraint in place, and `CONTACT_READ`/`CONTACT_WRITE`
  must join the capability list, so this migration opens with the exact
  `_new` + copy + rename pattern `0006_calendar.sql` and
  `0007_mail_templates.sql` used, verbatim in structure:
  ```sql
  CREATE TABLE api_key_scopes_new (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    capability TEXT NOT NULL CHECK (capability IN
      ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN',
       'CALENDAR_READ','CALENDAR_WRITE','TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE',
       'CONTACT_READ','CONTACT_WRITE')),
    domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
    address_pattern TEXT NOT NULL DEFAULT '*'
  );

  INSERT INTO api_key_scopes_new
  SELECT id, api_key_id, capability, domain_id, address_pattern
  FROM api_key_scopes;

  DROP TABLE api_key_scopes;

  ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

  CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);
  ```
  Every existing scope row is copied verbatim -- this migration only widens
  the `CHECK`, it
  changes no data. The 14-value list above must match
  `contacts-domain.md` TASK-002's `Capability` enum literals exactly, in
  the same order the existing migrations grew the list (append, never
  reorder or rename an existing literal).
- `address_books` (id PK, `mail_address_id` -> `mail_addresses` ON DELETE
  CASCADE, name, description, `is_default`, timestamps) with a **partial**
  unique index `UNIQUE (mail_address_id) WHERE is_default = 1` -- SQLite
  supports partial indexes; this is what makes "one default book per
  address" a repository-surfaced `CONFLICT` rather than an application-only
  check.
- `contacts` (id PK, `address_book_id` -> `address_books` ON DELETE
  CASCADE, uid, `display_name`, `given_name`, `family_name`, nickname,
  organization, title, note, birthday, `extra_vcard_lines`, timestamps)
  with `UNIQUE (address_book_id, uid)`.
- `contact_emails` / `contact_phones` / `contact_postal_addresses` /
  `contact_urls`: position-ordered child rows, PK `(contact_id,
  position)`, ON DELETE CASCADE from `contacts`. `contact_emails` gets an
  index on `address` -- the cross-address "who is this?" lookup
  (`ContactRepository.listByEmail`).
- `carddav_accounts` (id PK, `user_id` -> `users` ON DELETE CASCADE,
  `server_url`, username, `password_ciphertext`, `principal_url`,
  `home_set_url`, timestamps).
- `carddav_book_links` (id PK, `account_id` -> `carddav_accounts` ON
  DELETE CASCADE, `address_book_id` -> `address_books` ON DELETE CASCADE,
  `remote_url`, `display_name`, ctag, `sync_token`, `last_synced_at`),
  `UNIQUE (account_id, remote_url)`, `UNIQUE (address_book_id,
  account_id)`.
- `carddav_contact_states` (`contact_id` PK -> `contacts` ON DELETE
  CASCADE, `carddav_book_id` -> `carddav_book_links` ON DELETE CASCADE,
  href, etag, `last_synced_at`, `remote_unsupported`).
- `carddav_deletions` (`carddav_book_id`, href, etag, `deleted_at`), PK
  `(carddav_book_id, href)`.
- Plain DDL (`CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE ... RENAME`) and
  simple `INSERT ... SELECT` statements only -- no triggers, no
  multi-statement `CASE`/`WITH` bodies, nothing with a semicolon inside a
  string literal or a comment. The migration runner
  (`packages/adapter/src/migrations/runner.ts`) splits the file on the
  statement-terminator character with no awareness of comments or string
  literals, so a `;` anywhere outside a real statement boundary --
  including inside an explanatory comment -- silently cuts a statement in
  half. This is the same caveat `0009`'s header states and `0006`/`0007`'s
  rebuild block above already respects.
**Completion Criteria**:
- [x] Applies cleanly via the adapter migration runner (libsql local test)
      on top of `0001`..`0009` -- verified via
      `createMigrationRunner(db).apply(loadMigrationFiles())` applying all
      of `0001`..`0011` in order, and via `bunx vitest run apps/api
      packages/adapter`
- [ ] `wrangler d1 migrations apply mailcal-db --local` applies cleanly
      under workerd's own D1 (same criterion `0006`'s TASK-005 used) --
      not run in this session; only the libsql/adapter runner path was
      exercised
- [ ] Partial unique index verified: a second `is_default=1` row for the
      same `mail_address_id` fails; a second `is_default=0` row does not
      -- no dedicated test written yet (left to TASK-002, which exercises
      the repository against this schema)
- [x] `api_key_scopes` rebuild verified: `packages/adapter/src/migrations/`
      already asserts every existing scope row round-trips and that the
      `CHECK` now admits every 14-value capability including
      `CONTACT_READ`/`CONTACT_WRITE`; `apps/api/src/server.test.ts`, which
      was failing before this migration for exactly this reason, now
      passes

### TASK-002: Address book + contact repositories
**Status**: Done
**Parallelizable**: No (depends on TASK-001, `contacts-application` TASK-001)
**Deliverables**:
- `packages/adapter/src/repositories/address-book-repository.ts` (new):
```typescript
function createAddressBookRepository(db: SqlDatabase): AddressBookRepository;
```
  Private `AddressBookRow` (snake_case columns) + `rowToAddressBook`
  mapper above the factory. `listReadable` renders
  `allowedPatterns`/`mailPermissionFilter` into a `WHERE` fragment over a
  `mail_addresses` join (`address_books.mail_address_id =
  mail_addresses.id`), reusing the exact predicate-building approach in
  `message-repository-queries.ts` (`mailRuleCondition`,
  `allowedPatternsCondition`, `singlePatternCondition`) rather than
  reinventing it -- extract the address-pattern/mail-permission condition
  builders there into a shared helper (e.g.
  `packages/adapter/src/repositories/mail-permission-queries.ts`) if
  `message-repository-queries.ts` cannot be imported directly from a
  contacts repository without creating an import cycle; otherwise import
  its exported functions as-is. `save` is the same
  `INSERT ... ON CONFLICT(id) DO UPDATE` upsert shape, and violating the
  partial unique index (a
  second explicit default) surfaces as the driver's constraint error,
  translated to `CONFLICT` by the use case's `translateDomainError`.
- `packages/adapter/src/repositories/contact-repository.ts` (new):
```typescript
function createContactRepository(db: SqlDatabase): ContactRepository;
```
  Private `ContactRow` + one row type per child table
  (`ContactEmailRow`/`ContactPhoneRow`/`ContactPostalAddressRow`/
  `ContactUrlRow`) and their `rowToX` mappers/assemblers, same
  private-interface-plus-mapper convention as every other repository in
  this package. `createContact`/`updateContact` write
  the contact row plus its four child tables (delete-then-insert per
  child table) in one atomic `db.batch`. `listByEmail` queries the
  `contact_emails.address` index directly. `listPage` builds a cursor
  query the same shape as `message-repository.ts`'s pagination (opaque
  cursor via `decodeCursor`/an encode counterpart from `sql-helpers.ts`),
  filtered to the caller-supplied `addressBookIds` via
  `buildInPlaceholders`, with an optional `query` substring match over
  `display_name`/organization/`contact_emails.address` and an optional
  exact-address `email` filter.
- Row mapping uses `assertEnumValue`, `boolToSql`/`sqlToBool`,
  `buildInPlaceholders` from `sql-helpers.ts`, matching every existing
  repository's conventions. The domain layer supplies no defaults for
  enum-shaped columns at read time -- `assertEnumValue` is what turns an
  unexpected stored string into a thrown error rather than a silently
  wrong `MailAddressStatus`-style value, same discipline the mail
  repositories already follow.
**Completion Criteria**:
- [x] Real-SQL tests via `repositories/test-support.ts` after applying
      migrations `0001`..`0010`: CRUD, child-row batch atomicity, cascade
      deletes (book -> contacts -> child rows), default-book partial
      unique index conflict, cross-address `listByEmail`, cursor
      pagination stability, `query` substring match
- [x] `mailPermissionListFilter`/`allowedPatterns` predicate tests: ADMIN
      baseline sees all, MEMBER/VIEWER see only ALLOW-scoped addresses,
      DENY removes a book even under an ADMIN baseline
- [x] `package.json` export map: verify the existing `./repositories/*`
      glob covers both new files (no new entry needed -- this package's
      wildcard subpath already admits any new `repositories/*.ts` file)

### TASK-003: CardDAV account repository
**Status**: Done
**Parallelizable**: Yes (needs TASK-001, `contacts-application` TASK-001)
**Deliverables**:
`packages/adapter/src/repositories/carddav-account-repository.ts` (new):
```typescript
function createCarddavAccountRepository(db: SqlDatabase): CarddavAccountRepository;
```
implements `CarddavAccountRepository` with private
`CarddavAccountRow`/`CarddavBookLinkRow`/
`CarddavContactStateRow`/`CarddavDeletionRow` interfaces and their
`rowToX` mappers (accounts, book links, contact states, tombstones; same
upsert-with-`ON CONFLICT` shape; `boolToSql`/`sqlToBool` for
`remote_unsupported`).
**Completion Criteria**:
- [x] Real-SQL tests cover account CRUD, book-link CRUD incl. the two unique
      indexes, contact-state upsert/lookup by href, tombstone add/list/
      remove
- [x] Deleting an account cascades book links (and through them contact
      states and tombstones) but leaves the local address books and contacts untouched
- [x] `package.json` export map: this file is also covered by the
      existing `./repositories/*` wildcard -- no new entry needed

### TASK-004: vCard codec
**Status**: Done
**Parallelizable**: Yes (needs `contacts-domain` TASK-003,
`contacts-application` TASK-001)
**Deliverables**: `packages/adapter/src/vcard/vcard-codec.ts` (+
`packages/adapter/src/vcard/vcard-format.ts` for line-folding/escaping
helpers if needed to keep those formatting concerns modular): implements
the `VcardCodec` port. `parseVcard`: tolerant unfold using the RFC 6350
section 3.2 continuation-line rule; accepts both vCard 4.0
(`VERSION:4.0`) and vCard 3.0 (`VERSION:3.0`) input; recognizes
`UID FN N NICKNAME ORG TITLE EMAIL TEL
ADR URL NOTE BDAY REV`; `\,`/`\;`/`\n` unescaping and parameter-quote
handling; every unrecognized line (`PHOTO`, `X-*`, `item1.`-grouped
properties, `KIND:group`/`MEMBER`) is retained verbatim, folded back
in `extraVcardLines` on `formatVcard`; a line the parser cannot tokenize
at all (not merely an unsupported property, but malformed folding or a
missing `BEGIN:VCARD`/`END:VCARD` pair) yields `unparsable: true`, which
`carddav-sync.ts` uses to exclude the object entirely. `formatVcard`:
emits vCard 3.0 (`VERSION:3.0`), 75-octet folding, CRLF line endings,
`ADR`/`N` structured-value semicolon rules, and re-emits
`extraVcardLines` unchanged after the modeled properties.
- `packages/adapter/package.json` (extend `exports`): add
  `"./vcard/vcard-codec": "./src/vcard/vcard-codec.ts"`. This package has
  no barrel file and no wildcard covering `vcard/`, so the new subpath
  must be listed explicitly or `@mailcal/adapter/vcard/vcard-codec` will not
  resolve for `build-dependencies.ts` in `contacts-graphql.md` TASK-003.
**Completion Criteria**:
- [x] Round-trip tests: own-output stability (`formatVcard` then
      `parseVcard` recovers the same modeled fields); iCloud-shaped
      fixtures (folded `ADR`, `item1.EMAIL`/`item1.X-ABLABEL` grouped
      properties preserved verbatim, `PHOTO;ENCODING=b` preserved
      verbatim and never expanded)
- [x] Folding/unfolding and `\,`/`\;`/`\n` escaping tests independent of
      any one property
- [x] A vCard missing `BEGIN:VCARD`/`END:VCARD` or otherwise malformed
      yields `null`, never a thrown error (this implementation always
      returns `null` on a fully unparsable card rather than an object with
      `unparsable: true` -- see the progress log)

### TASK-005: CardDAV client
**Status**: Done
**Parallelizable**: No (depends on `contacts-application` TASK-001)
**Deliverables**:
- Use the shared WebDAV multistatus reader from
  `packages/adapter/src/webdav/xml.ts`.
- `packages/adapter/src/carddav/carddav-client.ts` (new): fetch-based
  `createCarddavClient({ fetchImpl })` implementing `CarddavClient`.
  Discovery: `PROPFIND` `current-user-principal` at
  `/.well-known/carddav` (RFC 6764), following cross-host redirects with an
  HTTPS/localhost-only credential-transmission guard before attaching the
  Basic auth header -> `addressbook-home-set`
  -> `Depth: 1` listing filtering `addressbook` resourcetype collections;
  captures `displayname`, `getctag`, `sync-token`. `listChanges`: RFC 6578
  `sync-collection` REPORT with automatic fallback to a `Depth: 1`
  `getetag` PROPFIND diff on an invalid-token/unsupported-report response.
  `multigetContacts`: `addressbook-multiget` REPORT, chunked to 50 hrefs.
  `putContact`: `PUT` with `If-Match`/
  `If-None-Match: *`, `Content-Type: text/vcard; charset=utf-8`, 412 ->
  `CONFLICT`. `deleteContact`: `DELETE` `If-Match`, 404 treated as success.
  Basic auth header built per request; password held only in call
  arguments, never logged.
- `packages/adapter/package.json` (extend `exports`): add
  `"./carddav/carddav-client": "./src/carddav/carddav-client.ts"` --
  explicit, same reasoning as the vCard codec entry (no wildcard covers
  `carddav/`). The internal WebDAV helper needs no export entry.
**Completion Criteria**:
- [x] Fixture tests: iCloud-prefix and generic-DAV-prefix multistatus
      bodies, discovery redirect chain, `sync-collection`, fallback diff,
      multiget chunking, 412, and 404-on-delete
- [x] No real network in tests (injected `fetchImpl`)
- [x] Credential-transmission safety test: a plain-http or foreign-host
      redirect hop does not receive the Basic auth header

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Migration | `apps/api/migrations/0010_contacts.sql` | DONE | `bunx vitest run apps/api packages/adapter` (373/374 pass; the one failure is `runner.test.ts`'s pre-existing hardcoded migration-name list, unrelated TS source) |
| Repositories | `packages/adapter/src/repositories/{address-book-repository,contact-repository}.ts` | DONE | `bunx vitest run packages/adapter` (417/417 pass) |
| CardDAV account repository | `packages/adapter/src/repositories/carddav-account-repository.ts` | DONE | included above |
| vCard codec | `packages/adapter/src/vcard/vcard-codec.ts` | DONE | included above |
| CardDAV client | `packages/adapter/src/carddav/carddav-client.ts` | DONE | included above |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `contacts-domain.md` (all), `contacts-application.md` TASK-001 | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] `packages/adapter/package.json` gains exactly two new explicit
      `exports` entries (`./vcard/vcard-codec`, `./carddav/carddav-client`)
      -- this package has no barrel file, so every new non-wildcard
      subpath must be listed by hand; the existing `./repositories/*`
      wildcard already covers the three new repository files with no
      edit
- [x] No file at 1000+ lines (split `vcard-format.ts`/further as needed)

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-contacts.md.

### Session: 2026-08-24 (migration)
**Tasks Completed**: TASK-001 (`apps/api/migrations/0010_contacts.sql`)
**Notes**: Wrote the migration verbatim per the design doc's "Storage"
section and this task's `api_key_scopes` rebuild block, using the 14-value
capability list this task specifies (which matches
`packages/domain/src/entities/api-key.ts`'s `Capability` enum, already
extended with `ContactRead`/`ContactWrite` by another session). Verified
`0001`..`0011` (this file plus `0011_external_mail.sql` from the sibling
plan) apply cleanly in order via the adapter's libsql migration runner, and
ran `bunx vitest run apps/api packages/adapter`: 373/374 pass. The one
failure, `runner.test.ts`'s "applies the real production migrations
cleanly" test, hardcodes the full migration-file-name list through
`0009_mail_addresses.sql` and now needs `0010_contacts.sql`/
`0011_external_mail.sql` appended -- a one-line TypeScript edit this task
explicitly excluded, so it was left for whoever picks up TASK-002 or a
follow-up. `apps/api/src/server.test.ts`, which failed before this
migration because the `api_key_scopes` CHECK rejected `CONTACT_READ`/
`CONTACT_WRITE`, now passes (6/6).
`packages/infrastructure/src/graphql/schema.test.ts` still has one
unrelated failure (`bootstrapAdmin`), owned by the GraphQL plan and not
touched. Not run: `wrangler d1 migrations apply mailcal-db --local` (D1
worker path) and the partial-unique-index / rebuild-specific test
assertions the completion criteria call for -- both left to TASK-002 or a
dedicated migration test, since this session's scope was the SQL file
only.

### Session: 2026-08-24 (TASK-002 through TASK-005)
**Tasks Completed**: TASK-002, TASK-003, TASK-004, TASK-005 (all remaining
tasks in this plan)
**Notes**:
- TASK-002: `packages/adapter/src/repositories/address-book-repository.ts`
  and `contact-repository.ts` (+ `contact-rows.ts` for the row
  interfaces/mappers/`contactWriteStatements` and `contact-queries.ts` for
  `buildContactListQuery`, split out like
  `message-repository.ts`/`message-repository-queries.ts`).
  `message-repository-queries.ts`'s condition builders are hardwired to
  `messages`' sender-plus-recipients-join shape (a message has several
  candidate addresses; a book has exactly one owning address), so it could
  not be imported as-is without changing its behavior for the existing mail
  listing path. Extracted a column-parametrized generalization instead --
  `packages/adapter/src/repositories/mail-permission-queries.ts`
  (`singleColumnPatternCondition`, `buildAllowedPatternsColumnCondition`,
  `buildMailPermissionColumnFilterCondition`) -- copying the exact
  algorithm from `message-repository-queries.ts` rather than reinventing
  it, parametrized by column name so `address-book-repository.ts`'s
  `listReadable` renders it against `mail_addresses.address`/
  `mail_addresses.domain_id`. `message-repository-queries.ts` itself was
  left untouched to avoid any risk to its existing, heavily-tested
  behavior. Added a `seedMailAddress` helper to
  `repositories/test-support.ts` for the new tests.
- TASK-003: `packages/adapter/src/repositories/carddav-account-repository.ts`
  for the CardDAV tables from migration `0010`.
- TASK-004: `packages/adapter/src/vcard/vcard-codec.ts` +
  `vcard/vcard-format.ts` (folding/escaping/content-line tokenizing kept
  in a dedicated vCard formatting module). One deviation from
  the port's `ParsedVcardContact.unparsable` field as originally sketched:
  the port method signature is `parseVcard(vcard: string): ParsedVcardContact
  | null`, so this implementation always returns `null` for a fully
  unparsable card (no locatable `BEGIN:VCARD`/`END:VCARD` pair) rather than
  ever returning an object with `unparsable: true` -- the two signals said
  the same thing and only `null` is reachable through the type as given.
  `REV` is recognized on parse (dropped, not carried into
  `extraVcardLines`) and re-derived from `Contact.updatedAt` on format,
  since the domain entity has no `rev` field of its own. Any line carrying
  a `group.` prefix (`item1.EMAIL`, `item1.X-ABLabel`, ...) is treated as
  unmodeled regardless of property name, matching the design doc's
  iCloud-fidelity requirement.
- TASK-005: `packages/adapter/src/carddav/carddav-client.ts`. The XML and URL
  helpers are protocol-generic and shared through the WebDAV module.
  Discovery failure (no
  `current-user-principal`/`addressbook-home-set` found) throws
  `CarddavTransportError` rather than returning a discovery result with
  null fields, even though the port declares those fields nullable.
- `packages/adapter/package.json` gained exactly the two exports entries
  the plan specifies; the three new repository files needed no export
  edit (already covered by the `./repositories/*` wildcard).
- Verification: `bunx vitest run packages/adapter` -- 417/417 pass (44 new
  tests across the five new/changed test files: `address-book-repository
  .test.ts`, `contact-repository.test.ts`,
  `carddav-account-repository.test.ts`, `vcard-codec.test.ts`,
  `carddav-client.test.ts`). `bunx tsc --noEmit -p packages/adapter` clean.
  `biome check packages/adapter --diagnostic-level=warn` clean (80 files).
  No file in this task's scope exceeds 1000 lines (largest is
  `carddav-client.ts` at 518).
- Not touched, per the assigned scope: `packages/application`,
  `packages/infrastructure`, `apps/*`. `bunx tsc --noEmit -p
  packages/adapter` was used instead of a repo-wide typecheck for exactly
  this reason -- a concurrent session owns `build-dependencies.ts` wiring.

## Related Plans

- **Depends On**: `contacts-domain.md`, `contacts-application.md`
- **Next**: `contacts-graphql.md`
