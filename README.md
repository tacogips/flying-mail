# flying-mail

A self-hosted, multi-domain mail service that runs entirely on Cloudflare
Workers. It receives mail through Cloudflare Email Routing, stores messages
and attachments in D1 + R2, and exposes everything through a single GraphQL
endpoint built for AI agents and programmatic clients as first-class callers
— with a SolidJS browser mail client as a second consumer of the same API.

```
   inbound SMTP                                        outbound
 ─────────────────►  Cloudflare Email Routing  ─────────────────►
                            │  ▲
                    email() │  │ EMAIL binding .send()
                            ▼  │
   ┌──────────────────────────────────────────────────────────┐
   │              apps/api  (Cloudflare Worker)               │
   │  fetch() → hono → /graphql (yoga)                        │
   │                 → /files/:token  (temp file links)       │
   │                 → ASSETS (SolidJS SPA)                   │
   │  email() → ingest pipeline                               │
   └──────────────────────────────────────────────────────────┘
              │                                │
          D1 (DB)                          R2 (BLOB)
```

## What it does

- **Multi-domain.** Add domains, publish the DNS records it prints, verify,
  and mail starts arriving. Unknown recipients are rejected at SMTP time
  rather than black-holed.
- **Scoped API keys.** A key is a list of `(capability, domain,
  addressPattern)` scopes. An agent can be issued a key that may only read
  and reply to `support@example.com`, and nothing else. An unscoped key is
  refused.
- **GraphQL for agents.** One endpoint for domains, messages, threads, tags,
  attachments, file links and key administration.
- **Per-consumer fetch state.** Each API key has its own
  `NOT_FETCHED`/`FETCHED` queue, so two agents polling the same mailbox each
  see every message exactly once. Acknowledgment is idempotent.
- **Temp file links.** Mint a short-lived, credential-free HTTPS URL for an
  attachment or a raw `.eml`, with an expiry and an optional download cap —
  so an agent can hand a plain link to a tool or a person without handing
  over its key.
- **Tagging, with a reserved spam tag.** User tags plus four system tags
  addressed by slug. Inbound mail is scored on explainable signals (SPF/DKIM/
  DMARC results, envelope-vs-header sender mismatch, phrase and blocklists)
  and auto-tagged `SPAM`; spam is hidden from default listings.
- **Browser mail client.** `flying-mail client serve` serves the SolidJS client
  locally against any deployment. HTML mail is sanitized *and* rendered in a
  sandboxed iframe, with remote images blocked until the reader opts in.

## Layout

| Package | Responsibility |
|---------|----------------|
| `packages/domain` | Entities, branded value objects, invariants |
| `packages/application` | Ports, use cases, authorization policy |
| `packages/adapter` | D1/libsql, R2/S3/memory, WebCrypto, MIME, repositories |
| `packages/infrastructure` | GraphQL schema/resolvers, hono app, composition root |
| `apps/api` | Worker (`fetch` + `email`), migrations, local Bun/Node server |
| `apps/web` | SolidJS mail client |
| `apps/cli` | The `flying-mail` CLI, including `client serve` |

The dependency rule points inward: `domain` depends on nothing, and no inner
layer imports an outer one.

## Getting started

```bash
mise install && bun install
mise run dev          # local API (libsql + in-memory blobs) and the web client
mise run ci           # lint, typecheck, tests, build
```

The local server applies every pending migration and seeds the system tags
before serving a single request, so a clean checkout runs immediately. It
also exposes a dev-only `POST /dev/inbound?from=&to=` route that feeds a raw
`.eml` through the identical ingest pipeline the Worker uses — local
development has no SMTP path.

## Deployed instance

This repository is deployed at **https://mailcal-api.tacotest.workers.dev**
(Cloudflare account `me+cloudflare@tacogips.me`), backed by the `mailcal-db`
D1 database and the `mailcal-mail` R2 bucket, with both migrations applied.

The instance operates multiple managed domains, including
`tacoserve.online` and `mutvar-test.online`. Cloudflare Email Routing uses a
catch-all rule to deliver inbound mail to the `mailcal-api` Worker. The
Worker uses the `mailcal-db` D1 database and the `mailcal-mail` R2 bucket.

## API

The GraphQL endpoint is `POST https://<worker-host>/graphql`. API clients
authenticate with `Authorization: Bearer ybm_<key>`; the web client uses the
`mailcal_session` session cookie. The examples use placeholder hostnames,
keys, IDs and addresses.

List messages for a domain and mailbox:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer $KEY' \
  -d '{"query":"query { messages(filter: { domainId: \"<domain-id>\", toAddress: \"support@example.com\" }) { nodes { id subject from { address } } nextCursor totalCount } }"}'
```

Send a message with cc, bcc and HTML content:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { sendMessage(input: { from: \"support@example.com\", to: [\"person@example.net\"], cc: [\"copy@example.net\"], bcc: [\"blind-copy@example.net\"], subject: \"Report\", text: \"See the report.\", html: \"<p>See the report.</p>\" }) { id deliveryStatus } }"}'
```

