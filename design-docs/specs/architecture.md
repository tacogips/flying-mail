# Architecture Design

flying-mail is a self-hosted, multi-domain mail service that runs entirely on
Cloudflare Workers. It receives mail through Cloudflare Email Routing,
stores messages and attachments in D1 + R2, and exposes everything through a
single GraphQL endpoint designed to be driven by AI agents and programmatic
clients as a first-class caller, with a SolidJS browser mail client as a
second consumer of the exact same API.

## Overview

```
                    inbound SMTP                       outbound
  the internet ------------------> Cloudflare Email ------------------>
                                    Routing / Service
                                          |  ^
                                 email()  |  | EMAIL binding .send()
                                          v  |
  +---------------------------------------------------------------+
  |                    apps/api  (Cloudflare Worker)               |
  |   fetch()  ->  hono app  ->  /graphql (yoga)                   |
  |                           ->  /files/:token  (temp file links) |
  |                           ->  ASSETS (SolidJS SPA)             |
  |   email()  ->  ingest pipeline                                 |
  +---------------------------------------------------------------+
              |                                   |
          D1 (DB)                             R2 (BLOB)
       messages, tags,                    raw MIME (.eml),
       api keys, domains,                 attachment bodies
       fetch state
```

Two independent client shapes talk to the same `/graphql`:

