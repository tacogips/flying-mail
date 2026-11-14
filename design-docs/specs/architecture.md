# Architecture Design

mailcal is a self-hosted, multi-domain mail service that runs entirely on
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
| Browser mail client (`mailcal client serve`, or the Worker's own SPA) | `HttpOnly` session cookie | GraphQL over HTTPS |

## Layering

The repository is a Bun workspace monorepo using the same clean-architecture
layering as the reference project `xxip`. The dependency rule points inward:
`domain` depends on nothing, and no inner layer imports an outer one.

| Package | Depends on | Responsibility |
|---------|-----------|----------------|
| `@mailcal/domain` | - | Entities, branded value objects, invariants, `DomainError` |
| `@mailcal/application` | domain | Ports (interfaces), use cases, permission policies, `ApplicationError` |
| `@mailcal/adapter` | application, domain | Concrete ports: D1/libsql, R2/S3/memory, WebCrypto, MIME parse/build, Cloudflare mail, repositories, migration runner |
| `@mailcal/infrastructure` | adapter, application, domain | GraphQL schema/resolvers, hono HTTP app, auth middleware, file-link routes, composition root |

| App | Runtime | Responsibility |
|-----|---------|----------------|
| `apps/api` | Workers / Bun / Node | `fetch` + `email` handlers, wrangler config, D1 migrations |
| `apps/web` | Browser (Vite + SolidJS) | Mail client SPA |
| `apps/cli` | Bun / Node | `mailcal` CLI, including `mailcal client serve` |

## Storage

| Store | Binding | Contents |
|-------|---------|----------|
| D1 | `DB` | mail: `domains`, `messages`, `message_recipients`, `attachments`, `tags`, `message_tags`, `message_fetch_states`, `api_keys`, `api_key_scopes`, `file_links`, `users`, `sessions`, `email_auth_challenges`; templates: `mail_templates`, `user_template_permissions`; calendar: `calendars`, `calendar_events`, `event_mentions`, `event_links`, `event_attachments`, `user_calendar_permissions`, and the CalDAV sync tables `caldav_accounts`, `caldav_calendars`, `caldav_event_states`, `caldav_deletions` |
| R2 | `BLOB` | `raw/<messageId>.eml` (full MIME source), `att/<attachmentId>/<fileName>` (decoded attachment bodies, shared by mail and calendar-event attachments) |

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

## GraphQL API

A single `POST /graphql` endpoint (graphql-yoga on hono) exposes queries for
domains, messages, threads, tags, attachments, file links and API keys, and
mutations for sending mail, tagging, spam marking, per-consumer fetch-state
updates, domain management and key issuance. Errors always carry
`extensions.code`.

See `design-graphql-api.md`.

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

## Calendar and CalDAV

Calendars and events live beside mail in the same D1 database and reuse the
same R2 attachment layout: an event claims a staged `POST /api/attachments`
upload through `event_attachments`, so there is one upload path and one
download route for both features. Occurrence expansion is a pure domain
function over an RFC 5545 subset; the repository narrows candidate rows in
SQL using the denormalized `range_start_utc` / `recurrence_until_utc`
columns and the domain decides which occurrences actually fall in range.

mailcal is a CalDAV **client** only -- it serves no CalDAV endpoint. Sync is
an on-demand mutation: discovery, `sync-collection` with an etag-PROPFIND
fallback, chunked `calendar-multiget`, and conditional `PUT`/`DELETE`, with
conflicts resolved deterministically remote-wins. The unit of push is the
calendar object resource (a series master together with its `RECURRENCE-ID`
overrides in one `VCALENDAR`), because RFC 4791 stores every component
sharing a UID in one resource. iCloud app-specific passwords are held as
AES-256-GCM ciphertext keyed by `MAILCAL_CREDENTIAL_KEY`; without that secret
CalDAV reports `SERVICE_UNAVAILABLE` and the rest of the calendar works.

Attendance is deliberately absent: no RSVP, `PARTSTAT` or `ATTENDEE` state
exists in the domain, D1, GraphQL or the UI. Mentions are plain addresses
carried as `X-MAILCAL-MENTION`, and an inbound `ATTENDEE` is reduced to an
address with its status parameters dropped.

See `design-calendar.md`.

## Mail templates

Templates are instance-wide reusable bodies with declared variables, rendered
parse-only (no `new Function`) so nothing a template contains can execute --
the API runs on Workers, where runtime code generation is unavailable.
Template capabilities are global rather than per-address: a template belongs
to no mailbox.

See `design-mail-templates.md`.

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
| `design-mail-pipeline.md` | Inbound `email()` ingest, outbound send |
| `design-graphql-api.md` | Schema, errors, fetch state, pagination |
| `design-storage-and-file-links.md` | D1 schema, R2 layout, temp file links |
| `design-web-client.md` | SolidJS mail client structure |
| `design-calendar.md` | Calendars, events, recurrence, mentions, CalDAV sync |
| `design-mail-templates.md` | Template model, rendering, send flow |
| `design-deployment.md` | Bindings, env vars, Cloudflare setup steps |
