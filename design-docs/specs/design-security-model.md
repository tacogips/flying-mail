# Security Model: Authentication, Onboarding and Edge Protection

Status: Accepted for implementation (2026-10-07).
Scope: bootstrap of the first admin, invite-only onboarding, Cloudflare
Turnstile on the login-link request, per-IP rate limiting of the
unauthenticated auth mutations, and the custom-domain deployment that puts
the Worker behind zone-level protection.

Related documents: `design-api-keys-and-permissions.md` (credentials and
scopes), `design-graphql-api.md` (operation catalogue and error codes),
`design-deployment.md` (bindings, variables, bring-up order),
`design-web-client.md` (login and settings pages), `command.md`
(`admin bootstrap`). Open user decisions are in
`design-docs/user-qa/pending-auth-hardening.md`.

---

## 1. Threat model

### 1.1 Assets

| Asset | Why it matters |
|-------|----------------|
| The first `ADMIN` user and the bootstrap API key | Full control over every domain, mailbox and key |
| Sessions (cookie) and API keys | Read and send mail as the holder |
| Email-auth challenge tokens (login and invitation links) | Each one is a sign-in credential until consumed or expired |
| Provider send quota and sender reputation | Every login or invitation mail costs quota; abuse harms deliverability |
| The set of registered addresses | Disclosing it is user enumeration |

### 1.2 Unauthenticated entry points (before this change)

| Entry point | Weakness | Fixed by |
|-------------|----------|----------|
| `bootstrapAdmin` | Whoever calls it first on an empty instance becomes admin. The window opens at every fresh deploy or database wipe. | Section 3: bootstrap token |
| `FLYING_MAIL_SIGNUP` / `SignupMode` | A configuration knob for self-registration. It is read into `InstanceConfig` but no code path consumes it. It is a latent footgun with no implemented behaviour. | Section 4: removal, invite-only onboarding |
| `requestEmailAuth` | No bot protection. Scripts can drive mail sends, limited only by the 3-per-15-minutes per-address throttle. | Section 5: Turnstile; Section 6: per-IP limit |
| `requestEmailAuth`, `verifyEmailAuthToken`, `bootstrapAdmin` | No per-client rate limit | Section 6 |
| `*.workers.dev` hostname | Bypasses zone-level WAF, DDoS rules and any zone security settings | Section 7: custom domain, `workers_dev = false`, `preview_urls = false` |

### 1.3 Controls that stay unchanged

- Passwordless only. There are no passwords anywhere.
- `requestEmailAuth` always answers `true` for any syntactically valid
  address, whether or not a user exists, is deactivated, or is throttled.
- The per-address login throttle stays at 3 `LOGIN` challenges per address
  per 15 minutes, failing silently.
- Tokens, session tokens and API key secrets are stored only as SHA-256
  hashes (`TokenHasher`).
- The cross-origin check in `http/auth-middleware.ts` compares against
  `FLYING_MAIL_PUBLIC_ORIGIN` (Section 7.3).
- User administration stays out of the API-key scope system. It is
  available only to an `ADMIN` *user* viewer (session), never to an API key,
  including the bootstrap key.

### 1.4 Uniform-response rule (applies to every section)

Any check that runs **before** the user lookup must have an outcome that is
independent of the submitted email: rate limit, Turnstile and configuration.
Any outcome that depends on the user (unknown, deactivated, throttled) must
stay `true`. Each error below that `requestEmailAuth` can return is a
function of the client (IP, Turnstile token) or the server configuration only.

---

## 2. Shared building blocks

### 2.1 Client IP

`GraphQLContext` gains `clientIp: string | null`. `createApp` gains an
optional `resolveClientIp(c: Context) => string | null`. When it is absent,
`clientIp` is `null`.

| Runtime | Source | Never trusted |
|---------|--------|---------------|
| Worker (`apps/api/src/worker.ts`) | The `CF-Connecting-IP` request header. Cloudflare's edge always sets it and overwrites any client-supplied value. | `X-Forwarded-For`, `X-Real-IP` |
| Bun server (`apps/api/src/server.ts`) | The socket peer address: `server.requestIP(req)` under `Bun.serve`, or the `@hono/node-server` incoming socket `remoteAddress` under Node | `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`. Any client can set these on a server that is not behind Cloudflare. |
| Tests | Supplied explicitly through `buildGraphQLContext` | - |

A `null` IP maps to the literal key segment `unknown`. All such callers share
one bucket. That is acceptable because it only happens outside the Worker.

### 2.2 New error code `RATE_LIMITED`

- `ApplicationErrorCode` gains `"RATE_LIMITED"`, with a new
  `RateLimitedError` class in `packages/application/src/errors.ts`.
  `toGraphQLError` maps it 1:1 through the existing `ApplicationError`
  branch.
