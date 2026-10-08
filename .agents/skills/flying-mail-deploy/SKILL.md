---
name: flying-mail-deploy
description: Use when deploying flying-mail to Cloudflare Workers, re-deploying after code changes, standing up a fresh environment, provisioning domains and mailboxes, rolling back, or resetting deployment data. Covers build and verification gates, remote D1 migrations, wrangler deploy to the mail.tacoserve.online custom domain, secrets via kinko, first-admin bootstrap, post-deploy smoke checks and known pitfalls. Contains no secret values.
allowed-tools: Bash, Read
---

# Deploying flying-mail to Cloudflare Workers

flying-mail runs as one Cloudflare Worker that serves the GraphQL API, the
REST file endpoints, the SolidJS web client (Workers Static Assets) and the
inbound `email()` handler. This skill is the operator runbook. For mail
plumbing (Email Routing, Email Sending, DNS) use the companion skill
`cloudflare-mail-setup`. For the security rationale see
`design-docs/specs/design-security-model.md`.

## Resource inventory

These names come from `apps/api/wrangler.toml`. They are operational
identifiers and are not secret.

| Resource | Name |
|----------|------|
| Worker | `mailcal-api` |
| Public origin | `https://mail.tacoserve.online` (custom domain) |
| D1 database | `mailcal-db` (`database_id` in `wrangler.toml`) |
| R2 bucket | `mailcal-mail` |
| Rate limit binding | `AUTH_RATE_LIMITER` (10 requests per 60 s) |
| Durable Object binding | `MAIL_EVENT_HUB` -> `MailEventHub` |
| Send binding | `EMAIL` (`send_email`) |
| Turnstile widget | `flying-mail-login` (public site key in `wrangler.toml`) |
| Managed mail domains | `tacoserve.online`, `mutvar-test.online` |

`workers_dev = false` and `preview_urls = false` are deliberate. The
workers.dev URL and version preview URLs would otherwise bypass zone-level
DDoS/WAF protection. Do not re-enable them.

## Secrets: names only, values live in kinko

Never print, echo, log or commit a secret value. Never put one in
`wrangler.toml`. Values are kept in the project's kinko vault and are only
ever piped into `wrangler secret put` or injected with `kinko exec`.

| Name | Where | Purpose |
|------|-------|---------|
| `FLYING_MAIL_CREDENTIAL_KEY` | Worker secret + kinko | AES-256-GCM key for stored CardDAV/external-mail credentials |
| `FLYING_MAIL_TURNSTILE_SECRET_KEY` | Worker secret + kinko | Server-side Turnstile verification |
| `FLYING_MAIL_BOOTSTRAP_TOKEN` | kinko; Worker secret only during first bootstrap | One-time first-admin creation |
| `FLYING_MAIL_API_KEY` | kinko only | Operator API key for GraphQL/REST automation |
| `CLOUDFLARE_API_TOKEN` | kinko only | DNS edit for the two mail zones (TXT records) |

If kinko reports `locked`, ask the user to run `! kinko unlock`. You cannot
unlock it non-interactively.

To set a Worker secret from kinko without exposing it:

```bash
kinko --path "$PWD" exec --env FLYING_MAIL_TURNSTILE_SECRET_KEY -- \
  sh -c 'printf "%s" "$FLYING_MAIL_TURNSTILE_SECRET_KEY" | (cd apps/api && mise exec -- wrangler secret put FLYING_MAIL_TURNSTILE_SECRET_KEY)'
```

To generate a new secret straight into kinko (nothing is written to disk or
printed):

```bash
printf 'FLYING_MAIL_BOOTSTRAP_TOKEN=%s\n' "$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')" \
  | kinko --path "$PWD" set --force
```

## Prerequisites

1. `mise install && bun install`.
2. Wrangler is logged in: `mise exec -- wrangler whoami`.
   - The account must be on Workers Paid.
   - The OAuth scopes must include `workers`, `d1`, `email_routing` and
     `email_sending`.
   - If the email scopes are missing, run `mise run mail-login`. It opens a
     browser and needs the user.
3. kinko is unlocked: `kinko status`.

## Routine deploy (code changes)

1. Run the full gate. All three must pass:
   ```bash
   mise run lint && bun run test && mise run build-web
   ```
2. Optionally dry-run the bundle. Check that the binding list shows
   `AUTH_RATE_LIMITER`, `MAIL_EVENT_HUB` and `FLYING_MAIL_TURNSTILE_SITE_KEY`:
   ```bash
   bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun
   ```
