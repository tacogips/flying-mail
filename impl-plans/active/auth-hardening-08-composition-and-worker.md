# Auth Hardening 08: Configuration, Composition, Worker and wrangler.toml

**Status**: Ready
**Plan ID**: auth-hardening-08-composition-and-worker
**Wave**: 4 (phase 20)
**Depends On**: auth-hardening-01-contracts-and-persistence, auth-hardening-02-web-client, auth-hardening-05-auth-usecases, auth-hardening-06-adapters, auth-hardening-07-graphql-http

Why plans 02 and 07 are dependencies:

- The end-to-end `CF-Connecting-IP` test needs plan 07's resolver plumbing
  (`ctx.clientIp` passed to the use cases).
- The dry run bundles `apps/web/dist`, which is built from plan 02's web
  code.

Both are complete before this plan starts. Any failure in their files is a
regression to report to the owning plan, never a reason to edit their
files here.
**Design Reference**: design-docs/specs/design-security-model.md sections 2.1, 3.1, 4.3, 5.1, 6.3, 7.1-7.3; design-docs/specs/design-deployment.md
**Created**: 2026-10-07

## Intent and context

This plan turns environment variables and bindings into the new
`InstanceConfig` fields and port instances, and resolves the client IP per
runtime:

- Worker: the `CF-Connecting-IP` header only.
- Bun/Node server: the socket peer address only.

It also rewrites `apps/api/wrangler.toml` for:

- the custom domain
- `workers_dev = false` and `preview_urls = false`
- the `AUTH_RATE_LIMITER` binding
- the new vars and the secret comments

Plan 05 (dependency) changed `bootstrapAdmin` to take a token, so this plan
also updates `apps/api/src/server.test.ts`.

## Non-goals

- No live Cloudflare operations: no deploy, no `wrangler secret`, no
  remote D1.
- No GraphQL or use-case changes.
- Do not edit migrations.
- Do not touch docs. Plan 04 owns README and the skill.

## writePaths

- packages/infrastructure/src/composition/config.ts
- packages/infrastructure/src/composition/config.test.ts
- packages/infrastructure/src/composition/build-dependencies.ts
- apps/api/src/env.ts
- apps/api/src/worker.ts
- apps/api/src/worker.test.ts
- apps/api/src/server.ts
- apps/api/src/server.test.ts
- apps/api/wrangler.toml
- impl-plans/active/auth-hardening-08-composition-and-worker.md (progress log only)
- apps/web/dist. Build artifact root, needed as the dry-run assets
  directory. It is regenerated only through `mise run build-web`.
- apps/api/.wrangler. Wrangler's local bundling cache, created by the dry
  run. Artifact root, gitignored.

sharedPaths: none.

## File-level changes

### `config.ts`

New resolvers. Imitate `resolveFileLinkMaxTtl`, `resolveCredentialKey` and
`CredentialKeyConfigurationError`.

- `resolveInviteTtlSeconds(env): number`
  - Integer in the range `[86400, 2592000]`.
  - Anything else, including unset, blank, a non-integer or out of range,
    returns `DEFAULT_INVITE_TTL_SECONDS` (604800).
- `export class BootstrapTokenConfigurationError extends Error`
- `resolveBootstrapToken(env): string | undefined`
  - It reads the value trimmed. Empty or unset returns `undefined`.
  - Fewer than 32 characters throws `BootstrapTokenConfigurationError`. The
    message names the variable but never echoes its value.
- `export class TurnstileConfigurationError extends Error`
- `resolveTurnstileConfig(env, publicOrigin: string | undefined): { readonly secret: string; readonly siteKey: string; readonly expectedHostname: string } | undefined`
  - The secret is read trimmed. Empty means `undefined`, and Turnstile is
    disabled even if a site key is set.
  - If the secret is set and the site key is empty, it throws.
  - If the secret is set and `publicOrigin` is undefined, it throws.
  - `expectedHostname` is `new URL(publicOrigin).hostname`.
- `BuildDependenciesConfig` gains:
  - `inviteTtlSeconds?: number`
  - `bootstrapToken?: string`
  - `turnstile?: { secret; siteKey; expectedHostname }`
  - `rateLimiter?: RateLimiter`