Save a draft, send it, then delete a draft that should be discarded:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { saveDraft(input: { from: \"support@example.com\", to: [\"person@example.net\"], subject: \"Draft\", text: \"Draft body\" }) { id } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { sendDraft(id: \"<draft-id-to-send>\") { id deliveryStatus } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { deleteDraft(id: \"<draft-id-to-discard>\") }"}'
```

Prepare a forward from a message, then send it with selected original
attachments. Use the returned `forwardedFromMessageId` and attachment IDs in
the send mutation:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"query { composeFromMessage(messageId: \"<source-message-id>\", mode: FORWARD) { from to cc subject forwardedFromMessageId forwardAttachments { id fileName } quotedText } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { sendMessage(input: { from: \"support@example.com\", to: [\"recipient@example.net\"], subject: \"Fwd: Report\", text: \"Forwarded message\", forwardedFromMessageId: \"<source-message-id>\", forwardAttachmentIds: [\"<attachment-id>\"] }) { id deliveryStatus } }"}'
```

Create and verify a domain, provision a mailbox, and grant a user mailbox
permission:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { createDomain(name: \"example.com\") { id name status dnsRecords { type name value } } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { verifyDomain(id: \"<domain-id>\") { id status } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { createMailAddress(input: { domainId: \"<domain-id>\", localPart: \"support\" }) { id address status } }"}'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { addUserMailPermission(userId: \"<user-id>\", input: { effect: ALLOW, domainId: \"<domain-id>\", addressPattern: \"support@example.com\" }) { id effect addressPattern } }"}'
```

Upload an attachment, download it by ID, or create and use a temporary file
link:

```bash
curl -s -H 'authorization: Bearer $KEY' \
  -F file=@report.pdf https://<worker-host>/api/attachments
curl -OJ -H 'authorization: Bearer $KEY' \
  'https://<worker-host>/api/attachments/<attachment-id>'
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { createAttachmentLink(attachmentId: \"<attachment-id>\") { url token link { expiresAt } } }"}'
curl -OJ 'https://<worker-host>/files/<token>'
```

## Deploying

See `design-docs/specs/design-deployment.md` for the full bring-up order.
In short: create the D1 database and R2 bucket, `mise run cf-deploy`, enable
Email Routing on your domain with a catch-all rule targeting the Worker,
verify the domain for sending, then add the domain in flying-mail itself.

A **Workers Paid plan** is required.

## Bootstrapping a fresh deployment

A deployed Worker has no shell, and passwordless login needs a verified
sending domain that only an authenticated admin can add. `bootstrapAdmin`
therefore returns a full-capability API key along with the user. It succeeds
only while the instance has no users at all, and closes permanently after
one call.

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"mutation { bootstrapAdmin(email: \"you@example.com\", name: \"You\") { secret apiKey { keyPrefix } } }"}'
```

Store that secret — it is shown once. Revoke it once you have issued
narrowly scoped keys for your agents.

## Documentation

| Document | Contents |
|----------|----------|
| `design-docs/specs/architecture.md` | System overview and layering |
| `design-docs/specs/design-domain-model.md` | Entities and invariants |
| `design-docs/specs/design-api-keys-and-permissions.md` | Key format, scopes, matching |
| `design-docs/specs/design-mail-pipeline.md` | Inbound ingest and outbound send |
| `design-docs/specs/design-graphql-api.md` | Schema, errors, fetch state |
| `design-docs/specs/design-storage-and-file-links.md` | D1 schema, R2 layout, file links |
| `design-docs/specs/design-web-client.md` | Mail client structure |
| `design-docs/specs/design-deployment.md` | Bindings, env vars, setup |
| `design-docs/specs/design-webmail-completion.md` | Compose, drafts, forwarding, multi-domain delivery and completion verification |
| `design-docs/specs/command.md` | CLI interface |
| `design-docs/specs/notes.md` | Research findings and decisions |

## Agent quick start

```graphql
# Poll
query { messages(filter: { fetchStatus: NOT_FETCHED, direction: INBOUND }, first: 20) {
  nodes { id subject from { address } snippet attachments { id fileName } }
  nextCursor
} }

# Acknowledge
mutation($ids: [ID!]!) { markMessagesFetched(messageIds: $ids) { id fetchStatus } }
```

Or from the shell:

```bash
flying-mail mail fetch --ack --watch --interval 30
```

## Project name compatibility

The project, CLI, and workspace packages are named `flying-mail`, and every
configuration variable uses the `FLYING_MAIL_*` prefix. The earlier
`MAILCAL_*` names were renamed on 2026-10-07 and are no longer read; update
any `.env` file or Worker secret that still uses the old prefix.
`~/.config/mailcal/config.json`, `data/mailcal.db`, domain verification
records, and Cloudflare resource names remain under their existing names to
preserve deployed instances and stored data.

Repository: https://github.com/tacogips/flying-mail
