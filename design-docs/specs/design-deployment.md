# Deployment

## Cloudflare resources

| Resource | Created with | Binding |
|----------|--------------|---------|
| D1 database `mailcal-db` | `wrangler d1 create mailcal-db` | `DB` |
| R2 bucket `mailcal-mail` | `wrangler r2 bucket create mailcal-mail` | `BLOB` |
| Email send binding | `[[send_email]]` in `wrangler.toml` | `EMAIL` |
| Static assets | `[assets]` pointing at `apps/web/dist` | `ASSETS` |

A **Workers Paid plan** ($5/month) is required: Email Routing to a Worker plus
Cloudflare Email Service sending are not available on the free tier at the
volumes this project targets, and R2 + D1 usage beyond the free allowance is
billed there too.

## wrangler.toml

```toml
name = "mailcal-api"
main = "src/worker.ts"
compatibility_date = "2026-08-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "mailcal-db"
database_id = "<set after wrangler d1 create>"

[[r2_buckets]]
binding = "BLOB"
bucket_name = "mailcal-mail"

[[send_email]]
name = "EMAIL"

[assets]
directory = "../web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
# Note: the asset server answers matching requests *before* the Worker runs,
# so `http/security-headers.ts` never sees them. The SPA's security headers
# are therefore declared in `apps/web/public/_headers`, which vite copies
# into the bundle.

# Only the custom domain serves the Worker, so zone-level DDoS/WAF
# protection always applies. workers.dev and per-version preview URLs are off
# because either one would bypass it. See design-security-model.md section 7.
workers_dev = false
preview_urls = false
routes = [{ pattern = "mail.tacoserve.online", custom_domain = true }]

[[ratelimits]]
name = "AUTH_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[vars]
FLYING_MAIL_PUBLIC_ORIGIN = "https://mail.tacoserve.online"
# FLYING_MAIL_MAIL_FROM = "postmaster@example.com"
FLYING_MAIL_TURNSTILE_SITE_KEY = ""   # public site key; fill before putting the secret
# FLYING_MAIL_INVITE_TTL_SECONDS = "604800"
# Secrets (wrangler secret put, never here):
#   FLYING_MAIL_BOOTSTRAP_TOKEN, FLYING_MAIL_TURNSTILE_SECRET_KEY
```

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `FLYING_MAIL_PUBLIC_ORIGIN` | for login + file links | - | Absolute origin used to build login and file-link URLs. Must match the deployed hostname, or links point at the wrong host. Unset disables passwordless login rather than generating broken links; set-but-invalid fails deployment fast. |
| `FLYING_MAIL_MAIL_FROM` | for login mail | - | Verified sender used for system mail (login links). |
| `FLYING_MAIL_INVITE_TTL_SECONDS` | no | `604800` | Lifetime of an invitation link. An integer in `[86400, 2592000]`; any other value falls back to the default. |
| `FLYING_MAIL_BOOTSTRAP_TOKEN` | **secret**, for bootstrap | - | Enables `bootstrapAdmin`. Unset means bootstrap is disabled (`SERVICE_UNAVAILABLE`). It must be at least 32 characters, otherwise the build fails fast. Delete it after bootstrap. |
| `FLYING_MAIL_TURNSTILE_SECRET_KEY` | **secret**, optional | - | Enables Turnstile on `requestEmailAuth`. It requires `FLYING_MAIL_TURNSTILE_SITE_KEY` and `FLYING_MAIL_PUBLIC_ORIGIN`, otherwise the build fails fast. |
| `FLYING_MAIL_TURNSTILE_SITE_KEY` | with the secret | - | Public site key, exposed through `publicConfig` only while the secret is set. |
| `AUTH_RATE_LIMITER` | binding | - | Workers Rate Limiting binding for the auth mutations. When it is absent, rate limiting is disabled in the Worker. The Bun server always uses an in-memory limiter. |
| `FLYING_MAIL_SPAM_THRESHOLD` | no | `0.6` | Score at or above which the `SPAM` tag is applied. |
| `FLYING_MAIL_FILE_LINK_MAX_TTL` | no | `604800` | Cap, in seconds, on `ttlSeconds` for file links. |
| `FLYING_MAIL_BLOB_BACKEND` | no | `r2` | `r2` \| `s3` \| `memory`. |
| `FLYING_MAIL_S3_*` | if `s3` | - | `ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`. |
| `FLYING_MAIL_SQLITE_URL` | local only | `file:./data/mailcal.db` | libsql location for the Bun/Node server. A bare filesystem path is accepted and promoted to a `file:` URL. |