- `loadConfigFromEnv` (local server) resolves the invite TTL, bootstrap
  token and Turnstile config. It does **not** set `rateLimiter`; `server.ts`
  injects the in-memory one.

### `build-dependencies.ts`

- `instanceConfig`:
  - `inviteTtlSeconds: config.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS`
  - `bootstrapToken: config.bootstrapToken ?? null`
  - `turnstileSiteKey: config.turnstile?.siteKey ?? null`
- deps:
  - `turnstileVerifier`: when `config.turnstile` is set,
    `createSiteverifyTurnstileVerifier({ secret, expectedHostname })`;
    otherwise `null`.
  - `rateLimiter: config.rateLimiter ?? null`.
- Invariant: `turnstileSiteKey !== null` exactly when
  `turnstileVerifier !== null`.

### `apps/api/src/env.ts`

- `Env` gains:
  - `AUTH_RATE_LIMITER?: RateLimitBindingLike`, imported from
    `@flying-mail/adapter/rate-limit/workers-binding`
  - `FLYING_MAIL_BOOTSTRAP_TOKEN?`
  - `FLYING_MAIL_TURNSTILE_SECRET_KEY?`
  - `FLYING_MAIL_TURNSTILE_SITE_KEY?`
  - `FLYING_MAIL_INVITE_TTL_SECONDS?`
- Add the four strings to `envToRecord`.

### `apps/api/src/worker.ts`

- `buildWorkerConfig` adds:
  - `inviteTtlSeconds`
  - `bootstrapToken`, only when defined
  - `turnstile` from `resolveTurnstileConfig(record, publicOrigin)`
  - `rateLimiter: createWorkersRateLimiter(env.AUTH_RATE_LIMITER)`, only
    when the binding is present
- `createApp` gets
  `resolveClientIp: (c) => c.req.header("cf-connecting-ip") ?? null`.
- Read **no** other header.

### `apps/api/src/server.ts`

- `createLocalApp` passes
  `rateLimiter: createInMemoryRateLimiter({ ...AUTH_RATE_LIMIT, clock: <system clock used by buildDependencies> })`
  into the config. Use the clock already exposed by `deps` or a
  `Date`-based clock. Do not add a dependency.
- Client IP from the socket only:
  - Bun:
    `Bun.serve({ port, fetch: (req, server) => app.fetch(req, { clientIp: server.requestIP(req)?.address ?? null }) })`.
  - Node: `@hono/node-server` exposes `c.env.incoming.socket.remoteAddress`.
  - `resolveClientIp` reads the value that the runtime-specific fetch
    wrapper placed in `c.env`. Keep it a small typed helper in `server.ts`.
- Never read `x-forwarded-for`, `x-real-ip` or `cf-connecting-ip` here.
- `createLocalApp` must also work in tests where no server exists. There
  the resolver returns `null`.

### `apps/api/wrangler.toml`

Edit in place. Keep every existing binding and var except
`FLYING_MAIL_SIGNUP`. Design section 7.1 lists only the deltas.

- Top level:
  - `workers_dev = false`
  - `preview_urls = false`
  - `routes = [{ pattern = "mail.tacoserve.online", custom_domain = true }]`
  - each with a comment explaining zone-level protection
- Add a `[[ratelimits]]` block: `name = "AUTH_RATE_LIMITER"`,
  `namespace_id = "1001"`, `simple = { limit = 10, period = 60 }`.
- `[vars]`:
  - `FLYING_MAIL_PUBLIC_ORIGIN = "https://mail.tacoserve.online"`
  - `FLYING_MAIL_TURNSTILE_SITE_KEY = ""`, with a comment: public site key;
    fill in before putting the secret; the build fails if the secret is set
    while this is empty
  - a commented `# FLYING_MAIL_INVITE_TTL_SECONDS = "604800"`
- Delete the `FLYING_MAIL_SIGNUP` var and its comment.
- Add secret comments next to the existing `FLYING_MAIL_CREDENTIAL_KEY`
  comment:
  - `kinko exec -- bunx wrangler secret put FLYING_MAIL_BOOTSTRAP_TOKEN`
    (delete it after bootstrap)
  - `kinko exec -- bunx wrangler secret put FLYING_MAIL_TURNSTILE_SECRET_KEY`
