# Auth Hardening 01: Contracts and Persistence

**Status**: Ready
**Plan ID**: auth-hardening-01-contracts-and-persistence
**Wave**: 1 (phase 17)
**Depends On**: none
**Design Reference**: design-docs/specs/design-security-model.md sections 2.1, 2.2, 4.1, 4.2, 5.2 (port only), 6.1 (port only)
**Created**: 2026-10-07

## Intent and context

flying-mail is being hardened in four areas: a token-gated `bootstrapAdmin`,
invite-only onboarding, Turnstile on `requestEmailAuth`, and per-IP rate
limiting. This plan is the **first-wave contract**. It pins every shared
type, port, error code, data column and context field that later plans
build on. It also makes the minimum call-site edits needed to keep the whole
repository type-checking and the existing test suite green **with unchanged
behaviour**, apart from removing `SignupMode`.

Later plans own the behaviour:

- auth-hardening-05 owns the use cases.
- auth-hardening-06 owns the adapters.
- auth-hardening-07 owns GraphQL.
- auth-hardening-08 owns composition and the Worker.

This plan must not implement any of that behaviour.

## Non-goals

- No rate-limit, Turnstile, bootstrap-token or invitation **behaviour**. That
  belongs to plan 05.
- No GraphQL SDL or resolver changes. No web, CLI or docs changes.
- No new adapters: no siteverify adapter, no limiter adapters.
- Do not edit migrations 0001-0014.
- Do not touch `apps/api/wrangler.toml`. Plan 08 rewrites it.

## writePaths (exclusive in wave 1)

- packages/domain/src/entities/email-auth-challenge.ts
- packages/domain/src/entities/user.ts
- packages/domain/src/entities/user.test.ts
- packages/domain/src/entities/email-auth-challenge.test.ts (create it if it does not exist)
- packages/application/src/errors.ts
- packages/application/src/dependencies.ts
- packages/application/src/ports/auth-repository.ts
- packages/application/src/ports/rate-limiter.ts (new)
- packages/application/src/ports/turnstile-verifier.ts (new)
- packages/application/src/test-support/fakes.ts
- packages/application/src/test-support/repository-fakes.ts
- packages/application/src/test-support/auth-hardening-fakes.ts (new)
- packages/application/src/usecases/email-auth.ts (mechanical edits only, see below)
- packages/adapter/src/repositories/auth-repository.ts
- packages/adapter/src/repositories/auth-repository.test.ts (new)
- packages/adapter/src/repositories/repositories.test.ts. Call-site update
  only: the `createEmailAuthChallenge` call at about line 549 gains
  `purpose: EmailAuthChallengePurpose.Login`, and any `countRecentByEmail`
  call gains the purpose argument.
- packages/adapter/src/migrations/runner.test.ts
- apps/api/migrations/0015_auth_hardening.sql (new)
- packages/infrastructure/src/composition/config.ts
- packages/infrastructure/src/composition/config.test.ts
- packages/infrastructure/src/composition/build-dependencies.ts
- packages/infrastructure/src/graphql/context.ts
- packages/infrastructure/src/http/app.ts
- apps/api/src/env.ts
- apps/api/src/worker.ts
- apps/api/src/worker.test.ts
- impl-plans/active/auth-hardening-01-contracts-and-persistence.md (progress log only)

sharedPaths: none.

## File-level changes

### Domain

- `email-auth-challenge.ts`
  - Add an `export enum EmailAuthChallengePurpose { Login = "LOGIN", Invitation = "INVITATION" }`.
  - Add `readonly purpose: EmailAuthChallengePurpose` to both
    `EmailAuthChallenge` and `CreateEmailAuthChallengeInput`, and make it
    required.
  - `createEmailAuthChallenge` copies the purpose through. Keep
    `consumeEmailAuthChallenge` and `isChallengeUsable` unchanged.
- `user.ts`
  - Add `readonly invitationAcceptedAt: string | null` to `User`.
  - Add `readonly invitationAcceptedAt?: string | null` to `CreateUserInput`.
    `createUser` defaults it to `null`.
  - Add `markInvitationAccepted(user: User, at: string): User`. It returns
    the **same object** when the field is already non-null, and otherwise
    sets the field and `updatedAt`.
  - Add `invitationStatus(user: User): "PENDING" | "ACCEPTED"`.
  - Imitate the immutable-update style of `user.ts:deactivateUser`.

### Application contracts

- `errors.ts`: add `"RATE_LIMITED"` to `ApplicationErrorCode`, and add
  `export class RateLimitedError extends ApplicationError { readonly code = "RATE_LIMITED" }`.
  Imitate `ServiceUnavailableError`. No change is needed in
  `infrastructure/src/graphql/errors.ts`: its generic `ApplicationError`
  branch maps the code 1:1.
- `ports/rate-limiter.ts` must export exactly:
  `export interface RateLimiter { limit(key: string): Promise<boolean> }`.
  `true` means allowed. Add a doc comment stating the meaning of the return
  value.
