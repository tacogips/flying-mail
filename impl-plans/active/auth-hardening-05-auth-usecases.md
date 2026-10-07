# Auth Hardening 05: Auth and Invitation Use Cases

**Status**: Ready
**Plan ID**: auth-hardening-05-auth-usecases
**Wave**: 2 (phase 18)
**Depends On**: auth-hardening-01-contracts-and-persistence
**Design Reference**: design-docs/specs/design-security-model.md sections 1.4, 2.2, 2.3, 3.3, 3.4, 4.4, 4.5, 5.3, 6.2
**Created**: 2026-10-07

## Intent and context

This plan implements the application-layer behaviour for:

- the bootstrap token gate
- invitations (createUser sends one; resendInvitation is new)
- invitation acceptance and atomic single-use links
- Turnstile verification on `requestEmailAuth`
- per-IP rate limiting of the three unauthenticated auth mutations

The ports, fakes, error class and domain fields already exist (plan 01).
GraphQL (plan 07) calls the use-case signatures pinned below, so they are a
contract and must match exactly.

## Non-goals

- No adapters, no GraphQL, no config parsing, no web or CLI changes.
- Do not revoke earlier invitation links on resend.
- Do not batch the bootstrap writes.
- No Turnstile on `verifyEmailAuthToken` or `bootstrapAdmin`.

## writePaths

- packages/application/src/usecases/email-auth.ts
- packages/application/src/usecases/invitations.ts (new)
- packages/application/src/usecases/auth-guards.ts (new)
- packages/application/src/usecases/users.ts
- packages/application/src/usecases.ts
- packages/application/src/usecases/auth.test.ts
- packages/application/src/usecases/users.test.ts
- packages/application/src/usecases/user-template-permissions.test.ts (only if a signature change breaks it)
- packages/application/src/usecases/auth-guards.test.ts (new)
- packages/application/src/usecases/email-auth-hardening.test.ts (new)
- packages/application/src/usecases/invitations.test.ts (new)
- impl-plans/active/auth-hardening-05-auth-usecases.md (progress log only)

sharedPaths: none.

## Pinned use-case signatures in `usecases.ts` (contract with plan 07)

```ts
requestEmailAuth: (input: { readonly email: string; readonly turnstileToken: string | null; readonly clientIp: string | null }) => Promise<boolean>;
verifyEmailAuthToken: (token: string, clientIp: string | null) => Promise<EmailAuthSession>;
bootstrapAdmin: (input: { readonly email: string; readonly name: string; readonly token: string; readonly clientIp: string | null }) => Promise<BootstrapResult>;
resendInvitation: (viewer: Viewer, userId: UserId) => Promise<UserWithPermissions>;
```

`createUser` keeps its signature. Register `resendInvitation` next to
`createUser` in both the interface and the factory object.

## File-level changes

### `auth-guards.ts` (new)

- `export type AuthOperation = "requestEmailAuth" | "verifyEmailAuthToken" | "bootstrapAdmin"`.
- `export async function enforceAuthRateLimit(deps: AppDependencies, operation: AuthOperation, clientIp: string | null): Promise<void>`
  - It returns immediately when `deps.rateLimiter === null`.
  - The key is `auth:${operation}:${clientIp ?? "unknown"}`.
  - When the limiter returns `false`, it throws
    `new RateLimitedError("Too many requests; try again later")`.
  - The key must never contain the email.
- `export function constantTimeEqual(a: string, b: string): boolean`
  - A length mismatch returns false.
  - Otherwise it XOR-accumulates over every char code with no early exit.

### `invitations.ts` (new)

- An internal `issueInvitation(deps, mail: MailConfiguration, user: User): Promise<void>`:
  - Generates a 32-byte token. Reuse the same `toBase64Url` and
    `random.tokenBytes` approach as `email-auth.ts`. Move `toBase64Url` and
    `requireMailConfigured` into a shared non-exported location, or export
    them from `email-auth.ts`. Do not duplicate the logic.
  - Saves an `INVITATION` challenge with
    `expiresAt = now + instanceConfig.inviteTtlSeconds`.
  - Sends the mail. Subject: `You have been invited to flying-mail`.
  - The text part has the URL `${origin}/auth/verify?token=${encodeURIComponent(token)}`
    **alone on its own line**.
  - The HTML part uses `<a href="URL">URL</a>`.
  - The expiry sentence is `This link expires in N days and can be used once.`
    when the TTL is divisible by 86400, otherwise `N hours`. Use the singular
    "1 day" when N is 1.