- Keep `database_id`, `[[send_email]]`, `[assets]` and `FLYING_MAIL_MAIL_FROM`
  unchanged.

## Pitfalls

- Fail-fast errors must be thrown from config resolution, so that
  `worker.ts`'s existing build-failure path returns the masked 500. They
  must never echo secret values.
- A site key without a secret must **not** throw. It is silently disabled.
- Do not default `rateLimiter` to in-memory inside `build-dependencies.ts`,
  because tests rely on `null`. Only `server.ts` injects it.
- `server.test.ts` uses `usecases.bootstrapAdmin` (about line 123):
  - set `process.env["FLYING_MAIL_BOOTSTRAP_TOKEN"]` to a 32+ character
    test value in its setup
  - call `bootstrapAdmin({ email, name, token, clientIp: null })`
  - restore the environment afterwards, as the file already does
- The in-memory limiter on the local server allows 10 auth calls per minute
  per address. Server tests must not exceed that within one test.

## Tests (`input -> expected`)

- `config.test.ts`:
  - invite TTL: unset -> 604800; `"86400"` -> 86400; `"2592000"` ->
    2592000; `"3600"` -> 604800; `"abc"` -> 604800; `"90000.5"` -> 604800
  - bootstrap token: unset or blank -> undefined; 31 chars -> throws
    `BootstrapTokenConfigurationError`, and the message does not contain the
    value; 32 chars -> returned trimmed
  - Turnstile: no secret -> undefined; site key only -> undefined; secret
    without site key -> throws; secret without origin -> throws; all set ->
    `expectedHostname = "mail.tacoserve.online"` for origin
    `https://mail.tacoserve.online`
  - `buildDependencies` with `turnstile` -> verifier non-null and site key
    set; without it -> both null; `rateLimiter` passes through
- `worker.test.ts`:
  - `envToRecord` maps the four new vars
  - `buildWorkerConfig` with an `AUTH_RATE_LIMITER` stub -> config has a
    rateLimiter; without it -> undefined
  - a request with `CF-Connecting-IP: 203.0.113.7` and
    `X-Forwarded-For: 198.51.100.1` -> the limiter stub receives a key
    ending in `203.0.113.7`. Drive `requestEmailAuth` through the Worker
    fetch with a denying stub binding and assert RATE_LIMITED at HTTP 200.
- `server.test.ts`:
  - bootstrap with the env token succeeds once
  - the local app's GraphQL `requestEmailAuth` with `X-Forwarded-For` set
    is keyed by `unknown` (no socket in tests), not by the header value:
    11 calls with different XFF values -> the 11th is RATE_LIMITED

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- If a file drifted, reapply only this plan's intent. Never revert others'
  edits.
- Do not edit `graphql/*` or `http/*`. Plan 07 owns them and has already
  completed. If a test here fails because of code in those directories,
  record the failure, its log path and "owner: auth-hardening-07" in the
  progress log, and stop. Do not patch it and do not weaken the test.

## Verification (from the repository root)

1. `bunx vitest run packages/infrastructure/src/composition apps/api` must
   exit 0.
2. `bun run --cwd packages/infrastructure typecheck` and
   `bun run --cwd apps/api typecheck` must each exit 0. Every dependency has
   completed, so any error is real. Fix it if it is in this plan's
   writePaths; otherwise route it to the owning plan as described in the
   drift protocol.
3. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`
   must exit 0, with output showing the `AUTH_RATE_LIMITER` binding.
   Run `mise run build-web` first if the assets directory is missing.
4. `rg -n -i signup packages apps` must print nothing.
5. `biome check packages/infrastructure/src/composition apps/api/src --diagnostic-level=warn`
   must exit 0.

## Done criteria

- [ ] All resolvers and `Env` fields exist as specified, and wrangler.toml
      contains every key in design section 7.1.
- [ ] The dry run succeeds, and the full output is saved to
      `/tmp/flying-mail-dryrun.log` with its exit code recorded.
- [ ] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