- `ports/turnstile-verifier.ts` must export exactly:
  `export interface TurnstileVerifyInput { readonly token: string; readonly remoteIp: string | null; readonly action: string }`
  and `export interface TurnstileVerifier { verify(input: TurnstileVerifyInput): Promise<boolean> }`.
- `ports/auth-repository.ts`:
  - The signature becomes
    `countRecentByEmail(email: EmailAddress, since: string, purpose: EmailAuthChallengePurpose): Promise<number>`.
  - Add `consume(id: EmailAuthChallengeId, now: string): Promise<boolean>`.
    Document it as an atomic conditional update: `true` only when this call
    moved `consumed_at` from NULL while `expires_at > now`.
- `dependencies.ts`:
  - Delete the `SignupMode` type and `InstanceConfig.signupMode`.
  - Add `inviteTtlSeconds: number`, `bootstrapToken: string | null` and
    `turnstileSiteKey: string | null` to `InstanceConfig`, each with a doc
    comment. `bootstrapToken` holds the raw secret in memory only and is
    never logged.
  - Add `readonly rateLimiter: RateLimiter | null` and
    `readonly turnstileVerifier: TurnstileVerifier | null` to
    `AppDependencies`. `null` means disabled.

### Test support

- `fakes.ts`:
  - `DEFAULT_INSTANCE_CONFIG` drops `signupMode` and adds
    `inviteTtlSeconds: 604800`, `bootstrapToken: null` and
    `turnstileSiteKey: null`.
  - `CreateFakeDependenciesOptions` gains `rateLimiter?: RateLimiter | null`
    and `turnstileVerifier?: TurnstileVerifier | null`, both defaulting to
    `null`. Wire them into `deps`.
- `repository-fakes.ts`, in `fakeEmailAuthChallengeRepository`:
  - `countRecentByEmail` filters on `purpose`.
  - Add `consume` with the same conditional semantics as SQL: compare
    `consumedAt === null && expiresAt > now`, then store the new object.
  - `fakeUserRepository.createFirstUser` and `save` keep
    `invitationAcceptedAt` as given.
- `auth-hardening-fakes.ts` (new):
  - `createFakeRateLimiter(options?: { deny?: ReadonlySet<string> })`
    returns `{ limiter: RateLimiter; keys: string[] }`. It allows unless the
    key is in `deny`, and records every key.
  - `createFakeTurnstileVerifier(options?: { accept?: (input) => boolean })`
    returns `{ verifier: TurnstileVerifier; calls: TurnstileVerifyInput[] }`.
    The default accepts only `token === "turnstile-ok"`.
  - Re-export both from `fakes.ts`, the same way as
    `export * from "./runtime-fakes"`.

### Mechanical use-case edit (behaviour unchanged)

In `usecases/email-auth.ts`:

- `createRequestEmailAuthUseCase` passes `EmailAuthChallengePurpose.Login`
  to `countRecentByEmail` and `createEmailAuthChallenge`.
- `createBootstrapAdminUseCase` passes `invitationAcceptedAt: now` to
  `createUser`.
- Change nothing else. Plan 05 rewrites these functions.

### Persistence

- `apps/api/migrations/0015_auth_hardening.sql` must contain exactly these
  statements, as in design section 4.2:
  - ADD COLUMN `purpose` with `NOT NULL DEFAULT 'LOGIN'` and
    `CHECK (purpose IN ('LOGIN','INVITATION'))`
  - ADD COLUMN `users.invitation_accepted_at TEXT`
  - UPDATE to backfill it from `created_at`
  - CREATE INDEX `idx_email_auth_challenges_email_purpose_created`
  Add a header comment in the style of `0014_address_activity_index.sql`.
- `packages/adapter/src/repositories/auth-repository.ts`:
  - `UserRow` and `rowToUser` gain `invitation_accepted_at`.
  - `UPSERT_USER_SQL` inserts and updates `invitation_accepted_at`.
  - The `createFirstUser` statement inserts the column from the bound value
    instead of a hard-coded NULL. Keep the `WHERE NOT EXISTS` atomicity.
  - `ChallengeRow` and the challenge mapping gain `purpose`, validated via
    `assertEnumValue(EmailAuthChallengePurpose, ...)`.
  - `save` inserts `purpose`. The ON CONFLICT clause still updates only
    `consumed_at`.
  - `countRecentByEmail` adds `AND purpose = ?`.
  - `consume` is a single
    `UPDATE ... SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`
    and returns `result.rowsAffected === 1`. Imitate `deleteExpired`'s use
    of `rowsAffected`.
- `runner.test.ts`: add `"0015_auth_hardening.sql"` to the expected list in
  the "applies the real production migrations cleanly" test (currently
  ending at line 114).

### Composition and runtime (minimum to compile)

- `config.ts`:
  - Delete the `SignupMode` import, `BuildDependenciesConfig.signupMode`,
    `resolveSignupMode`, and `signupMode:` in `loadConfigFromEnv`.
  - Add `export const DEFAULT_INVITE_TTL_SECONDS = 604800`.
  - Add **no** new resolvers. Plan 08 adds them.
