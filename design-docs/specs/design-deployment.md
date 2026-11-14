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

[vars]
MAILCAL_PUBLIC_ORIGIN = "https://mailcal-api.<account>.workers.dev"
# MAILCAL_MAIL_FROM = "postmaster@example.com"
```

## Environment variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MAILCAL_PUBLIC_ORIGIN` | for login + file links | - | Absolute origin used to build login and file-link URLs. Must match the deployed hostname, or links point at the wrong host. Unset disables passwordless login rather than generating broken links; set-but-invalid fails deployment fast. |
| `MAILCAL_MAIL_FROM` | for login mail | - | Verified sender used for system mail (login links). |
| `MAILCAL_SIGNUP` | no | `closed` | `open` allows self-service signup. Defaults closed because this is a mail server. |
| `MAILCAL_SPAM_THRESHOLD` | no | `0.6` | Score at or above which the `SPAM` tag is applied. |
| `MAILCAL_FILE_LINK_MAX_TTL` | no | `604800` | Cap, in seconds, on `ttlSeconds` for file links. |
| `MAILCAL_BLOB_BACKEND` | no | `r2` | `r2` \| `s3` \| `memory`. |
| `MAILCAL_S3_*` | if `s3` | - | `ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `REGION`. |
| `MAILCAL_SQLITE_URL` | local only | `file:./data/mailcal.db` | libsql location for the Bun/Node server. A bare filesystem path is accepted and promoted to a `file:` URL. |

Secrets go through `wrangler secret put`, never into `wrangler.toml`. Local
secret-dependent commands run under `kinko exec`.

## Bring-up order

1. `mise install && bun install`
2. `wrangler d1 create mailcal-db` and `wrangler r2 bucket create mailcal-mail`;
   paste the database id into `wrangler.toml`.
3. `mise run build-web` then `mise run cf-deploy` (applies remote migrations,
   then deploys).
4. Add the mail domain to Cloudflare and enable **Email Routing** on it.
5. Create a catch-all Email Routing rule that delivers to the `mailcal-api`
   Worker.
6. Verify the domain for **sending** under Email Service, then set
   `MAILCAL_MAIL_FROM`.
7. Bootstrap the instance. A deployed Worker has no shell, and passwordless
   login needs a verified sending domain that only an authenticated admin
   can add -- so `bootstrapAdmin` returns a full-capability API key along
   with the user. It succeeds only while the instance has no users at all,
   and is permanently closed afterwards. **Store the secret; it is shown
   once.**

   ```bash
   curl -sX POST https://<worker-host>/graphql \
     -H 'content-type: application/json' \
     -d '{"query":"mutation { bootstrapAdmin(email: \"you@example.com\", name: \"You\") { secret apiKey { keyPrefix } user { email } } }"}'
   ```

8. Using that key, `createDomain` + `verifyDomain` through GraphQL, the CLI,
   or the settings UI, so mailcal itself will accept mail for the domain.
9. Issue narrowly scoped API keys for agents, and revoke the bootstrap key
   once they exist -- it is unrestricted by design and is only needed for
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