Real-time push (2026-10-08, `design-realtime-push.md` section 9):

| Variable / binding | Required | Default | Purpose |
|--------------------|----------|---------|---------|
| `MAIL_EVENT_HUB` | binding | - | Durable Object namespace for class `MailEventHub`. It is declared with `[[durable_objects.bindings]]` and the `[[migrations]]` tag `v1-mail-event-hub` (`new_sqlite_classes`). When it is absent, WebSocket upgrades return 503 and writers skip the notify. |
| `FLYING_MAIL_EVENT_RETENTION_SECONDS` | no | `604800` | Mail event log retention, an integer in `[3600, 2592000]`. Any other value falls back to the default. |

Migration `0016_mail_events.sql` must be applied before the Worker that
writes events is deployed; `mise run cf-deploy` already applies migrations
first. The Durable Object class migration is applied by `wrangler deploy`
and cannot be cleanly undone, so do not remove the binding in a rollback.

There is no self-signup setting. `FLYING_MAIL_SIGNUP` was removed on
2026-10-07, and users exist only through `bootstrapAdmin` (once) or an
admin's `createUser` invitation. See `design-security-model.md`.

Secrets go through `wrangler secret put`, never into `wrangler.toml`. Local
secret-dependent commands run under `kinko exec`.

## Bring-up order

The normative procedure is `design-security-model.md` section 8. In short:

1. `mise install && bun install`
2. `wrangler d1 create mailcal-db` and `wrangler r2 bucket create mailcal-mail`;
   paste the database id into `wrangler.toml`.
3. Create a Turnstile widget for `mail.tacoserve.online` and put its site
   key into `FLYING_MAIL_TURNSTILE_SITE_KEY` in `wrangler.toml`.
4. `mise run cf-deploy`. It builds the web client, applies remote
   migrations, deploys, and attaches the custom domain.
5. Put the secrets with `kinko exec -- bunx wrangler secret put`:
   `FLYING_MAIL_BOOTSTRAP_TOKEN` (generated with `openssl rand -base64 48`)
   and `FLYING_MAIL_TURNSTILE_SECRET_KEY`.
6. Add the mail domain to Cloudflare, enable **Email Routing**, create the
   catch-all rule to the `mailcal-api` Worker, and verify the domain for
   **sending**, so that `FLYING_MAIL_MAIL_FROM` is a verified sender.
7. Bootstrap the first admin:
   `kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online mise run bootstrap-admin you@example.com "You"`.
   It prints the admin and the API key prefix only. The full-capability key
   is written to `.private/bootstrap-admin-api-key` (mode 0600, gitignored).
   Bootstrap succeeds once, only on an empty instance, and only with the
   token.
8. Delete the bootstrap secret:
   `kinko exec -- bunx wrangler secret delete FLYING_MAIL_BOOTSTRAP_TOKEN`.
9. Sign in at `/login`. Add domains and mailboxes, and invite users from
   Settings > Users. Each invitee receives a single-use link that lasts 7
   days.
10. Issue narrowly scoped API keys for agents, and revoke the bootstrap key
    once they exist. It is unrestricted by design and is only needed for
    the setup above.

## Local development

```
mise run dev        # API (Bun, libsql file) + web (vite) together
mise run cf-dev     # wrangler dev, Workers runtime with local D1/R2 simulators
```

The local server applies pending `apps/api/migrations/*.sql` on startup
through the adapter's migration runner before serving a single request, so a
clean checkout is usable immediately. Inbound mail cannot be exercised against
a local SMTP path; `apps/api` exposes a dev-only `POST /dev/inbound` route
(registered only when `graphiql` is enabled) that feeds a raw `.eml` fixture
through the identical ingest use case.

Locally, the auth mutations are rate limited by an in-memory limiter keyed
on the socket peer address. Forwarding headers are never trusted there.
Turnstile and bootstrap stay disabled unless their secrets are exported.