- `build-dependencies.ts`:
  - Delete `signupMode`.
  - Add the instanceConfig fields `inviteTtlSeconds: DEFAULT_INVITE_TTL_SECONDS`,
    `bootstrapToken: null` and `turnstileSiteKey: null`.
  - Add `rateLimiter: null` and `turnstileVerifier: null` to deps.
  - Plan 08 replaces these placeholders.
- `config.test.ts`: delete the "signup defaults closed" test and the
  `signupMode` assertions at about lines 192 and 238. Do not add new tests.
- `graphql/context.ts`:
  - Add `readonly clientIp: string | null` to `GraphQLContext`.
  - `buildGraphQLContext` accepts optional `clientIp?: string | null`,
    defaulting to `null`. Imitate the existing `requestOrigin` handling.
- `http/app.ts`:
  - `CreateAppOptions` gains
    `readonly resolveClientIp?: (c: Context) => string | null`.
  - The `/graphql` handler passes `clientIp: options.resolveClientIp?.(c) ?? null`.
- `apps/api/src/env.ts`: remove `FLYING_MAIL_SIGNUP` from `Env` and from
  `envToRecord`.
- `apps/api/src/worker.ts`: remove the `resolveSignupMode` import and use.
- `apps/api/src/worker.test.ts`: delete the `FLYING_MAIL_SIGNUP` record
  assertion (about lines 265-270). Keep everything else.

## Pitfalls

- `purpose` must be **required** in the domain types. Do not make it
  optional "for compatibility": the column default exists only for old rows.
- `consume` must be one SQL statement. Never use a find-then-save pair.
- `markInvitationAccepted` must not overwrite an existing timestamp.
- Do not change `consumeEmailAuthChallenge` or `verifyEmailAuthToken` logic
  here. Plan 05 switches to `consume`.
- `resolveClientIp` is optional and defaults to `null`. Do not read any
  header in `app.ts`.
- After this plan, `rg -i signup packages apps` may still match
  `apps/api/wrangler.toml` (plan 08), and nothing else.

## Tests to add or update

- Domain: update the existing `createEmailAuthChallenge` call in
  `user.test.ts` (about line 113) to pass a purpose. `createEmailAuthChallenge`
  keeps the purpose.
  `markInvitationAccepted` sets the timestamp once and a second call is a
  no-op. `invitationStatus` returns PENDING for null and ACCEPTED otherwise.
  `createUser` defaults `invitationAcceptedAt` to null.
- `auth-repository.test.ts` (new, using the libsql in-memory pattern from
  `packages/adapter/src/repositories/test-support.ts` and
  `repositories.test.ts`):
  - A challenge round-trips with its purpose.
  - `countRecentByEmail` counts only the requested purpose.
  - `consume` on a fresh challenge returns true. A second `consume` returns
    false. `consume` after expiry returns false.
    `Promise.all([consume, consume])` yields exactly one `true`.
  - A user round-trips `invitationAcceptedAt` for both null and a value.
  - `createFirstUser` persists `invitationAcceptedAt`.
- `runner.test.ts`: 0015 applies on top of 0001-0014, and the index
  `idx_email_auth_challenges_email_purpose_created` exists.

## Drift protocol

- Before every edit, re-read the target file. Record its sha256
  (`shasum -a 256 <file>`) in the progress log before and after the edit.
- If the pre-edit hash differs from your last read, re-read the file and
  reapply only this plan's intent. Never revert edits you did not make.
- Edit only the writePaths listed above.
- Do not run repository-wide formatters. Run Biome only on owned paths.

## Verification (run from the repository root; record exit codes)

1. `bunx vitest run packages/domain packages/adapter/src/repositories/auth-repository.test.ts packages/adapter/src/migrations/runner.test.ts packages/application packages/infrastructure apps/api`
   must exit 0. Every existing test passes and the new tests are listed.
2. Each of the following must exit 0:
   - `bun run --cwd packages/domain typecheck`
   - `bun run --cwd packages/application typecheck`
   - `bun run --cwd packages/adapter typecheck`
   - `bun run --cwd packages/infrastructure typecheck`
   - `bun run --cwd apps/api typecheck`

   This plan leaves every server workspace type-correct. `apps/web` and
   `apps/cli` are excluded because plans 02 and 03 run in the same wave;
   plan 09 runs the full `mise run lint`.
3. `biome check packages/domain packages/application packages/adapter/src/repositories packages/infrastructure/src apps/api/src --diagnostic-level=warn`
   must exit 0.
4. `rg -n -i signup packages apps` may match only `apps/api/wrangler.toml`.
5. `wc -l` on every touched file must report fewer than 1000 lines.

## Done criteria

- [ ] Every symbol above exists with the exact names and signatures shown.
- [ ] Migration 0015 exists and the runner test lists it.
- [ ] `SignupMode` and `resolveSignupMode` are gone from all TypeScript.
- [ ] Verification steps 1-5 pass, with output recorded below.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: (record pre/post sha256 per file)
**Verification evidence**: (commands, exit codes, test counts)