3. Roll out the event log and Durable Object in order. `mise run cf-deploy`
   applies pending remote D1 migrations, including migration
   `0016_mail_events.sql`, before deploying the Worker. The subsequent
   `wrangler deploy` applies the Durable Object migration with
   `new_sqlite_classes`:
   ```bash
   mise run cf-deploy
   ```
   New migrations go in `apps/api/migrations/NNNN_*.sql`. Never edit or
   squash an applied migration.
   The binding is `MAIL_EVENT_HUB` and its class is `MailEventHub`. The
   `v1-mail-event-hub` migration tag and class name are permanent once
   deployed. Never remove the binding during rollback; only a
   `deleted_classes` migration removes the class.
4. Run the post-deploy smoke checks (below).

The optional `FLYING_MAIL_EVENT_RETENTION_SECONDS` variable controls event
retention. It defaults to `604800` seconds (7 days) and accepts values from
`3600` through `2592000` seconds.

## Post-deploy smoke checks

```bash
B=https://mail.tacoserve.online
curl -s -o /dev/null -w "root %{http_code}\n" $B/                      # 200
curl -s -o /dev/null -w "workers.dev %{http_code}\n" https://mailcal-api.tacotest.workers.dev/   # 404
curl -s $B/graphql -H 'content-type: application/json' -d '{"query":"{ publicConfig { turnstileSiteKey } }"}'
curl -s $B/graphql -H 'content-type: application/json' -d '{"query":"mutation { requestEmailAuth(email:\"nobody@example.com\") }"}'   # FORBIDDEN (no Turnstile token)
curl -s -D - -o /dev/null $B/ | grep -i content-security-policy        # only challenges.cloudflare.com added
(cd apps/api && mise exec -- wrangler deployments list | tail -6)
```

Check the WebSocket subscription after deployment with the admin operator
API key from kinko; the smoke check uses the `FLYING_MAIL_API_KEY` key that
is also used by the authenticated checks below. A separate read-only key is
optional. Supply the key through the environment; do not put it in a URL or
print its value:

```bash
kinko --path "$PWD" exec --env FLYING_MAIL_API_KEY -- bun run --cwd apps/cli start -- watch --endpoint https://mail.tacoserve.online --json
```

Expect a `LIVE` line, send a test message to a managed address, then expect
a `MESSAGE_RECEIVED` line within seconds. Confirm that the browser connection
indicator shows Live. This is a documented smoke procedure; run it after an
authorized deployment.

Authenticated checks use the operator key from kinko. For example,
`viewer { sendableAddresses }`:

```bash
kinko --path "$PWD" exec --env FLYING_MAIL_API_KEY -- sh -c \
  'curl -s https://mail.tacoserve.online/graphql -H "content-type: application/json" -H "authorization: Bearer $FLYING_MAIL_API_KEY" -d "{\"query\":\"{ viewer { sendableAddresses } }\"}"'
```

## Fresh environment (first deploy)

Follow this order exactly. It mirrors section 8 of the security model and
the README "Deploying" section.

1. Create or confirm the D1 database and the R2 bucket. Put the D1
   `database_id` in `apps/api/wrangler.toml`.
2. Create the Turnstile widget for `mail.tacoserve.online`. Write its
   **public** site key to `FLYING_MAIL_TURNSTILE_SITE_KEY` in
   `wrangler.toml` **before** setting the Turnstile secret. A secret without
   a site key makes the Worker fail fast, and every request returns a masked
   500.
   - The wrangler OAuth token can manage widgets through
     `POST /accounts/<account>/challenges/widgets` (scope
     `challenge-widgets`).
   - Pipe the returned `secret` straight into kinko and `wrangler secret
     put`. Never print it.
3. Run `mise run cf-deploy`. This applies all migrations on an empty
   database and attaches the custom domain.
4. Set `FLYING_MAIL_CREDENTIAL_KEY`, `FLYING_MAIL_TURNSTILE_SECRET_KEY` and
   `FLYING_MAIL_BOOTSTRAP_TOKEN` as Worker secrets from kinko. The bootstrap
   token must be at least 32 characters.
5. Configure mail plumbing with the `cloudflare-mail-setup` skill:
   - Email Routing on each zone.
   - The catch-all rule's action set to `worker:mailcal-api`.
   - Email Sending enabled per domain.
6. Bootstrap the first admin, once:
   ```bash
   kinko --path "$PWD" exec --env FLYING_MAIL_BOOTSTRAP_TOKEN -- \
     env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online mise run bootstrap-admin <email> <name>
   ```
   The full bootstrap API key is written to
   `.private/bootstrap-admin-api-key` (mode 0600, gitignored). Move it into
   kinko as `FLYING_MAIL_API_KEY`, then delete the file:
   ```bash
   printf 'FLYING_MAIL_API_KEY=%s\n' "$(tr -d '\n' < .private/bootstrap-admin-api-key)" | kinko --path "$PWD" set --force
   rm -P .private/bootstrap-admin-api-key && rmdir .private
   ```
   A second bootstrap attempt must return `CONFLICT`.
