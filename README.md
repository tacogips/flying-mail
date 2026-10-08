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
| `apps/cli` | The `flying-mail` CLI, including `client serve` and `flying-mail watch` |

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

#### User administration by API key

The global `USER_ADMIN` capability lets a key list users with `users` and
`user(id)`, change roles and activation, and add or remove user mail and
template permission rules. It does not grant any other capability (it can also
list domains, for rule resolution), and it never authorizes `createUser` or
`resendInvitation`; user creation and
invitations remain web-only. Only a signed-in admin can grant `USER_ADMIN` in
Settings > API keys. API keys cannot grant it, even keys with `KEY_ADMIN`, and
the bootstrap key does not include it.
Adding `USER_ADMIN` to an existing key is allowed only for the admin who
created that key.

The key's creating admin must continue to exist, be active, and have the
`ADMIN` role. If not, its USER_ADMIN operations return `FORBIDDEN`, while its
other scopes continue to work. A key cannot demote or deactivate the last
active admin; that attempt returns `CONFLICT`. Rules created with the key are
audited to its creating admin. For example, with a placeholder key:

```bash
curl -sX POST https://<worker-host>/graphql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer $KEY' \
  -d '{"query":"mutation { setUserRole(id: \"<user-id>\", role: MEMBER) { id role } }"}'
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

### Subscriptions (real-time push)

Connect to `wss://<host>/graphql` using the `graphql-transport-ws`
subprotocol. A browser authenticates with its `mailcal_session` cookie and
must connect from the same origin. An API key goes in the
`connection_init` payload only; never put it in the URL.

```graphql
enum MailEventType {
  MESSAGE_RECEIVED MESSAGE_SENT MESSAGE_UPDATED MESSAGE_DELETED
  DRAFT_SAVED DRAFT_DELETED LIVE
}

input MailEventScope { domainId: ID, address: String, types: [MailEventType!] }

type MailEvent {
  cursor: String!
  type: MailEventType!
  messageId: ID
  domainId: ID
  addresses: [String!]!
  occurredAt: DateTime!
  message: Message
}

type Subscription {
  mailEvents(scope: MailEventScope, after: String): MailEvent!
}
```

`scope.types` filters event types on the server; when omitted, all types are
included. An empty list or a list containing `LIVE` is `BAD_USER_INPUT`. The
system `LIVE` event is always delivered, regardless of the filter. Filtered-out
rows still advance the subscription cursor, so replay remains gap-free and
duplicate-free.

Use `graphql-ws` with `keepAlive` enabled. Set `retryAttempts: 0` so the
application can resume with its newest cursor. The stock retry resends the
original `after` value. On `RESYNC_REQUIRED`, run a `fetchStatus` sync, clear
the cursor and subscribe again; otherwise save each event cursor before
resubscribing after a disconnect.

The example uses an API key loaded from secure credential storage for each
connection. Browser clients omit `connectionParams` and use the same-origin
session cookie. `reauthenticate()` supplies a refreshed credential or asks
the caller to stop and sign in again.

```ts
import { createClient } from "graphql-ws";

const client = createClient({
  url: "wss://<host>/graphql",
  connectionParams: async () => ({ authorization: "Bearer " + await currentApiKey() }),
  keepAlive: 25_000,
  retryAttempts: 0,
});
let cursor = storedCursor;
let retries = 0;
let active: { unsubscribe(): void } | undefined;
function subscribe(after?: string) {
  active = client.subscribe({
    query: "subscription($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type messageId } }",
    variables: { scope: { address: "support@example.com" }, after },
  }, {
    next: ({ data }) => {
      const event = data?.mailEvents;
      if (event) {
        cursor = event.cursor;
        saveCursor(cursor);
        if (event.type === "LIVE") retries = 0;
      }
    },
    error: (reason) => {
      if (Array.isArray(reason) && reason.some((error) => error.extensions?.code === "RESYNC_REQUIRED")) {
        cursor = undefined;
        saveCursor(cursor);
        void fetchStatusSync().then(() => subscribe());
        return;
      }
      const code = reason instanceof CloseEvent ? reason.code : 0;
      if (code === 4401) {
        void reauthenticate().then((valid) => valid ? subscribe(cursor) : stop());
        return;
      }
      if ([4400, 4403, 4409, 4429, 1009].includes(code)) {
        showFatal(code);
        return;
      }
      const cap = Math.min(30_000, 1_000 * 2 ** retries++);
      setTimeout(() => subscribe(cursor), Math.random() * cap);
    },
    complete: () => {},
  });
}
subscribe(cursor);
```

For a curl-free API client, `flying-mail watch` streams newline-delimited
JSON and persists its cursor:

```bash
flying-mail watch --address support@example.com --json
flying-mail watch --type received,sent --json
```

`--type` accepts `received`, `sent`, `updated`, `deleted`, `draft-saved`, and
`draft-deleted`. Each filter has a separate saved cursor.

```json
{"type":"LIVE","cursor":"<epoch>.<seq>"}
{"type":"MESSAGE_RECEIVED","cursor":"<epoch>.<seq>","messageId":"<message-id>"}
```

