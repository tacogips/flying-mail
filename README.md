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

This repository is deployed at **https://mail.tacoserve.online** (Cloudflare
account `me+cloudflare@tacogips.me`), backed by the `mailcal-db` D1 database
and the `mailcal-mail` R2 bucket, with both migrations applied. The Worker
uses this custom domain; `workers.dev` and preview URLs are disabled.

Managed mail domains are `tacoserve.online` and `mutvar-test.online`.
Cloudflare Email Routing uses a catch-all rule to deliver inbound mail to
the Worker. It uses the `mailcal-db` D1 database and the `mailcal-mail` R2
bucket.

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

The operator runbook for agents and humans is the
[flying-mail-deploy skill](.agents/skills/flying-mail-deploy/SKILL.md),
available to Claude Code via `.claude/skills` and to Codex via `.codex/skills`.
It covers routine deploys, post-deploy smoke checks, domain provisioning,
rollback and data reset.

Follow the first-deploy procedure in
[`design-docs/specs/design-security-model.md`](design-docs/specs/design-security-model.md):

1. Install the project tools and dependencies with `mise install && bun install`.
2. Create or confirm the `mailcal-db` D1 database and `mailcal-mail` R2
   bucket, then set the database id in `wrangler.toml`.
3. Create a Turnstile widget for `mail.tacoserve.online` and set its site key
   as `FLYING_MAIL_TURNSTILE_SITE_KEY` in `wrangler.toml` before deploying
   the Turnstile secret.
4. Run `mise run cf-deploy`. The Worker uses the custom domain
   `mail.tacoserve.online`; `workers_dev` and `preview_urls` are disabled.
   A **Workers Paid plan** is required.
5. Put `FLYING_MAIL_BOOTSTRAP_TOKEN` and
   `FLYING_MAIL_TURNSTILE_SECRET_KEY` using `kinko exec -- bunx wrangler
   secret put`. Generate the bootstrap token with
   `openssl rand -base64 48`; it must be at least 32 characters or the
   Worker fails fast. Keep the bootstrap token in kinko; never put secret
   values in `wrangler.toml`.

   Between steps 4 and 5, Turnstile is off and bootstrap is disabled, as
   described in section 8 of the
   [security model](design-docs/specs/design-security-model.md).
6. Configure Email Routing and Email Sending as described in the
   [cloudflare-mail-setup skill](.agents/skills/cloudflare-mail-setup/SKILL.md).
   Verify `FLYING_MAIL_MAIL_FROM` as a sender before bootstrapping.
7. Create the first admin with
   `kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online mise run bootstrap-admin <email> <name>`.
   The task writes the full API key to
   `.private/bootstrap-admin-api-key` and prints only its prefix.
8. Delete `FLYING_MAIL_BOOTSTRAP_TOKEN` with
   `kinko exec -- bunx wrangler secret delete FLYING_MAIL_BOOTSTRAP_TOKEN`.
9. Sign in at `https://mail.tacoserve.online/login`, add domains and
   mailboxes, and invite users from Settings > Users. Invitation links are
   single-use and last 7 days by default.
10. Issue scoped API keys and revoke the bootstrap key when setup is complete.

| Setting | Kind | Purpose |
|---------|------|---------|
| `FLYING_MAIL_BOOTSTRAP_TOKEN` | Secret | Enables one-time bootstrap on an empty instance; delete it after use. |
| `FLYING_MAIL_TURNSTILE_SECRET_KEY` | Secret | Enables server-side Turnstile verification for login-link requests. |
| `FLYING_MAIL_TURNSTILE_SITE_KEY` | Public var | Site key for the `mail.tacoserve.online` Turnstile widget; deploy it before the secret. |
| `FLYING_MAIL_INVITE_TTL_SECONDS` | Var | Invitation link lifetime, default `604800` seconds. |

The security model is invite-only onboarding, Turnstile protection on login-link
requests, and per-IP rate limiting reported as `RATE_LIMITED`. See the
[security model](design-docs/specs/design-security-model.md) for the controls
and deployment invariants.

Signing in and inviting users are manual browser operations by design:

- Requesting a sign-in link needs a Turnstile token, which only a real browser
  can obtain.
- `createUser` and `resendInvitation` require a signed-in admin web session.
  API keys, including the bootstrap key, are refused for user management.

Everything else (mail, drafts, domains, mailboxes and files) is fully
automatable through GraphQL and the REST file endpoints with scoped API keys.

## Bootstrapping a fresh deployment

`bootstrapAdmin` requires `FLYING_MAIL_BOOTSTRAP_TOKEN` and succeeds once,
only while the instance has no users. The mise task is the primary method;
run it through `kinko exec` so the token is supplied from the environment:

```bash
kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online \
  mise run bootstrap-admin you@example.com "You"
```

The full-capability API key is written with mode `0600` to
`.private/bootstrap-admin-api-key`; command output includes the admin and
key prefix only. Delete the bootstrap secret after the command succeeds.

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
| `design-docs/specs/design-security-model.md` | Authentication, onboarding, and edge protection |
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