| Caller | Credential | Transport |
|--------|-----------|-----------|
| AI agent / programmatic client | API key (`Authorization: Bearer ybm_...`) | GraphQL over HTTPS |
| Browser mail client (`flying-mail client serve`, or the Worker's own SPA) | `HttpOnly` session cookie | GraphQL over HTTPS |

## Layering

The repository is a Bun workspace monorepo using the same clean-architecture
layering as the reference project `xxip`. The dependency rule points inward:
`domain` depends on nothing, and no inner layer imports an outer one.

| Package | Depends on | Responsibility |
|---------|-----------|----------------|
| `@flying-mail/domain` | - | Entities, branded value objects, invariants, `DomainError` |
| `@flying-mail/application` | domain | Ports (interfaces), use cases, permission policies, `ApplicationError` |
| `@flying-mail/adapter` | application, domain | Concrete ports: D1/libsql, R2/S3/memory, WebCrypto, MIME parse/build, Cloudflare mail, repositories, migration runner |
| `@flying-mail/infrastructure` | adapter, application, domain | GraphQL schema/resolvers, hono HTTP app, auth middleware, file-link routes, composition root |

| App | Runtime | Responsibility |
|-----|---------|----------------|
| `apps/api` | Workers / Bun / Node | `fetch` + `email` handlers, wrangler config, D1 migrations |
| `apps/web` | Browser (Vite + SolidJS) | Mail client SPA |
| `apps/cli` | Bun / Node | `flying-mail` CLI, including `flying-mail client serve` |

## Storage

| Store | Binding | Contents |
|-------|---------|----------|
| D1 | `DB` | mail: `domains`, `messages`, `message_recipients`, `attachments`, `tags`, `message_tags`, `message_fetch_states`, `api_keys`, `api_key_scopes`, `file_links`, `users`, `sessions`, `email_auth_challenges`; templates: `mail_templates`, `user_template_permissions`; contacts: address books, contacts, contact details, and CardDAV account/sync state; external mail: account, mailbox, and fetch state |
| R2 | `BLOB` | `raw/<messageId>.eml` (full MIME source), `att/<attachmentId>/<fileName>` (decoded message attachment bodies) |

Both are reached only through the `SqlDatabase` and `BlobStore` ports, so the
same code runs on Workers (D1 + R2), locally under Bun/Node (libsql file +
S3/MinIO or in-memory), and in tests (in-memory libsql + in-memory blobs).

See `design-storage-and-file-links.md` for the schema and the temp-file link
design, and `design-mail-pipeline.md` for the ingest/send pipelines.

## Authentication and Authorization

Two credential kinds resolve to the same `Viewer` abstraction:

- **API keys** (`ybm_<prefix>_<secret>`) carry an explicit **scope list**.
  Every scope is a `(capability, domain, addressPattern)` triple, so a key can
  be issued that may only *read* mail delivered to `support@example.com`, or
  only *send* as `noreply@example.org`, and nothing else.
- **Sessions** belong to a `User` and are established through passwordless
  email links; a user is either `ADMIN` (may manage domains and issue keys) or
  `MEMBER`.

See `design-api-keys-and-permissions.md`.

Onboarding is invite-only. The first admin is created once, by
`bootstrapAdmin` gated on the deploy-time secret
`FLYING_MAIL_BOOTSTRAP_TOKEN`. Every later user is created by an admin and
receives a single-use invitation link. The login-link request is protected
by Cloudflare Turnstile. The unauthenticated auth mutations are rate limited
per client IP. The Worker is reachable only through the
`mail.tacoserve.online` custom domain. See `design-security-model.md`.

## GraphQL API

A single `POST /graphql` endpoint (graphql-yoga on hono) exposes queries for
domains, messages, threads, tags, attachments, file links and API keys, and
mutations for sending mail, tagging, spam marking, per-consumer fetch-state
updates, domain management and key issuance. Errors always carry
`extensions.code`.

See `design-graphql-api.md`.

## Real-time push (2026-10-08)

`Subscription.mailEvents(scope, after)` runs over WebSocket with the
`graphql-transport-ws` subprotocol on `/graphql`.

- **Event log.** Mail writers append to an event log in D1
  (`mail_events`). Its global sequence is the resumable cursor, and rows
  are pruned after the retention window.
- **Fan-out.** After the append, writers send a payload-free poke to the
  fan-out host:
  - on the Worker, one `MailEventHub` Durable Object using the WebSocket
    Hibernation API;
  - on Bun, an in-process host.
- **Delivery.** The host reads the log from each subscription's last cursor
  and re-checks MAIL_READ for every event. Replay after a reconnect and live
  delivery therefore share one gap-free, duplicate-free path.
- **Clients.** The web client and `flying-mail watch` share a small,
  dependency-free client package.

See `design-realtime-push.md`.

## Per-consumer fetch state

Every API key is a *consumer*. `message_fetch_states` records, per
`(message, consumer)`, whether that consumer has already retrieved the
message. Agents poll `messages(filter: { fetchStatus: NOT_FETCHED })` and
acknowledge with the `markMessagesFetched` mutation, which makes exactly-once
style processing possible without agents keeping their own cursor.

See `design-graphql-api.md#fetch-state`.

## Tagging

Messages carry user-defined tags plus reserved **system tags** identified by a
stable slug rather than a name. `SPAM` is the special junk-mail tag: it is
applied automatically by the ingest pipeline's spam signals and excluded from
default message listings.

See `design-domain-model.md#tags`.

## Mail templates

Templates are instance-wide reusable bodies with declared variables, rendered
parse-only (no `new Function`) so nothing a template contains can execute --
the API runs on Workers, where runtime code generation is unavailable.
Template capabilities are global rather than per-address: a template belongs
to no mailbox.

See `design-mail-templates.md`.

## Contacts

Contacts are owned per provisioned mail address: each `mail_addresses` row
can hold address books whose contacts are visible to whoever holds mail
permissions on that address, and the cross-address view is the merged set
over every address the viewer can read -- no separate contact permission
system exists. CardDAV support is client-side sync with an external server
(iCloud in practice); flying-mail never serves DAV.

See `design-contacts.md`.

## External mail accounts

External mailboxes are aggregated by binding an external account to one
managed mail address: fetch pulls new remote messages over JMAP or POP3
(implicit TLS) through the ordinary ingest pipeline into that mailbox, and
sending as that address relays through the provider's SMTP submission
server (465/587 via `cloudflare:sockets`; port 25 is unreachable from
Workers by platform rule). flying-mail is a client of all three protocols and
serves none of them.

See `design-external-mail.md`.

## Deployment

`wrangler deploy` publishes the Worker with the D1, R2, `send_email` and
`ASSETS` bindings; Email Routing is configured to deliver the managed domains'
mail to that Worker. Outbound mail requires a verified sender domain on
Cloudflare Email Service (Workers Paid plan). Local development runs the same
hono app under Bun with a libsql file database.

See `design-deployment.md`.

## Supporting documents

| Document | Contents |
|----------|----------|
| `design-domain-model.md` | Entities, value objects, invariants |
| `design-api-keys-and-permissions.md` | Key format, scopes, matching rules |
| `design-security-model.md` | Threat model, bootstrap token, invitations, Turnstile, rate limiting, custom-domain exposure |
| `design-mail-pipeline.md` | Inbound `email()` ingest, outbound send |
| `design-graphql-api.md` | Schema, errors, fetch state, pagination |
| `design-storage-and-file-links.md` | D1 schema, R2 layout, temp file links |
| `design-web-client.md` | SolidJS mail client structure |
| `design-mail-templates.md` | Template model, rendering, send flow |
| `design-contacts.md` | Address books, contacts, cross-address view, CardDAV sync |
| `design-external-mail.md` | External accounts, JMAP/POP3 fetch, SMTP relay |
| `design-deployment.md` | Bindings, env vars, Cloudflare setup steps |
| `design-webmail-completion.md` | Compose/HTML editor, forward with attachments, drafts lifecycle, multi-recipient inbound, single-call outbound, unified inbox |
| `design-realtime-push.md` | Mail event log and cursors, GraphQL subscriptions over graphql-transport-ws, Durable Object hibernation fan-out, live web updates, `flying-mail watch` |