- **Transport decision: a GraphQL error at HTTP 200** with
  `extensions.code = "RATE_LIMITED"` and the fixed message
  `"Too many requests; try again later"`. There is no `Retry-After`, because
  the Workers binding does not expose the reset time. Reasons for this
  choice: every other failure on `/graphql` is a GraphQL error at 200, so
  the web client and the CLI already route on `extensions.code`. A 429
  would need special handling in the HTTP layer for a single resolver
  failure, and a multi-field document has no single status to report.
- The `RATE_LIMITED` string that is already used as a `deliveryError` reason
  for provider send limits (`design-webmail-completion.md`) is a separate
  field. The two values do not interact.

### 2.3 Constant-time comparison

`packages/application/src/usecases/` gains a helper `constantTimeEqual(a, b)`
over two strings of equal length (XOR-accumulate over every char code, no
early return). Callers only ever pass two SHA-256 hex digests, so the lengths
are always equal. A length mismatch returns `false` without looping, and that
leaks nothing, because the digest length is public.

---

## 3. Bootstrap admin gated by a deploy-time token

### 3.1 Configuration

| Name | Kind | Rule |
|------|------|------|
| `FLYING_MAIL_BOOTSTRAP_TOKEN` | Worker secret (`wrangler secret put`); local env | Trimmed. Unset or empty means bootstrap is **disabled**. If it is set but shorter than 32 characters, composition throws `BootstrapTokenConfigurationError`, which is fail-fast like `PublicOriginConfigurationError`. The message never echoes the value. |

`InstanceConfig` gains `bootstrapToken: string | null`. This is the raw
secret, in memory only, and the same trust level as the credential key
already held by the composition root. It is never logged or serialized.

### 3.2 GraphQL

```graphql
bootstrapAdmin(email: String!, name: String!, token: String!): BootstrapPayload!
```

The token is a **mutation argument**, not a header. An argument is typed and
validated by the schema. It needs no change to the auth middleware, which
already interprets `Authorization` as an API key or session. It also keeps
the call a single self-describing operation. Callers must pass the token as a
GraphQL **variable**, not inline in the document. The CLI does this.
Leaving the argument out is rejected by GraphQL validation before the
resolver runs. An empty string reaches the use case and is treated as a
wrong token (`FORBIDDEN`), or as `SERVICE_UNAVAILABLE` when bootstrap is
disabled.

### 3.3 Use case order (`createBootstrapAdminUseCase`)

The input becomes `{ email, name, token, clientIp }`.

1. Rate limit `bootstrapAdmin` for `clientIp` (Section 6). Over the limit
   gives `RATE_LIMITED`.
2. `instanceConfig.bootstrapToken === null` gives `SERVICE_UNAVAILABLE`,
   "Bootstrap is disabled on this server".
3. `constantTimeEqual(hash(token), hash(bootstrapToken))` is false gives
   `FORBIDDEN`, "Invalid bootstrap token". This runs **before** the emptiness
   check, so a caller without the token cannot learn whether the instance has
   already been bootstrapped.
4. `userRepository.createFirstUser(user)`, the existing atomic
   insert-if-empty. It returns `false` when the instance already has users,
   which gives `CONFLICT` (unchanged message).
5. The bootstrap user is created with `invitationAcceptedAt = createdAt`
   (Section 4.2). No invitation is sent.
6. The full-capability API key is created exactly as today. The secret is
   returned once.

### 3.4 One-time guarantee

The guarantee is that bootstrap succeeds only while the `users` table is
empty. No code path deletes users: `setUserActive(false)` deactivates and
keeps the row. So once bootstrap has succeeded, step 4 fails permanently,
even if the secret is left in place, the token is replayed, or the instance
is redeployed. The only way to reopen bootstrap is to wipe the D1 database,
and that is the intended re-provisioning path. No separate "bootstrap
consumed" marker is stored: a wipe would erase it too, so it would add
nothing. **Invariant for future work:** any change that adds user deletion
must add a persisted bootstrap marker in the same change. A test pins this
behaviour: a second bootstrap with the correct token returns `CONFLICT`.

Operators are still told to delete the secret after bootstrap
(`wrangler secret delete FLYING_MAIL_BOOTSTRAP_TOKEN`). That is hygiene, not
a correctness requirement.

### 3.5 Operator tooling