- `createResendInvitationUseCase(deps)` runs these steps in order:
  1. `requireAdminUser`. Reuse the one in `users.ts`: export it, or move it
     into this file and import it from `users.ts`.
  2. `requireMailConfigured`.
  3. Load the user. A missing user gives `NotFoundError("User", id)`.
  4. An inactive user gives `ConflictError("User is deactivated")`.
  5. An accepted user gives `ConflictError("Invitation already accepted")`.
  6. Throttle: `countRecentByEmail(email, now - 24h, Invitation) >= 3`
     gives `RateLimitedError("An invitation was sent to this user too many times recently; try again later")`.
  7. `issueInvitation`.
  8. Return `{ user, permissions }`, using the same loader as `users.ts`.

### `users.ts`, `createCreateUserUseCase`

The order becomes:

1. `requireAdminUser`.
2. `requireMailConfigured`, **before** any write.
3. Email parse and duplicate check (unchanged).
4. `createUser` with `invitationAcceptedAt: null`, then save.
5. `issueInvitation`.
6. Return.

A send failure propagates and the user stays saved. Keep
`withAsyncDomainErrorTranslation`.

### `email-auth.ts`

- `createRequestEmailAuthUseCase(deps)` takes the input object and runs these
  steps in order:
  1. `enforceAuthRateLimit("requestEmailAuth")`.
  2. If `deps.turnstileVerifier !== null`, verify
     `{ token: turnstileToken ?? "", remoteIp: clientIp, action: "login" }`.
     A `false` result throws
     `new ForbiddenError("Verification failed. Please retry.")`.
  3. The existing flow, unchanged: LOGIN purpose, 3 per 15 minutes, always
     `true`.
- `createVerifyEmailAuthTokenUseCase(deps)` takes `(token, clientIp)` and
  runs these steps in order:
  1. `enforceAuthRateLimit("verifyEmailAuthToken")`.
  2. An empty token is invalid.
  3. Hash, then `findByTokenHash`. Null is invalid.
  4. `await emailAuthChallengeRepository.consume(challenge.id, nowIso)`.
     False is invalid. This **replaces** the `consumeEmailAuthChallenge`
     plus `save` pair.
  5. Load the user. A missing or inactive user is invalid.
  6. If the purpose is `Invitation` and `user.invitationAcceptedAt !== null`,
     the token is invalid.
  7. If the user is pending, save `markInvitationAccepted(user, nowIso)` and
     use the updated user for the result.
  8. Create the session as today.
  All invalid outcomes go through the existing `invalid()`.
- `createBootstrapAdminUseCase(deps)` takes the input object and runs these
  steps in order:
  1. `enforceAuthRateLimit("bootstrapAdmin")`.
  2. A null `bootstrapToken` gives
     `ServiceUnavailableError("Bootstrap is disabled on this server")`.
  3. Compare
     `constantTimeEqual(await tokenHasher.hash(token), await tokenHasher.hash(bootstrapToken))`.
     False gives `ForbiddenError("Invalid bootstrap token")`.
  4. The existing `createFirstUser`, then a CONFLICT, then the key and scopes,
     all unchanged. Keep `invitationAcceptedAt: now` from plan 01.
- Update the doc comments: bootstrap is token-gated, and one-time use rests
  on the users-never-deleted invariant (design section 3.4).
- Keep `createSweepExpiredAuthUseCase` unchanged.

## Pitfalls

- Order matters for enumeration and state leaks:
  - The rate limit and Turnstile run before any user lookup.
  - The bootstrap token check runs before `createFirstUser`, so a wrong
    token on a non-empty instance gets FORBIDDEN, not CONFLICT.
- Do not hash or compare with `===` on the raw token.
- Do not log the token or the configured secret.
- The LOGIN throttle must still return `true` silently. Only invitations use
  `RateLimitedError` for the per-user throttle.
- `requestEmailAuth` with Turnstile disabled must ignore `turnstileToken`.
- With `plainTokenHasher`, hash lengths differ for different tokens. That is
  expected, and `constantTimeEqual` must return false.
