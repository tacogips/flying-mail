# External Mail Accounts: JMAP / POP3 Fetch and SMTP Relay

flying-mail aggregates external mailboxes. An admin binds an external account
(a Gmail/Fastmail/anything mailbox reachable over JMAP or POP3) to one
provisioned mail address; fetched messages flow through the existing
ingest pipeline into that mailbox, and mail sent *as* the external address
leaves through that provider's SMTP submission server instead of
Cloudflare Email Sending. The direction is deliberate: flying-mail is a client
of these protocols, as it is for CardDAV; it does not serve JMAP, POP3, or
SMTP to mail apps.

Explicitly out of scope:

- Serving any mail protocol. No inbound TCP listeners exist or can exist
  on Workers; the GraphQL API remains the only read surface.
- IMAP. JMAP covers the modern-server case, POP3 the lowest common
  denominator; IMAP's stateful protocol is a large follow-up if wanted.
- OAuth2/XOAUTH2 to providers (Gmail's preferred auth). v1 is password /
  app-password Basic+`AUTH PLAIN` auth; an OAuth flow is a follow-up and
  the credential column is a ciphertext blob precisely so a token can
  live there later.
- Scheduled background fetch. Fetch is an on-demand mutation (cron
  trigger follow-up, shared with DAV sync).
- Deleting mail on the remote server. Fetch always leaves mail in place
  (`POP3` without `DELE`); flying-mail is an aggregator, not a migrator.

## Binding model: external account -> managed mail address

`ExternalMailAccount` is bound to exactly one existing `mail_addresses`
row (`0009`). Everything downstream reuses that mailbox's machinery:

- **Visibility**: fetched messages are ingested with the bound address as
  the envelope/authorization recipient (original `To`/`Cc` headers are
  preserved as header recipients). User mail permissions and API-key
  scopes on that address therefore govern the external mail with zero
  changes to authorization SQL.
- **Sending**: when an outbound message's from-address has an external
  account with SMTP configured, `sendMessage` routes it through the SMTP
  relay with the *external* address as `MAIL FROM`/`From`, so replies work
  and SPF/DKIM are the provider's. Without SMTP config, sending falls back
  to the existing Cloudflare path as that managed address.
- **Threading, spam, tags, attachments, R2 raw storage**: unchanged; the
  ingest use case is the same one Email Routing invokes.

The alternative -- modeling foreign addresses as first-class mailboxes --
was rejected: it would fork `design-user-mail-permissions.md`'s
domain-scoped pattern matching and every message-visibility query for no
user-visible gain.

One managed address can have at most one external account (unique index);
one external account has one fetch protocol (`JMAP` or `POP3`) and
optionally one SMTP submission config.

## Layering map

| Layer | Additions |
|-------|-----------|
| domain | `ExternalMailAccount` (+ `ExternalFetchConfig` union, `SmtpSubmissionConfig`), `ExternalMessageState`, `ExternalAccountId` id brand, status enum `ACTIVE/DISABLED` |
| application | ports `ExternalMailAccountRepository`, `ExternalMessageStateRepository`, `JmapClient`, `Pop3Client`, `SmtpSubmissionClient`, `TcpDialer`; use cases `usecases/external-accounts.ts` (CRUD, admin-only), `usecases/external-fetch.ts` (fetch orchestration over the existing `ingestMessage`), send-path branch in `usecases/send.ts` |
| adapter | `jmap/jmap-client.ts` (fetch-based, RFC 8620/8621 subset), `pop3/pop3-client.ts` + `smtp/smtp-client.ts` (text protocols over `TcpDialer`), `tcp/` dialers: `cloudflare-tcp-dialer.ts` (`cloudflare:sockets`) and `node-tcp-dialer.ts` (`node:net`/`node:tls`, used by Bun/tests), D1 repositories |
| infrastructure | `graphql/schema-external-mail.graphql.ts` + `resolvers/external-mail.ts`; composition picks the dialer per runtime in `build-dependencies.ts` |
| apps/api | migration `0011_external_mail.sql`; reuses `MAILCAL_CREDENTIAL_KEY` for all external credentials |
| apps/web | none in v1 (admin GraphQL/agent surface first; settings UI is a follow-up) |

## Domain model

```
ExternalMailAccount {
  id, mailAddressId,                  // the bound managed address
  externalAddress: EmailAddress,      // the remote identity, e.g. taco@gmail.com
  displayName?,
  fetch: ExternalFetchConfig,         // JMAP | POP3 (discriminated union)
  smtp?: SmtpSubmissionConfig | null,
  status: ACTIVE | DISABLED,
  lastFetchedAt?, createdAt, updatedAt
}

ExternalFetchConfig =
  | { kind: "JMAP"; sessionUrl (https); username; passwordCiphertext }
  | { kind: "POP3"; host; port (default 995); username; passwordCiphertext }

SmtpSubmissionConfig =
  { host; port (465 | 587); security: IMPLICIT_TLS | STARTTLS;
    username; passwordCiphertext }

ExternalMessageState {                 // dedupe ledger, one row per fetched msg
  accountId, remoteId,                 // JMAP Email id / POP3 UIDL
  messageId,                           // the ingested flying-mail MessageId
  fetchedAt
}
```

Invariants: `sessionUrl` is absolute `https` (`http` for `localhost` only,
same rule as DAV servers); POP3 port 110 is refused -- implicit TLS (995)
only, because STARTTLS-on-110 downgrade is exactly the attack a hostile
network wants; SMTP `port`/`security` must agree (465⇒IMPLICIT_TLS,
587⇒STARTTLS); all credentials are ciphertext-only in the entity and use the
shared `CredentialCipher` also used by CardDAV (unset
`MAILCAL_CREDENTIAL_KEY` ⇒ external-account mutations fail
`SERVICE_UNAVAILABLE`).

Note the Workers platform constraint that shapes these rules: outbound
TCP from Workers cannot reach port 25 at all, and 465/587/995 are
reachable via `cloudflare:sockets`. Relay is always *submission*, never
MX delivery.

## Storage (migration `0011_external_mail.sql`)

```
external_mail_accounts(id PK,
  mail_address_id -> mail_addresses ON DELETE CASCADE UNIQUE,
  external_address, display_name,
  fetch_kind CHECK IN ('JMAP','POP3'),
  fetch_config TEXT,          -- JSON of the non-secret fetch fields
  fetch_password_ciphertext,
  smtp_config TEXT,           -- JSON of the non-secret smtp fields, NULL if none
  smtp_password_ciphertext,
  status CHECK IN ('ACTIVE','DISABLED'),
  last_fetched_at, created_at, updated_at)
external_message_states(
  account_id -> external_mail_accounts ON DELETE CASCADE,
  remote_id, message_id, fetched_at,
  PK (account_id, remote_id))
```

Config JSON holds only non-secret connection parameters; ciphertexts get
dedicated columns so a future "rotate credential key" migration can find
every ciphertext without parsing JSON. The `0009` migration-runner caveat
about the statement terminator applies.

## Protocol clients

### `TcpDialer` port

```
interface TcpDialer {
  dial(opts: { host; port; tls: "implicit" | "starttls-ready" | "none" })
    : Promise<TextSocket>   // line/chunk read-write, startTls(), close()
}
```

Workers implementation wraps `connect()` from `cloudflare:sockets`
(`secureTransport: "on"` for implicit TLS, `"starttls"` + `startTls()`
for 587). Bun/Node implementation wraps `node:net`/`node:tls`. The
composition root picks by runtime, so the same POP3/SMTP client code and
tests run everywhere; unit tests script a fake `TextSocket` with canned
server lines.

### JMAP client (`JmapClient`, RFC 8620/8621 subset)

Plain `fetch`; no sockets needed. Flow per fetch: GET session resource ->
`Mailbox/get` (role=inbox) -> since `lastFetchedAt`-anchored
`Email/query` (sortedBy receivedAt, ascending, bounded page) ->
`Email/get` for `blobId`s of ids not yet in `external_message_states` ->
blob download (`downloadUrl` template) yields the raw RFC 5322 bytes.
Raw-blob download rather than JMAP body parts is deliberate: the existing
ingest pipeline starts from raw MIME, so fetched mail gets byte-identical
treatment (R2 `.eml`, postal-mime parse, threading, spam scoring).
`state`/`queryState` strings are not persisted in v1; the dedupe ledger
makes re-queries idempotent, which is simpler than `Email/queryChanges`
and tolerable at on-demand frequencies.

### POP3 client (`Pop3Client`, RFC 1939)

Implicit-TLS dial, `USER`/`PASS`, `UIDL` for the full id list, diff
against the ledger, `RETR` each new id (bounded per run, below), `QUIT`.
No `DELE` ever. Multi-line termination and byte-stuffed leading-dot
handling live in the client; `TOP`-based partial fetch is not used.

### SMTP submission client (`SmtpSubmissionClient`, RFC 5321/6409/8314)

Dial per config (465 implicit / 587 `EHLO`+`STARTTLS`+`EHLO`), `AUTH
PLAIN` (fallback `AUTH LOGIN`), `MAIL FROM:<external>`, `RCPT TO` each
envelope recipient, `DATA` with dot-stuffing, `QUIT`. The raw message
comes from the existing MIME builder -- the same bytes the Cloudflare
path would send. A non-2xx/3xx reply maps to the existing
`MailDeliveryError` so GraphQL error semantics stay uniform.

## Use cases

`usecases/external-accounts.ts` (all admin-only, `requireGlobalCapability`
DOMAIN_ADMIN-style gate like domain management): `createExternalAccount`,
`updateExternalAccount` (credential replacement re-enciphers; omitted
password keeps the old ciphertext), `deleteExternalAccount`,
`listExternalAccounts`, `testExternalAccount` (connect + authenticate
only, no fetch -- surfaced errors make misconfiguration debuggable
without waiting for a fetch).

`usecases/external-fetch.ts`: `fetchExternalMail(viewer, accountId, {max})`
-- requires MAIL_READ on the bound address (any authorized reader may
poll). Per new remote message: skip if `(accountId, remoteId)` in ledger;
otherwise run the raw bytes through the existing ingest use case with the
bound address as delivery recipient, then record the ledger row in the
same batch as the message insert so a crash cannot double-ingest. Per-run
cap (default 50, Workers subrequest/CPU budget) with `hasMore` in the
returned summary `{ fetched, skipped, hasMore }`; callers loop.
`DISABLED` accounts refuse with `CONFLICT`.

`usecases/send.ts` branch: after existing authorization, if the resolved
from-address has an ACTIVE external account with `smtp`, relay via
`SmtpSubmissionClient` (From/`MAIL FROM` = `externalAddress`); else the
current Cloudflare Email Sending path. Delivery-status bookkeeping
(`QUEUED/SENT/FAILED`, message events) is shared by both branches.

## GraphQL

`schema-external-mail.graphql.ts`:

```graphql
type ExternalMailAccount { id mailAddress externalAddress displayName
  fetchKind smtpConfigured status lastFetchedAt ... }   # never any secret
type Query    { externalMailAccounts: [ExternalMailAccount!]! }
type Mutation {
  createExternalMailAccount(input: ...): ExternalMailAccount!
  updateExternalMailAccount(input: ...): ExternalMailAccount!
  deleteExternalMailAccount(id: ID!): Boolean!
  testExternalMailAccount(id: ID!): ExternalAccountTestResult!
  fetchExternalMail(id: ID!, max: Int): ExternalFetchSummary!
}
```

Standard error codes; `SERVICE_UNAVAILABLE` when the credential key is
unset; `CONFLICT` for a second account on one address or fetching a
disabled account.

## Testing

- Domain: config-union invariant tests (port/security agreement, https
  rule, port-110 refusal).
- Application: fetch orchestration over fake clients + fake ledger
  (dedupe, cap/hasMore, crash-safety ordering), send-path branch choice.
- Adapter: POP3/SMTP clients against scripted fake `TextSocket`s
  (greeting, auth failure, multiline UIDL, dot-stuffing both directions);
  JMAP client against canned session/query/get JSON fixtures; repository
  round-trips on in-memory SQLite.
- Infrastructure: schema tests for admin gating and secret non-exposure.

## References

RFC 8620/8621 (JMAP core/mail), RFC 1939 (POP3), RFC 2595/8314 (TLS for
mail protocols), RFC 5321/6409 (SMTP/submission), Cloudflare
`cloudflare:sockets` TCP API (port-25 restriction). See
`design-docs/references/README.md`.