- **CLI subcommand** `flying-mail admin bootstrap --email <e> --name <n>
  [--secret-file <path>]` (`apps/cli/src/commands/admin-bootstrap.ts`).
  - The token is read **only** from the environment variable
    `FLYING_MAIL_BOOTSTRAP_TOKEN`, so it never appears in argv, the process
    list or shell history. If it is missing, the command fails with a usage
    error (exit 2) before any network call.
  - The endpoint is resolved the same way as every CLI command:
    `--endpoint`, then `FLYING_MAIL_ENDPOINT`, then the config file. No API
    key is sent.
  - Before calling the endpoint, the command verifies that `--secret-file`
    does not exist and that its parent directory can be created. A
    successful bootstrap cannot be repeated, so the command must not burn it
    with nowhere to store the key.
  - On success it writes the full API key secret to `--secret-file`. The
    file is created exclusively with mode `0600`, and the default is
    `.private/bootstrap-admin-api-key` under the current directory. It then
    prints only: user id, email, name, role, API key `keyPrefix`, and the
    secret file path. `--json` prints the same fields. The secret is never
    printed.
  - Exit codes follow `command.md`: `FORBIDDEN` exits 4. `CONFLICT`,
    `SERVICE_UNAVAILABLE` and `RATE_LIMITED` exit 1 with the server message.
- **mise task** `bootstrap-admin` (`usage: arg "<email>" arg "<name>"`)
  delegates to the CLI subcommand. It passes
  `--secret-file "{{config_root}}/.private/bootstrap-admin-api-key"`, which
  is a gitignored path (`.private*/`). It is run as
  `kinko exec -- mise run bootstrap-admin you@example.com "You"`, with
  `FLYING_MAIL_BOOTSTRAP_TOKEN` and `FLYING_MAIL_ENDPOINT` coming from
  kinko or the environment.

---

## 4. Invite-only onboarding

### 4.1 Removal of self-signup

The following are removed together, in one change:

- `SignupMode`, and `InstanceConfig.signupMode`
  (`packages/application/src/dependencies.ts`)
- `BuildDependenciesConfig.signupMode`, `resolveSignupMode`, and its use in
  `loadConfigFromEnv`
  (`packages/infrastructure/src/composition/config.ts`, `build-dependencies.ts`)
- `Env.FLYING_MAIL_SIGNUP` and its `envToRecord` entry (`apps/api/src/env.ts`),
  and the `resolveSignupMode` call in `apps/api/src/worker.ts`
- The `FLYING_MAIL_SIGNUP` var and its comment in `apps/api/wrangler.toml`
- `signupMode` in `packages/application/src/test-support/fakes.ts`, and the
  signup tests in `config.test.ts` and `worker.test.ts`
- The env table row in `design-deployment.md`

No self-registration code path exists today, so nothing else changes. After
the change, `rg -i signup packages apps README.md mise.toml .agents` must
match nothing. `design-docs/` and `impl-plans/` are excluded, because they
record the removal and its history. A leftover `FLYING_MAIL_SIGNUP` in an operator's
environment is ignored, because unknown variables are never read.