- Keep each file under 1000 lines. `usecases.ts` is 678 lines today.

## Tests (`input -> expected`)

- auth-guards:
  - limiter null -> no call
  - denied key -> `RATE_LIMITED`
  - the key format is exactly `auth:<op>:<ip>`, and `unknown` when the IP
    is null
  - `constantTimeEqual("a","a")` -> true
  - `("a","b")` -> false
  - `("a","ab")` -> false
- email-auth-hardening:
  - Turnstile enabled with a missing token -> FORBIDDEN, with no mail and no
    challenge.
  - An invalid token for a known email and for an unknown email ->
    identical FORBIDDEN error (same code and message).
  - A valid token -> `true`, and the verifier received
    `remoteIp=clientIp` and `action="login"`.
  - Turnstile disabled -> the token is ignored.
  - A rate-limited call -> RATE_LIMITED for both a known and an unknown
    email, and the verifier is not called.
  - Two LOGIN requests plus three INVITATION challenges -> a third LOGIN is
    still issued (the throttle counts purpose).
- Verify:
  - Concurrent `Promise.all` of two verifications of one token -> exactly
    one session.
  - An invitation token while pending -> a session, and the user becomes
    ACCEPTED.
  - A second invitation token after acceptance -> UNAUTHENTICATED.
  - A LOGIN token for a pending user -> a session, and the user becomes
    ACCEPTED.
  - Rate limited -> RATE_LIMITED.
- Bootstrap:
  - Disabled -> SERVICE_UNAVAILABLE.
  - A wrong or empty token on an empty instance -> FORBIDDEN, and no user is
    created.
  - A wrong token on a non-empty instance -> FORBIDDEN, not CONFLICT.
  - The correct token -> admin plus key, and the user is ACCEPTED.
  - A second call with the correct token -> CONFLICT.
  - Rate limited -> RATE_LIMITED before the token is checked (assert that
    the hasher or user store is untouched).
- Invitations:
  - `createUser` sends exactly one mail. Its text matches
    `/^https:\/\/mail\.example\.com\/auth\/verify\?token=\S+$/m` and its
    HTML contains `href="https://mail.example.com/auth/verify?token=`.
  - The challenge purpose is INVITATION, and its expiry is now + 604800 s.
  - A TTL of 86400 produces the "1 day" wording, and a TTL of 90000
    produces hours.
  - Mail unconfigured -> SERVICE_UNAVAILABLE and the user store is empty.
  - A send failure (make the recording sender throw) -> the error propagates
    and the user exists as PENDING.
  - Resend for a pending user -> a second mail. Resend for accepted,
    deactivated or unknown users -> CONFLICT, CONFLICT and NOT_FOUND.
  - The 4th invitation within 24h -> RATE_LIMITED, and 24h later it is
    allowed again (advance the fixed clock).
  - A non-admin viewer or an API-key viewer -> FORBIDDEN.
- Update the existing `auth.test.ts` and `users.test.ts` call sites to the
  new signatures. Do not weaken any existing assertion.

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- If a file changed since your last read, re-read it and reapply only this
  plan's intent. Never revert edits you did not make.
- Edit only the writePaths above.
- Do not run repository-wide formatters.

## Verification (from the repository root; record exit codes and counts)

1. `bunx vitest run packages/application` must exit 0, and the new test
   files must be listed.
2. `bun run --cwd packages/application typecheck` must exit 0.
3. `bun run --cwd packages/domain typecheck` must exit 0.
4. `biome check packages/application/src --diagnostic-level=warn` must exit
   0.
5. `wc -l packages/application/src/usecases.ts packages/application/src/usecases/email-auth.ts packages/application/src/usecases/invitations.ts`
   must show each file under 1000 lines.

Expected temporary breakage, recorded but not fixed:
`packages/infrastructure` and `apps/api` typecheck errors in
`graphql/resolvers/mutation.ts` (plan 07) and `apps/api/src/server.test.ts`
(plan 08) caused by the new signatures. Record them in the progress log.

## Done criteria

- [ ] The four pinned signatures exist exactly as written.
- [ ] Every test case listed above exists and passes.
- [ ] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
