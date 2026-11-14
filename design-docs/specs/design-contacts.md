# Contacts and CardDAV Design

flying-mail gains contacts: address books owned by provisioned mail addresses,
contacts referenceable both per mail address and merged across every mail
address the viewer is authorized for, and CardDAV *client* sync with an
external server (in practice iCloud). Everything is exposed through the
existing `/graphql` endpoint so agents and the SolidJS client share one API.

Explicitly out of scope (by request and by design):

- Acting as a CardDAV *server*. flying-mail is a CardDAV *client* (discovery,
  multiget, etag sync). No new hono protocol endpoints: flying-mail syncs with
  iCloud, it does not serve DAV.
- Contact groups (`KIND:group` / `MEMBER`), vCard photos (`PHOTO`), and
  free-form extension properties (`X-*`). Unsupported properties found in a
  remote vCard are preserved verbatim for round-tripping (see "vCard
  fidelity") but are not modeled, queried, or editable.
- Auto-harvesting contacts from message traffic. A follow-up "add sender to
  contacts" action can build on this model; ingest never writes contacts.
- Scheduled background sync. Sync is an on-demand mutation; a cron trigger is
  a later follow-up.

## Ownership model: per mail address, visible across addresses

The unit of ownership is the provisioned mail address (`mail_addresses`,
migration `0009`), not the user. Requirements this satisfies:

1. **Per mail address**: each address book belongs to exactly one
   `MailAddressId`. `support@example.com`'s contacts are that mailbox's
   rolodex, independent of who staffs it.
2. **Across mail addresses**: a viewer's cross-address contact list is the
   merged set of contacts in books whose owning mail address the viewer is
   authorized to read. No second permission system is introduced: contact
   visibility derives entirely from the existing user mail permissions
   (`design-user-mail-permissions.md`) evaluated against the book's owning
   address, and from API-key scopes (below).

| Actor | Contact read on a book | Contact write on a book |
|-------|------------------------|-------------------------|
| `ADMIN` user | all books (minus mailbox `DENY`s) | all books (minus `DENY`s) |
| `MEMBER` user | books on addresses with a matching `ALLOW` | same as read |
| `VIEWER` user | books on addresses with a matching `ALLOW` | never |
| API key | `CONTACT_READ` scope, scoped by the key's address patterns | `CONTACT_WRITE` scope, same scoping |

Two new capabilities, `CONTACT_READ` and `CONTACT_WRITE`, join the
`Capability` enum. For
interactive users they are *derived*: `MAIL_READ` on the owning address
grants `CONTACT_READ`; `MAIL_MANAGE` grants `CONTACT_WRITE`. For API keys
they are explicit scopes so an agent key can be contacts-only.

CardDAV accounts are the exception: a `CarddavAccount` belongs to a *user*
(it holds that user's iCloud
credential). Which local book a remote book maps to is per-link, and
mutating a link requires contact write on the local book.

## Layering map

| Layer | Additions |
|-------|-----------|
| domain | `AddressBook`, `Contact` (+ `ContactEmail`, `ContactPhone`, `ContactPostalAddress`), `CarddavAccount`/`CarddavBookLink`/`CarddavContactState`/`CarddavDeletion`, IDs `AddressBookId`, `ContactId`, `CarddavAccountId`, `CarddavBookId`, capabilities `CONTACT_READ`/`CONTACT_WRITE` |
| application | ports `AddressBookRepository`, `ContactRepository`, `CarddavAccountRepository`, `CarddavClient`, `VcardCodec` (reuses `CredentialCipher`); use cases in `usecases/address-books.ts`, `usecases/contacts.ts`, `usecases/carddav.ts`, `usecases/carddav-sync.ts`; `authorizesContactCapability` in `policies/authorization.ts`; fakes in `test-support/` |
| adapter | D1 repositories `address-book-repository.ts`, `contact-repository.ts`, `carddav-account-repository.ts`; `vcard/vcard-codec.ts` (RFC 6350 subset, 3.0 + 4.0 input, 3.0 output for iCloud); `carddav/carddav-client.ts` with shared WebDAV multistatus parsing |
| infrastructure | `graphql/schema-contacts.graphql.ts` SDL module + `resolvers/contact-query.ts` / `contact-mutation.ts` / `contact-types.ts`; composition wiring in `build-dependencies.ts` |
| apps/api | migration `0010_contacts.sql`; no new bindings (reuses `FLYING_MAIL_CREDENTIAL_KEY`) |
| apps/web | `/contacts` route: book-filterable, cross-address merged list, contact editor dialog, CardDAV account/link management; `api/contact-documents.ts`, `api/contact-types.ts`, `store/contact-store.ts` |

No near-limit file grows inline: every addition is a new
module merged at the existing composition points (`createSchema` typeDef /
resolver arrays, `createUseCases` spread, web store mount). Any touched
file at 1000+ lines is split per `ts-coding-standards`.

## Domain model

IDs in `value-objects/ids.ts`, using the existing `Brand` + `createXxxId`
pattern, are caller-supplied: `AddressBookId`, `ContactId`,
`CarddavAccountId`, and `CarddavBookId`.

`AddressBook`:

```
{ id, mailAddressId, name (1..120), description?, isDefault: boolean,
  createdAt, updatedAt }
```

Every provisioned mail address can hold zero or more books. The first book
created for an address (typically by `createContact` with no explicit book,
see below) is `isDefault`. Deleting a book hard-deletes its contacts. At most
one default book per address
(invariant enforced by repository unique index, surfaced as `CONFLICT`).

`Contact`:

```
{
  id, addressBookId,
  uid,                       // vCard UID; generated by application layer
  displayName (1..500),      // FN
  givenName?, familyName?,   // N (subset: given/family only)
  nickname?,
  organization?, title?,     // ORG (first value), TITLE
  emails:  readonly ContactEmail[],   // { address: EmailAddress, label?: string }
  phones:  readonly ContactPhone[],   // { number (1..50), label?: string }
  postalAddresses: readonly ContactPostalAddress[],  // { formatted (1..1000), label?: string }
  urls: readonly string[],            // absolute http(s), deduplicated
  note? (..10000), birthday?: IsoDate,
  extraVcardLines?: string | null,    // fidelity payload, never shown raw in UI
  createdAt, updatedAt
}
```

Invariants (smart constructor `createContact`, throws `ValidationError`):
`displayName` non-empty after trim; `emails[].address` are normalized
`EmailAddress`es, deduplicated case-insensitively; `urls` absolute
`http(s)`; at most 32 each of emails/phones/postalAddresses/urls (vCard
bombs from a hostile CardDAV server must not become megabyte rows);
`labels` are free text (1..40), not an enum -- iCloud round-trips arbitrary
labels and an enum would destroy them.

Cross-address referencing is a query concern, not a domain relation: the
same human appearing in two books is two rows. The merged view groups by
normalized email client-side/in-SQL for display but the domain never
invents a cross-book identity.

## Storage (migration `0010_contacts.sql`)

```
address_books(id PK, mail_address_id -> mail_addresses ON DELETE CASCADE,
              name, description, is_default, created_at, updated_at)
  UNIQUE (mail_address_id) WHERE is_default = 1   -- partial unique index
contacts(id PK, address_book_id -> address_books ON DELETE CASCADE,
         uid, display_name, given_name, family_name, nickname,
         organization, title, note, birthday, extra_vcard_lines,
         created_at, updated_at)
  UNIQUE (address_book_id, uid)
contact_emails(contact_id -> contacts ON DELETE CASCADE, position,
               address, label)  PK (contact_id, position)
  INDEX (address)               -- the cross-address "who is this?" lookup
contact_phones / contact_postal_addresses / contact_urls: same shape as
contact_emails (position-ordered child rows)
carddav_accounts(id PK, user_id -> users ON DELETE CASCADE, server_url,
                 username, password_ciphertext, principal_url,
                 home_set_url, created_at, updated_at)
carddav_book_links(id PK, account_id -> carddav_accounts ON DELETE CASCADE,
                   address_book_id -> address_books ON DELETE CASCADE,
                   remote_url, display_name, ctag, sync_token,
                   last_synced_at)
  UNIQUE (account_id, remote_url), UNIQUE (address_book_id, account_id)
carddav_contact_states(contact_id PK -> contacts ON DELETE CASCADE,
                       carddav_book_id -> carddav_book_links ON DELETE CASCADE,
                       href, etag, last_synced_at, remote_unsupported)
carddav_deletions(carddav_book_id, href, etag, deleted_at)
  PK (carddav_book_id, href)
```

Emails/phones/addresses/urls are child tables rather than JSON because the
cross-address view needs an indexed reverse lookup by email. NOTE: the
migration runner splits on the statement terminator with no comment
awareness -- the `0009` caveat about that character applies here too.

The migration also performs the `api_key_scopes` recreate dance
(`api_key_scopes_new` -> copy -> rename) to admit `CONTACT_READ` /
`CONTACT_WRITE` into the capability `CHECK`, as earlier capability migrations
did -- SQLite cannot alter a CHECK
in place.

## Use cases

`usecases/address-books.ts`: `listAddressBooks(viewer, mailAddressId?)`,
`createAddressBook`, `updateAddressBook`, `deleteAddressBook`. Creation
requires contact write on the owning address; listing filters to readable
addresses using the same repository-pushed predicate style as
`message-repository-queries.ts` (the `(effect, domainId, addressPattern)`
tuple rule from `design-user-mail-permissions.md` -- never split into
independent lists).

`usecases/contacts.ts`: `listContacts(viewer, filter)`, `getContact`,
`createContact`, `updateContact`, `deleteContact`, and
`lookupContactsByEmail(viewer, email)` (the "who is this sender?" hook the
web client and agents use from a message view). `listContacts` filter:

```
{ mailAddressIds?, addressBookIds?, query? (name/org/email substring),
  email?, first/after (cursor pagination, same shape as messages) }
```

Omitting both id filters yields the merged cross-address list over every
book the viewer can read. `createContact` with no `addressBookId` targets
the owning address's default book, creating it ("Contacts") if absent --
so the common single-book case needs no book management at all.

Editing a CardDAV-linked contact is allowed; sync pushes it (below).
Deleting one records a `carddav_deletions` tombstone, mirroring events.

`usecases/carddav.ts`: `connectCarddavAccount` (discover principal /
addressbook home set via `PROPFIND` well-known + `current-user-principal`),
`listRemoteAddressBooks`, `linkRemoteAddressBook` (bind remote collection
to a local book, creating the local book if asked), `unlinkRemoteAddressBook`,
`disconnectCarddavAccount`. Credentials pass through `CredentialCipher`
(AES-256-GCM under `FLYING_MAIL_CREDENTIAL_KEY`); the entity stores ciphertext
only, and plaintext lives only inside connect/sync for one request. Unset key
⇒ CardDAV mutations fail `SERVICE_UNAVAILABLE`; contacts themselves keep
working.

`usecases/carddav-sync.ts`: `syncCarddavBook(viewer, carddavBookId)`,
on-demand, in two phases:

1. **Pull**: compare `ctag`; if changed, `addressbook-query`/`sync-collection`
   list of `(href, etag)`, diff against `carddav_contact_states`, fetch
   changed vCards via `addressbook-multiget`, upsert by `(book, uid)`.
   A vCard the codec cannot fully model imports what it can and stores the
   remainder in `extraVcardLines` with `remoteUnsupported = false` (unlike
   RRULE, partial vCard import is lossless thanks to the fidelity payload);
   only an unparsable vCard is skipped and reported in the sync summary.
2. **Push**: local contacts whose `updatedAt` > `lastSyncedAt` are `PUT`
   with `If-Match` (etag conflict ⇒ remote wins, local copy is overwritten
   on the same sync's re-pull; conflicts are counted in the summary);
   tombstones are `DELETE`d then cleared.

Sync returns a summary `{ pulled, pushed, deleted, skipped, conflicts }`
for the UI/agent to display.

## vCard codec (`adapter/vcard/vcard-codec.ts`, port `VcardCodec`)

RFC 6350 (4.0) and RFC 2426 (3.0) input; 3.0 output (iCloud's lingua
franca). Supported properties: `UID FN N NICKNAME ORG TITLE EMAIL TEL ADR
URL NOTE BDAY REV`. Everything else -- including `PHOTO`, `X-*`,
`item1.`-style grouped properties -- is carried in `extraVcardLines`
verbatim and re-emitted on format, so a round trip through flying-mail never
strips what it does not understand. Line folding/unfolding, parameter
quoting, and `\,`/`\;`/`\n` escaping live here and nowhere else. The codec
is a pure function pair `parseVcard`/`formatVcard` behind the port so
tests supply canned cards; property-based round-trip tests are the main
test surface.

## GraphQL

`schema-contacts.graphql.ts`, merged via the existing typeDef/resolver
arrays. Sketch (full SDL in the module):

```graphql
type AddressBook { id mailAddress name description isDefault contactCount ... }
type Contact { id addressBook uid displayName ... emails { address label } ... }
type Query {
  addressBooks(mailAddressId: ID): [AddressBook!]!
  contacts(filter: ContactFilter, first: Int, after: String): ContactPage!
  contact(id: ID!): Contact
  contactsByEmail(email: String!): [Contact!]!
  carddavAccounts: [CarddavAccount!]!          # viewer's own, no secrets
  carddavRemoteBooks(accountId: ID!): [RemoteAddressBook!]!
}
type Mutation {
  createAddressBook / updateAddressBook / deleteAddressBook
  createContact / updateContact / deleteContact
  connectCarddavAccount / disconnectCarddavAccount
  linkCarddavBook / unlinkCarddavBook
  syncCarddavBook(id: ID!): CarddavSyncSummary!
}
```

Error codes reuse the standard table (`FORBIDDEN`, `NOT_FOUND` for
out-of-scope ids, `CONFLICT` for duplicate default book / uid,
`SERVICE_UNAVAILABLE` for missing credential key). `CarddavAccount` never
exposes ciphertext or plaintext; `connect` takes the password as an input
field and returns the account without it.

New API-key scope values `CONTACT_READ` / `CONTACT_WRITE` join the
`Capability` GraphQL enum; existing keys are unaffected (no scope = no
contact access), and `createApiKey` accepts them like any other scope.

## Web client

`/contacts` route in the SolidJS app:

- Left rail: "All contacts" (cross-address merged view) plus one entry per
  readable mail address (its books nested when more than one).
- List: name-sorted, search box driving `filter.query`, email chips.
- Detail/editor dialog: the modeled fields; viewers see read-only.
- Settings section for CardDAV: connect account (server URL defaulting to
  iCloud's, Apple-ID username, app-specific password), list remote books,
  link/unlink to a local book, per-link "Sync now" button showing the
  summary.
- Message view hook: sender/recipient addresses resolve through
  `contactsByEmail`; a match shows the contact name and links to it.

Known limitation (accepted for v1): the GraphQL `mailAddresses` listing is
DOMAIN_ADMIN-gated, so a non-admin's rail and CardDAV import-target list
are built from addresses that already have at least one local book -- an
address with zero books has no rail entry, and its first book must come
from `createContact` (or an admin/agent call). A follow-up
`readableMailAddresses` query scoped by the viewer's mail permissions
would lift this.

`store/contact-store.ts` is mounted in the application store;
`api/contact-documents.ts` holds the GraphQL documents.

## Testing

- Domain: constructor invariant tests beside entities, as elsewhere.
- Application: use-case tests over `test-support` fakes (fake repositories,
  fake `CarddavClient` scripted with multistatus fixtures, fake cipher).
- Adapter: repository tests on in-memory SQLite via the existing harness;
  codec round-trip tests including folding, escaping, iCloud 3.0 fixtures.
- Infrastructure: schema tests (`schema-contacts.test.ts`) exercising
  permission derivation: VIEWER read-only, MEMBER scoped, DENY hides,
  API-key scope gating.

## References

RFC 6350 (vCard 4.0), RFC 2426 (vCard 3.0), RFC 6352 (CardDAV), RFC 6764
(DAV service discovery). See `design-docs/references/README.md`.