Users come into existence in exactly two ways: `bootstrapAdmin` (once) and
`createUser` (an admin user's session).

### 4.2 Data model (migration `0015_auth_hardening.sql`)

```sql
ALTER TABLE email_auth_challenges
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'LOGIN'
  CHECK (purpose IN ('LOGIN','INVITATION'));
ALTER TABLE users ADD COLUMN invitation_accepted_at TEXT;
UPDATE users SET invitation_accepted_at = created_at
  WHERE invitation_accepted_at IS NULL;
CREATE INDEX idx_email_auth_challenges_email_purpose_created
  ON email_auth_challenges(email, purpose, created_at);
```

- The migration is additive only and applies cleanly on top of 0001-0014.
  Migrations 0001-0014 are not edited.
- The backfill marks every pre-existing user `ACCEPTED`: they predate
  invitations and have been able to sign in all along. On the fresh database
  that the orchestrator deploys, it touches no rows.
- Domain changes:
  - `EmailAuthChallenge.purpose: EmailAuthChallengePurpose`, an enum with
    `Login = "LOGIN"` and `Invitation = "INVITATION"`, required in
    `CreateEmailAuthChallengeInput`.
  - `User.invitationAcceptedAt: string | null`.
    `CreateUserInput.invitationAcceptedAt` is optional and defaults to
    `null`.
  - A new `markInvitationAccepted(user, at)`. It is idempotent: it returns
    the user unchanged when the user has already accepted.
  - A new `invitationStatus(user): "PENDING" | "ACCEPTED"`.
- Repository changes (application ports and both the D1 and libsql
  adapters, which share SQL):
  - `UserRepository.save` and the row mapping persist
    `invitation_accepted_at`.
  - `EmailAuthChallengeRepository.countRecentByEmail(email, since, purpose)`
    gains the `purpose` filter.
  - `EmailAuthChallengeRepository.save` persists `purpose`.
  - A new `EmailAuthChallengeRepository.consume(id, now): Promise<boolean>`
    runs
    `UPDATE email_auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
    and reports whether exactly one row changed. This replaces today's
    read-then-`save` consumption, where two concurrent verifications of one
    token could both succeed. Single use is a stated requirement for
    invitation links.

### 4.3 Configuration

| Name | Kind | Rule |
|------|------|------|
| `FLYING_MAIL_INVITE_TTL_SECONDS` | var / env | Integer in the range `[86400, 2592000]` (1 day to 30 days). Unset, non-integer or out of range falls back to the default `604800` (7 days). This is the same lenient policy as `FLYING_MAIL_FILE_LINK_MAX_TTL`. The 1-day floor is deliberate: invitation rows then always outlive the 24-hour resend-throttle window (Section 4.4), so the existing expiry sweep cannot erase rows the throttle still counts. |

`InstanceConfig` gains `inviteTtlSeconds: number`.

### 4.4 Invitation issuance (new `packages/application/src/usecases/invitations.ts`)

The internal helper `issueInvitation(deps, mail, user)` does the following:

1. Generates a 32-byte token and stores an `INVITATION` challenge for
   `user.email`, with `expiresAt = now + inviteTtlSeconds`.
2. Sends mail from `instanceConfig.mailFrom` to `user.email`:
   - Subject: `You have been invited to flying-mail`
   - Text part: a greeting line, then the URL
     `${publicOrigin}/auth/verify?token=<token>` **alone on its own line**,
     then the expiry ("This link expires in 7 days and can be used once.").
   - HTML part: the same sentences, with the URL as both `href` and link
     text: `<a href="URL">URL</a>`.
   - The expiry text is rendered from `inviteTtlSeconds` as whole days when
     the value divides evenly by 86400, otherwise as whole hours.
   - The login mail keeps its current format. Both mails therefore carry a
     plain `https://` URL that can be extracted from either part, which the
     live verification through gmail-gateway relies on.

`createUser` (`usecases/users.ts`, an admin user viewer only):

1. `requireAdminUser`.
2. `requireMailConfigured` runs **before** any write. If `publicOrigin` or
   `mailFrom` is unset, the call fails with `SERVICE_UNAVAILABLE` and no user
   is created.
3. The email is validated and checked for duplicates. A duplicate gives
   `CONFLICT`, as before.
4. The user is saved with `invitationAcceptedAt = null`.
5. `issueInvitation`.
6. The user is returned, and the GraphQL signature does not change. If the
   send fails, the error propagates (a `MailDeliveryError` becomes
   `SERVICE_UNAVAILABLE`) and the user remains `PENDING`. The documented
   recovery is `resendInvitation`. The web client reloads the user list
   after any `createUser` error, so the pending row and its resend action
   appear.

`resendInvitation(userId)` (new, an admin user viewer only):

1. `requireAdminUser`, then `requireMailConfigured`.
2. Unknown user gives `NOT_FOUND`. A deactivated user gives `CONFLICT`
   ("User is deactivated"). An accepted user gives `CONFLICT` ("Invitation
   already accepted").
3. Throttle: at most **3 `INVITATION` challenges per address per rolling 24
   hours**, counting the one sent by `createUser`. A fourth gives
   `RATE_LIMITED` ("An invitation was sent to this user too many times
   recently; try again later"). This is an admin-only, per-user error. It
   discloses nothing an admin cannot already see, so it does not need to be
   uniform. The count uses `countRecentByEmail(email, now - 24h,
   INVITATION)`. Invitation rows live for at least 1 day (the TTL floor) and
   the existing sweep deletes only expired rows, so every row inside the
   window is still present. The sweep needs no change.
4. `issueInvitation`. Earlier invitation links stay valid until they expire.
   All of them go to the same mailbox, and Section 4.5 kills them once any
   sign-in succeeds.

### 4.5 Acceptance and login interplay

`verifyEmailAuthToken` (updated) runs these steps in order:

1. Per-IP rate limit (Section 6).
2. An empty token is invalid.
3. The token is hashed and the challenge is looked up. If none is found, the
   token is invalid.
4. `consume(id, now)` is called. `false` (already consumed, expired, or a
   lost race) means invalid.
5. The user is loaded by `challenge.email`. If the user is missing or
   inactive, the token is invalid.
6. If `challenge.purpose === INVITATION` and the user has already accepted,
   the token is invalid. Once someone has signed in, leftover invitation
   links are dead, so no long-lived invitation token stays usable as a
   7-day login credential.
7. If the user is `PENDING`, `markInvitationAccepted(now)` is applied and
   saved. Any successful sign-in, LOGIN or INVITATION, counts as acceptance.
8. A session is issued, unchanged.

Every invalid outcome is the same `UNAUTHENTICATED` "This sign-in link is
not valid", as today.

`requestEmailAuth` keeps issuing **LOGIN** challenges for any active user,
including a `PENDING` invitee whose invitation expired. Proving control of
the mailbox is the same proof either way. The 3-per-15-minutes throttle now
counts only `LOGIN` challenges, so invitations never use up login attempts
and login requests never use up invitation resends.

### 4.6 GraphQL and web

```graphql
enum InvitationStatus { PENDING ACCEPTED }
type User { ... invitationStatus: InvitationStatus! }
resendInvitation(userId: ID!): User!
```

Settings > Users (`apps/web/src/pages/settings/users-page.tsx`):

- The create panel and its submit button are worded **"Invite user"**. The
  success notice reads "Invitation sent to <email>".
- Each user row shows its status: "Invitation pending" or "Active". The
  existing deactivated state takes precedence when it applies.
- `PENDING` rows that are active get a **"Resend invitation"** action. While
  the request is in flight the button is disabled. Errors, including
  `RATE_LIMITED`, are shown through the existing `describeErrors`.

Acceptance uses the existing `/auth/verify` page unchanged.

---

## 5. Turnstile on `requestEmailAuth` only

### 5.1 Configuration

| Name | Kind | Rule |
|------|------|------|
| `FLYING_MAIL_TURNSTILE_SECRET_KEY` | Worker secret; local env | Trimmed. Unset or empty means Turnstile is **disabled**. |
| `FLYING_MAIL_TURNSTILE_SITE_KEY` | `[vars]` (public) | Trimmed. It is required when the secret is set. |

Composition rules (`config.ts`, fail-fast, messages never echo values):

- Secret set and site key empty: throw `TurnstileConfigurationError`.
- Secret set and `FLYING_MAIL_PUBLIC_ORIGIN` unset: throw
  `TurnstileConfigurationError`. The expected hostname comes from the public
  origin.
- Site key set without the secret: Turnstile stays disabled, and
  `publicConfig.turnstileSiteKey` is `null`. The site key is never exposed
  unless the server will actually verify tokens.

Fail-fast follows the existing configuration policy
(`PublicOriginConfigurationError`, `MailConfigurationError`). A half
configuration would otherwise either silently disable bot protection or
silently block every login.

### 5.2 Port and adapters

```
packages/application/src/ports/turnstile-verifier.ts
  TurnstileVerifier.verify({ token, remoteIp, action }): Promise<boolean>
```

- `AppDependencies.turnstileVerifier: TurnstileVerifier | null`. `null`
  means disabled. `InstanceConfig.turnstileSiteKey: string | null`. The two
  are non-null together, and composition enforces that.
- Fetch adapter `packages/adapter/src/turnstile/siteverify.ts`, constructed
  with `{ secret, expectedHostname, fetch }`:
  - An empty `token`, or one longer than 2048 characters, returns `false`
    without a network call.
  - It sends `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
    with a form-encoded body of `secret`, `response` and `remoteip`
    (`remoteip` is omitted when `null`), and a 5-second timeout
    (`AbortSignal.timeout`).
  - It returns `true` only if the JSON response has `success === true`,
    `hostname === expectedHostname` (the host of
    `FLYING_MAIL_PUBLIC_ORIGIN`, here `mail.tacoserve.online`) and
    `action === action`.
  - A network error, timeout, non-2xx status or unparsable body returns
    `false` and logs `console.error`. Failures are **fail closed**.
- Fake `packages/application/src/test-support/fake-turnstile-verifier.ts`
  is scripted per token and records every call. It is used by the
  application, GraphQL and Worker tests.

### 5.3 Use case and GraphQL

```graphql
requestEmailAuth(email: String!, turnstileToken: String): Boolean!
publicConfig: PublicConfig!          # unauthenticated
type PublicConfig { turnstileSiteKey: String }
```

`requestEmailAuth` takes `{ email, turnstileToken, clientIp }` and runs these
steps in order:

1. Per-IP rate limit.
2. If Turnstile is enabled, a missing, empty or rejected token gives
   `FORBIDDEN` with the fixed message "Verification failed. Please retry."
   The call uses `remoteIp = clientIp` and `action = "login"`.
3. The existing flow runs unchanged: mail configured, address parsed, user
   lookup, LOGIN throttle, challenge, send, `true`.

Steps 1 and 2 never look at the email, so the uniform-response rule holds.
When Turnstile is disabled, `turnstileToken` is ignored.

`verifyEmailAuthToken`, `bootstrapAdmin`, `/auth/verify` and every
authenticated operation do not use Turnstile.

### 5.4 Web login page

- `apps/web/src/lib/turnstile.ts` contains a minimal typed wrapper around
  `window.turnstile`: `render`, `reset` and `remove`. No package is added.
  The script `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
  is injected once, as a single cached promise.
- `login-page.tsx`:
  1. On mount it fetches `publicConfig` through `publicGraphqlRequest`
     (no credentials).
  2. If that fetch fails, it shows "Could not load sign-in settings. Reload
     the page." and the submit button stays disabled. This fails closed.
  3. If `turnstileSiteKey` is `null`, the form behaves exactly as today.
  4. Otherwise it renders the widget with explicit render, passing
     `sitekey`, `action: "login"` and `theme: "auto"`. The app follows
     `prefers-color-scheme` (`styles/tokens.css`), so `auto` matches it.
     `callback` stores the token. `expired-callback` and `error-callback`
     clear it.
  5. Submit stays disabled until a token is held.
  6. The token is sent as `turnstileToken`.
  7. After **every** attempt, whether it succeeded or failed, the page calls
     `turnstile.reset(widgetId)` and clears the token.
  8. On unmount it calls `turnstile.remove`.
  9. If the script fails to load, it shows "Could not load verification.
     Reload the page." and submit stays disabled.

### 5.5 Content Security Policy

Only these two directives change, and they must be identical in both places:
`packages/infrastructure/src/http/security-headers.ts` (`HTML_CSP`) and
`apps/web/public/_headers`.

```
script-src 'self' https://challenges.cloudflare.com
frame-src 'self' blob: https://challenges.cloudflare.com
```

All other directives stay as they are: `default-src 'self'`, no
`connect-src` widening, no `'unsafe-eval'`, and no wildcard. This is the set
that Cloudflare's Turnstile CSP guidance lists. A test asserts that the two
CSP strings are equal, and that each one contains exactly this added origin
and no other `https:` source.

---

## 6. Per-IP rate limiting

### 6.1 Port and adapters

```
packages/application/src/ports/rate-limiter.ts
  RateLimiter.limit(key: string): Promise<boolean>   // true = allowed
```

- `AppDependencies.rateLimiter: RateLimiter | null`. `null` means disabled,
  which is the case for application and GraphQL unit tests unless they
  inject a fake.
- Workers adapter `packages/adapter/src/rate-limit/workers-binding.ts`,
  constructed from a structural `RateLimitBindingLike`
  (`{ limit({ key }): Promise<{ success: boolean }> }`). It returns
  `success`. If the binding throws, it logs `console.error` and **allows**
  the request (fail open). Auth availability must not depend on a counting
  side service. Turnstile and the per-address throttle still apply, and the
  tokens being protected are 256-bit.
- In-memory adapter `packages/adapter/src/rate-limit/in-memory.ts`,
  constructed with `{ limit, periodSeconds, clock }`. It uses a fixed window
  per key and evicts expired windows on access. When the map grows past
  10,000 keys, all expired entries are pruned, which bounds memory on a
  long-running local server.
- A fake in application test-support allows by default, can be set to deny
  specific keys, and records keys.

### 6.2 Policy

| Operation | Key | Limit |
|-----------|-----|-------|
| `requestEmailAuth` | `auth:requestEmailAuth:<ip>` | 10 per 60 s |
| `verifyEmailAuthToken` | `auth:verifyEmailAuthToken:<ip>` | 10 per 60 s |
| `bootstrapAdmin` | `auth:bootstrapAdmin:<ip>` | 10 per 60 s |

- One binding (`AUTH_RATE_LIMITER`, `simple = { limit = 10, period = 60 }`)
  serves all three operations. The operation name in the key gives each
  operation its own budget per IP. The Workers binding only allows a period
  of 10 or 60 seconds. The in-memory adapter for the Bun server uses the
  same 10 per 60 s.
- The check is the first step of each use case, through the shared helper
  `enforceAuthRateLimit(deps, operation, clientIp)`, which throws
  `RateLimitedError`. The key never contains the email, so the outcome
  cannot depend on whether a user exists.
- Workers Rate Limiting counts per Cloudflare location and is eventually
  consistent. It is a coarse abuse brake, not an exact quota. This is
  documented and accepted.
- The per-address LOGIN throttle (3 per 15 minutes, silent) stays as it is,
  as a second layer.

### 6.3 Wiring

| Runtime | `rateLimiter` | `turnstileVerifier` |
|---------|---------------|---------------------|
| Worker | Workers adapter when `env.AUTH_RATE_LIMITER` is present, otherwise `null` | Fetch adapter when the secret is set, otherwise `null` |
| Bun / Node server | In-memory adapter, always on | Fetch adapter when the secret is set, otherwise `null` (normally unset locally) |
| Tests | `null` or the fake | `null` or the fake |

`BuildDependenciesConfig` gains `rateLimiter?: RateLimiter` and
`turnstile?: { secret, siteKey }`. `buildDependencies` builds the adapters,
which keeps entry points free of adapter details, as is already the case for
mail and blobs.

---

## 7. Edge exposure: custom domain only

### 7.1 `apps/api/wrangler.toml`

The block lists only new or changed keys; every existing binding and var
(`[[d1_databases]]`, `[[r2_buckets]]`, `[[send_email]]`, `[assets]`,
`FLYING_MAIL_MAIL_FROM`, `FLYING_MAIL_SPAM_THRESHOLD`,
`FLYING_MAIL_FILE_LINK_MAX_TTL`) is kept; only `FLYING_MAIL_SIGNUP` is
removed.

```toml
workers_dev = false
preview_urls = false
routes = [{ pattern = "mail.tacoserve.online", custom_domain = true }]

[[ratelimits]]
name = "AUTH_RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 10, period = 60 }

[vars]
FLYING_MAIL_PUBLIC_ORIGIN = "https://mail.tacoserve.online"
FLYING_MAIL_TURNSTILE_SITE_KEY = ""   # placeholder; public site key of the
                                      # Turnstile widget for mail.tacoserve.online
# FLYING_MAIL_INVITE_TTL_SECONDS = "604800"
# Secrets (never in this file):
#   kinko exec -- bunx wrangler secret put FLYING_MAIL_BOOTSTRAP_TOKEN
#   kinko exec -- bunx wrangler secret put FLYING_MAIL_TURNSTILE_SECRET_KEY
```

- `preview_urls = false` is included because per-version preview URLs are
  also served on `workers.dev`, which would reopen the bypass that
  `workers_dev = false` closes.
- `namespace_id` is an account-unique integer string, as the Rate Limiting
  binding requires. If it collides with another Worker on the account, the
  orchestrator changes it.
- The empty site-key placeholder keeps Turnstile disabled until the
  orchestrator creates the widget and fills in the key. Because the rule in
  Section 5.1 throws when the secret is set without a site key, the site key
  **must be committed and deployed before the secret is put**.
- A dry run (`bun run --cwd apps/api cf:deploy -- --dry-run --outdir
  /tmp/flying-mail-dryrun`) must succeed with this file.

### 7.2 `apps/api/src/env.ts`

`Env` gains:

- `AUTH_RATE_LIMITER?: RateLimitBindingLike`
- `FLYING_MAIL_BOOTSTRAP_TOKEN?: string`
- `FLYING_MAIL_TURNSTILE_SECRET_KEY?: string`
- `FLYING_MAIL_TURNSTILE_SITE_KEY?: string`
- `FLYING_MAIL_INVITE_TTL_SECONDS?: string`

The four string variables are added to `envToRecord`.
`FLYING_MAIL_SIGNUP` is removed.

### 7.3 Origin consistency

`FLYING_MAIL_PUBLIC_ORIGIN = https://mail.tacoserve.online` is the single
source for:

- login and invitation link URLs
- absolute file-link URLs
- the cross-origin check in `auth-middleware.ts`
- the Turnstile expected hostname

The session cookie is host-only, so it has no domain attribute to update.
No other code may derive the public host.

---

## 8. First-deploy procedure (normative; mirrored in README, `design-deployment.md`, `cloudflare-mail-setup` skill)

The orchestrator performs every live step. The implementation only
documents them.

1. `mise install && bun install`.
2. Create or confirm D1 `mailcal-db` and R2 `mailcal-mail`, and put the
   database id into `wrangler.toml`.
3. Create a Turnstile widget (Managed mode) for hostname
   `mail.tacoserve.online`, and set its **site key** as
   `FLYING_MAIL_TURNSTILE_SITE_KEY` in `wrangler.toml`.
4. `mise run cf-deploy`. This applies remote migrations including 0015,
   deploys, and attaches the `mail.tacoserve.online` custom domain, which
   requires the `tacoserve.online` zone to be on the account. `workers.dev`
   is disabled.
5. Put the secrets. Generate the bootstrap token with
   `openssl rand -base64 48`, and keep it in kinko.
   - `kinko exec -- bunx wrangler secret put FLYING_MAIL_BOOTSTRAP_TOKEN`
   - `kinko exec -- bunx wrangler secret put FLYING_MAIL_TURNSTILE_SECRET_KEY`

   Between steps 4 and 5, Turnstile is off and bootstrap is disabled. The
   database is empty, so no login mail can be sent.
6. Configure Email Routing and Sending as described in the
   `cloudflare-mail-setup` skill. `FLYING_MAIL_MAIL_FROM` must be a verified
   sender.
7. `kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online
   mise run bootstrap-admin me@tacogips.me "Name"`. This prints the admin
   and the key prefix, and the key is stored in
   `.private/bootstrap-admin-api-key`.
8. `kinko exec -- bunx wrangler secret delete FLYING_MAIL_BOOTSTRAP_TOKEN`
   (hygiene; Section 3.4).
9. Sign in at `https://mail.tacoserve.online/login` using Turnstile and the
   login link. Then add domains and mailboxes, and invite users from
   Settings > Users.
10. Issue scoped API keys and revoke the bootstrap key when it is no longer
    needed.

---

## 9. Verification

| Area | Tests (new or updated) |
|------|------------------------|
| Bootstrap | Application `auth.test.ts`: disabled gives `SERVICE_UNAVAILABLE`; wrong or missing token gives `FORBIDDEN`, including on a non-empty instance (no state leak); correct token on an empty instance succeeds; a second call with the correct token gives `CONFLICT`; rate limited gives `RATE_LIMITED` before the token check. Config: a token shorter than 32 characters throws. CLI: missing env exits 2 without a network call; an existing secret file is refused before the call; stdout never contains the secret; the file mode is `0600`. |
| Invitations | `createUser` sends one INVITATION mail whose text and HTML parts both contain `https://<origin>/auth/verify?token=`; with mail unconfigured, `SERVICE_UNAVAILABLE` and no user is created; a resend for accepted, deactivated or unknown users is rejected; the fourth invitation in 24 hours gives `RATE_LIMITED`; a non-admin or an API key gives `FORBIDDEN`; the invitation TTL bounds and default hold; an INVITATION challenge does not count toward the LOGIN throttle and vice versa; an invitation link after acceptance is invalid; concurrent double-consume yields exactly one session (repository test for `consume`); migration 0015 applies on top of 0001-0014 (runner test). |
| Signup removal | Config, worker and fakes have no `signupMode`; the search check in Section 4.1. |
| Turnstile | Adapter: success, hostname mismatch, action mismatch, `success: false`, network error, timeout, oversize token, `remoteip` omitted when `null`. Use case: missing or invalid token gives `FORBIDDEN` with an identical response for known and unknown emails; disabled ignores the token. Config: secret without site key throws; secret without origin throws; site key alone keeps `publicConfig.turnstileSiteKey` `null`. Web: widget rendered only when the site key is non-null; submit disabled until a token is held; reset after success and after failure; `publicConfig` failure keeps submit disabled. |
| CSP | `security-headers.ts` and `_headers` CSP are equal; the only external origin is `https://challenges.cloudflare.com`, in exactly `script-src` and `frame-src`. |
| Rate limit | In-memory window semantics (allow 10, deny the 11th, reset after the period); Workers adapter passes the key through and fails open on a throw; the use cases deny with `RATE_LIMITED` whether or not the user exists; GraphQL error at HTTP 200 with `extensions.code`. Worker: `CF-Connecting-IP` is used and `X-Forwarded-For` is ignored. Server: the socket address is used and both headers are ignored. |
| Deployment | `worker.test.ts` env mapping includes the new vars and the binding; the dry-run deploy succeeds. |

Repository gates:

- `mise run lint && bun run test && mise run build-web` pass, with at
  least the baseline 1720 package tests and 264 web tests, plus the new ones.
- `bun run --cwd apps/api cf:deploy -- --dry-run --outdir
  /tmp/flying-mail-dryrun` succeeds.
- No touched file reaches 1000 lines. `schema.graphql.ts` (857) and
  `resolvers/mutation.ts` (774) are the closest. New auth resolvers go in
  `resolvers/auth.ts` if `mutation.ts` would pass about 900 lines.

---

## 9a. WebSocket subscriptions (2026-10-08)

The subscription endpoint adds a long-lived, upgrade-based entry point.
Its controls are specified in `design-realtime-push.md` section 7. In
summary:

- **Origin.** The upgrade is rejected when `isCrossOriginRequest` is true
  (CSWSH). The session cookie is honoured only when a matching `Origin`
  header is present.
- **API keys.** Accepted only in the `connection_init` payload; never in the
  URL.
- **Credential storage.** Sockets store only token hashes, and credentials
  resolve through the existing viewer resolution.
- **Rate limits.** Connection attempts and inits are limited through the
  existing `RateLimiter` with `ws:` key prefixes. Concurrency, subscription
  count, frame size, init timeout and idle timeout are capped.
- **Authorization.** MAIL_READ is re-checked for every event against a
  principal re-resolved on each delivery pass.
- **CSP.** Gains exactly `connect-src 'self'` in both
  `security-headers.ts` and `_headers`. The section 5.5 rule of no other
  `connect-src` widening still holds.

## 10. Out of scope

- WAF or zone rules, Turnstile widget creation, DNS, secrets and deploys.
  The orchestrator does all of these.
- Turnstile on any operation other than `requestEmailAuth`.
- Revoking earlier invitation links on resend (Section 4.5 makes them
  harmless once anyone signs in).
- Making `bootstrapAdmin`'s user, key and scope writes one D1 batch.
  Today's sequence can leave an admin without a key if a later write
  fails. The admin can still sign in by email, so this is recorded as a
  residual risk and not redesigned here.