7. Delete the bootstrap secret from the Worker:
   `cd apps/api && mise exec -- wrangler secret delete FLYING_MAIL_BOOTSTRAP_TOKEN`
   (keep the value in kinko).
8. Provision domains and mailboxes. See the next section.
9. Signing in and inviting users are **manual browser steps for the user**.
   The login-link request needs a Turnstile token, and user administration
   needs an admin web session. API keys are refused for user management by
   design. Do not try to automate or bypass this.

## Provisioning domains and mailboxes (API)

Use GraphQL with the operator key (`FLYING_MAIL_API_KEY`):

1. Create the domain:
   `createDomain(name: "<domain>", catchAll: false) { id verificationToken }`.
2. Publish the ownership TXT record with the DNS-edit token. It prints only
   metadata:
   ```bash
   kinko --path "$PWD" exec --env CLOUDFLARE_API_TOKEN -- \
     python3 .agents/skills/cloudflare-mail-setup/scripts/upsert_cloudflare_dns.py \
     <domain> TXT _mailcal.<domain> "mailcal-verification=<verificationToken>" --ttl 60
   ```
3. Verify the domain with `verifyDomain(id: "<id>") { status }`. Expect
   `ACTIVE`. Verification requires both the TXT record and MX records on
   `*.mx.cloudflare.net`. A domain whose MX points elsewhere (for example
   Google Workspace) can never become ACTIVE.
4. Create mailboxes:
   `createMailAddress(input: { domainId, localPart, displayName }) { address }`.
5. Check `viewer { sendableAddresses }`.

## Rollback

```bash
cd apps/api
mise exec -- wrangler deployments list        # find the previous version id
mise exec -- wrangler rollback <version-id>   # code only
```

Rollback does not revert D1 migrations. Write a forward migration instead.

## Data reset (destructive -- only with explicit user approval)

Only do this when the user explicitly asks to delete all data. Confirm
first.

- **D1.** Delete and recreate the database through the API with the
  wrangler OAuth token (`wrangler d1 delete` has failed with an auth error),
  then update `database_id` in `wrangler.toml`:
  `DELETE /accounts/<account>/d1/database/<uuid>`, then
  `POST /accounts/<account>/d1/database {"name":"mailcal-db"}`.
- **R2.** List the objects with
  `GET /accounts/<account>/r2/buckets/mailcal-mail/objects`. Delete each one
  with `DELETE .../objects/<url-encoded key>`.
- **Redeploy.** Run `mise run cf-deploy`. Then repeat the fresh-environment
  steps 4 onward: bootstrap, domains, mailboxes. Because the domains are
  re-created, they get new ownership tokens, so the `_mailcal` TXT records
  must be updated.

## Known pitfalls

- **Custom domain propagation.** For about a minute after a deploy that
  attaches the domain, the edge can serve an older schema (for example,
  `publicConfig` missing). Retry before debugging.
- **WebSocket upgrade origin.** Upgrades are accepted on the custom domain
  only. A 403 indicates an Origin mismatch; check `FLYING_MAIL_PUBLIC_ORIGIN`.
- **Deploy disconnects.** A Worker deploy disconnects active WebSockets;
  clients reconnect with jitter and resume from their last cursor.
- **Durable Object migration.** Keep the `MAIL_EVENT_HUB` binding and the
  permanent `v1-mail-event-hub` tag in later deploys and rollbacks.
- **Catch-all routing to the Worker.** `wrangler email routing rules update
  <zone> catch-all --action-type worker` is rejected. Use the API instead:
  `PUT /zones/<zone-id>/email/routing/rules/catch_all` with
  `{"actions":[{"type":"worker","value":["mailcal-api"]}],"matchers":[{"type":"all"}],"enabled":true}`.
- **Rate limiting is eventually consistent per Cloudflare location.** A slow
  sequential test may not trip it. A parallel burst does: about 80 requests
  should yield `RATE_LIMITED` responses.
- **Turnstile blocks headless browsers.** Automated UI checks of the login
  page cannot pass it. That is expected.
- **Gmail spam placement.** Mail from a new `.online` domain can
  occasionally be classified as spam even with SPF, DKIM and DMARC aligned.
  This is a reputation issue, not a deployment fault.
- **Sender binding limits.** The binding delivers to arbitrary recipients
  only for domains onboarded to Email Sending. A custom `Message-ID` header
  is rejected (`E_VALIDATION_ERROR`); flying-mail persists the provider's id
  instead.