The server replays missed events in cursor order, then switches to live
delivery without gaps or duplicates. Cursors are opaque `<epoch>.<seq>`
values. Events are retained for 7 days by default; configure
`FLYING_MAIL_EVENT_RETENTION_SECONDS` from 3600 to 2592000 seconds. If a
cursor is outside retention, web clients do a full refresh and API clients
run a `fetchStatus` sync before subscribing without `after`.

Clients must send a ping at least every 25 seconds. The server closes an
idle connection after 75 seconds with code 4000.

| Code | Name | Sent when | Client action |
|------|------|-----------|---------------|
| 1000 | Normal | Server shutdown or client stop | Reconnect unless stopped by the client |
| 1009 | Message too big | Inbound frame exceeds 16 KiB | Fatal (client bug) |
| 1013 | Try again later | Per-principal rate or concurrency limit | Reconnect with backoff |
| 4000 | Heartbeat timeout | Idle more than 75 seconds | Reconnect |
| 4400 | Bad request | Invalid JSON, message type, init payload, or binary frame | Fatal |
| 4401 | Unauthorized | Missing, invalid, expired or revoked credential; subscribe before ack | Reauthenticate (web: re-check session, else `/login`; CLI: exit 3) |
| 4403 | Forbidden | Valid principal has no MAIL_READ grant, at init or after a permission change | Fatal (web: offline with a message; CLI: exit 4) |
| 4408 | Init timeout | No `connection_init` within 10 seconds | Reconnect |
| 4409 | Subscriber already exists | Duplicate subscription ID | Fatal |
| 4429 | Too many init requests | Second `connection_init` | Fatal |
| 4500 | Internal error | Unexpected server failure (masked and logged without secrets) | Reconnect |

HTTP rejections before upgrade appear to browsers as close 1006 and reconnect
with backoff.

| Limit | Value | Enforcement |
|-------|-------|-------------|
| Inbound frame size | 16 KiB | Hub core; close 1009 |
| Subscriptions per connection | 4 | Hub core; `RATE_LIMITED` error |
| Concurrent connections per IP | 20 | Host before accept; HTTP 429 |
| Concurrent acked connections per principal | 10 | Hub core at init; close 1013 |
| Connections per hub | 1000 | Host; HTTP 503 |
| Connection attempts per IP | 10 / 60 seconds | `RateLimiter`; HTTP 429 |
| `connection_init` per principal | 10 / 60 seconds | `RateLimiter`, key `ws:init:<kind>:<id>`; close 1013 |
| Replay page | 200 rows | Hub core |

`flying-mail client serve` does not proxy WebSockets, so the web client shows
Offline there and continues to work with manual refresh.

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
- `createUser` and `resendInvitation` require a signed-in admin web session
  and remain web-only. A `USER_ADMIN` API key can manage existing users and
  their permission rules; the bootstrap key does not include `USER_ADMIN`.

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

The bootstrap API key, which includes every bootstrap-granted capability
except `USER_ADMIN`, is written with mode `0600` to
`.private/bootstrap-admin-api-key`; command output includes the admin and
key prefix only. Delete the bootstrap secret after the command succeeds.

## Documentation

| Document | Contents |
|----------|----------|
| `design-docs/specs/architecture.md` | System overview and layering |
| `design-docs/specs/design-domain-model.md` | Entities and invariants |
| `design-docs/specs/design-api-keys-and-permissions.md` | Key format, scopes, matching |
| `design-docs/specs/design-user-admin-capability.md` | USER_ADMIN capability and event-type filter |
| `design-docs/specs/design-realtime-push.md` | Real-time push and subscriptions |
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
flying-mail watch --address support@example.com --json
```

## User administration from the CLI

The `flying-mail user` commands require a live `USER_ADMIN` capability:

```bash
flying-mail user list --json
flying-mail user show <email|id>
flying-mail user set-role <user> <ADMIN|MEMBER|VIEWER>
flying-mail user activate <user>
flying-mail user deactivate <user>
flying-mail user rule add <user> --effect ALLOW|DENY [--domain <name|id>] --pattern <pattern>
flying-mail user rule remove <user> <rule-id>
flying-mail user template-rule add <user> --capability TEMPLATE_READ|TEMPLATE_CREATE|TEMPLATE_UPDATE|TEMPLATE_DELETE --effect ALLOW|DENY
flying-mail user template-rule remove <user> <rule-id>
```

A `FORBIDDEN` response exits with code 4 and includes a hint that the key
needs `USER_ADMIN` or its creating admin is no longer active. User creation
(`createUser`) and invitations (`resendInvitation`) remain web-only.

## Project name compatibility

The project, CLI, and workspace packages are named `flying-mail`, and every
configuration variable uses the `FLYING_MAIL_*` prefix. The earlier
`MAILCAL_*` names were renamed on 2026-10-07 and are no longer read; update
any `.env` file or Worker secret that still uses the old prefix.
`~/.config/mailcal/config.json`, `data/mailcal.db`, domain verification
records, and Cloudflare resource names remain under their existing names to
preserve deployed instances and stored data.

Repository: https://github.com/tacogips/flying-mail
