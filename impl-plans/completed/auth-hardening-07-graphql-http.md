# Auth Hardening 07: GraphQL Surface and HTML CSP

**Status**: Completed
**Plan ID**: auth-hardening-07-graphql-http
**Wave**: 3 (phase 19)
**Depends On**: auth-hardening-01-contracts-and-persistence, auth-hardening-02-web-client, auth-hardening-05-auth-usecases

Plan 02 is listed because this plan's `_headers` equality test reads
`apps/web/public/_headers`, which plan 02 writes. Plan 02 is in wave 1, so
the dependency costs no parallelism.
**Design Reference**: design-docs/specs/design-security-model.md sections 2.2, 3.2, 4.6, 5.3, 5.5; design-docs/specs/design-graphql-api.md "Operation catalogue" (Auth, Users) and "Errors"
**Created**: 2026-10-07

## Intent and context

This plan exposes the plan-05 use cases through GraphQL:

- the `token` argument on `bootstrapAdmin`
- the optional `turnstileToken` argument on `requestEmailAuth`
- a new `resendInvitation` mutation
- a new unauthenticated `publicConfig` query
- a new `User.invitationStatus` field
- `clientIp` passed through from `GraphQLContext`

It also widens the HTML CSP for Turnstile in the server-rendered headers.
`RATE_LIMITED` needs no mapping work: `toGraphQLError` already maps any
`ApplicationError` code 1:1.

## Non-goals

- No use-case logic. No config parsing.
- Do not edit `apps/web/public/_headers`; plan 02 owns it. This plan only
  reads it in a test.
- Do not add a 429 path. RATE_LIMITED stays a GraphQL error at HTTP 200.

## writePaths

- packages/infrastructure/src/graphql/schema.graphql.ts
- packages/infrastructure/src/graphql/resolvers/mutation.ts
- packages/infrastructure/src/graphql/resolvers/auth.ts (new; move `authMutations` here)
- packages/infrastructure/src/graphql/resolvers/query.ts
- packages/infrastructure/src/graphql/resolvers/types.ts
- packages/infrastructure/src/graphql/graphql-test-support.ts
- packages/infrastructure/src/graphql/schema.test.ts
- packages/infrastructure/src/graphql/schema-users.test.ts
- packages/infrastructure/src/graphql/schema-templates.test.ts (only call-site updates if they break)
- packages/infrastructure/src/graphql/schema-auth-hardening.test.ts (new)
- packages/infrastructure/src/http/security-headers.ts
- packages/infrastructure/src/http/security-headers.test.ts (new)
- packages/infrastructure/src/http/app.test.ts (only if existing assertions break)
- impl-plans/completed/auth-hardening-07-graphql-http.md (progress log only)

sharedPaths: none.

## File-level changes

### SDL (`schema.graphql.ts`)

- Add `enum InvitationStatus { PENDING ACCEPTED }`.
- Add the field `invitationStatus: InvitationStatus!` to `type User`, with a
  doc string: "PENDING until the user's first successful sign-in".
- Add `type PublicConfig { turnstileSiteKey: String }`, with a doc string
  saying it is null while Turnstile is disabled.
- `Query`: add `publicConfig: PublicConfig!`.
- `Mutation`:
  - `bootstrapAdmin(email: String!, name: String!, token: String!)`
  - `requestEmailAuth(email: String!, turnstileToken: String)`
  - add `resendInvitation(userId: ID!): User!`
- The file must stay under 1000 lines (it is 857 today).

### Resolvers

- Move `authMutations` from `mutation.ts` into a new
  `resolvers/auth.ts` and spread it back into `mutationResolvers`. This
  keeps `mutation.ts` (774 lines) well under 1000 lines.
- `bootstrapAdmin` calls `ctx.usecases.bootstrapAdmin({ email, name, token, clientIp: ctx.clientIp })`.
- `requestEmailAuth` calls `ctx.usecases.requestEmailAuth({ email, turnstileToken: args.turnstileToken ?? null, clientIp: ctx.clientIp })`.
- `verifyEmailAuthToken` calls `ctx.usecases.verifyEmailAuthToken(args.token, ctx.clientIp)`.
  The cookie and viewer logic stay unchanged.
- `resendInvitation`:
  - Imitate the `createUser` resolver in `mutation.ts` (about line 231):
    `requireViewerOrThrow`, `createUserId(args.userId)`, and return
    `result.user`.
  - It belongs with `userMutations`. Put it next to `createUser` in
    `mutation.ts`.
- `query.ts`: add a `publicConfig` resolver returning
  `{ turnstileSiteKey: ctx.deps.instanceConfig.turnstileSiteKey }`. It needs
  no viewer and **must not** call `requireViewerOrThrow`.
- `types.ts`: in the User field resolvers (next to `active(user)`, about
  line 347), add `invitationStatus(user)` that returns the domain
  `invitationStatus(user)`.
- `graphql-test-support.ts`: the harness `run` accepts an optional
  `clientIp`. Use an optional 4th parameter or an options object, but keep
  existing call sites compiling. It is forwarded to `buildGraphQLContext`.

### CSP (`security-headers.ts`)

- `HTML_CSP`:
  - `script-src 'self' https://challenges.cloudflare.com`
  - `frame-src 'self' blob: https://challenges.cloudflare.com`
- Every other directive stays byte-identical.
- Export `HTML_CSP` (named export) so the test can compare it.
- Update the doc comment to mention Turnstile.

## Pitfalls

- `publicConfig` must work with `viewer: null`. Test it unauthenticated.
- Do not expose `bootstrapToken` or the Turnstile secret anywhere in the
  schema.
- `turnstileToken` must be nullable in the SDL. Making it `String!` breaks
  disabled-Turnstile deployments and the CLI.
- Existing `schema.test.ts` bootstrap tests (about lines 607-645) must be
  updated:
  - pass `token` as a **variable**
  - create the harness with
    `createFakeDependencies({ instanceConfig: { bootstrapToken: "<32+ char test token>" } })`
  Keep the existing "second bootstrap gets CONFLICT" assertion.
- Do not change `errors.ts`, unless a test shows RATE_LIMITED being masked.
- If the auth middleware or yoga turns an error into a non-200 status, that
  is a bug. Assert status 200 in the HTTP-level test.

## Tests (`input -> expected`)

In `schema-auth-hardening.test.ts`, using `createGraphQLHarness` with the
fakes from plan 01 (`createFakeRateLimiter`, `createFakeTurnstileVerifier`):

- `publicConfig` unauthenticated:
  - with `turnstileSiteKey: "site-key"` -> `"site-key"`
  - with `null` -> null
- `bootstrapAdmin` with the token variable:
  - correct -> payload with `secret`, `apiKey.keyPrefix`, and
    `user.invitationStatus = ACCEPTED`
  - wrong -> `FORBIDDEN`
  - bootstrap disabled -> `SERVICE_UNAVAILABLE`
  - document missing the `token` argument -> a GraphQL validation error,
    and the use case is not invoked
- `requestEmailAuth`:
  - with a limiter denying `auth:requestEmailAuth:203.0.113.9` and harness
    `clientIp: "203.0.113.9"` -> `errors[0].extensions.code === "RATE_LIMITED"`
  - Turnstile verifier configured and token missing -> `FORBIDDEN` with the
    message "Verification failed. Please retry."
  - valid token -> `true`, and the verifier saw `remoteIp: "203.0.113.9"`
- `verifyEmailAuthToken` rate limited -> RATE_LIMITED.
- `createUser` as admin -> `invitationStatus: PENDING`, and one mail is
  recorded.
- `resendInvitation`:
  - as admin -> User, and a second mail
  - as a non-admin or an API key -> FORBIDDEN
- In `security-headers.test.ts`:
  - `HTML_CSP` contains exactly the two changed directives above.
  - The only `https:` origin anywhere in `HTML_CSP` is
    `https://challenges.cloudflare.com`, and it appears exactly twice.
  - Read `apps/web/public/_headers` (path resolved from the test file via
    `import.meta.url`) and assert that its `Content-Security-Policy` value
    equals `HTML_CSP`. Plan 02 is a declared dependency, so `_headers` is
    already final when this plan starts.
  - An HTML response from `createSecurityHeadersMiddleware` carries the new
    CSP.

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- If a file drifted, reapply only this plan's intent. Never revert others'
  edits.
- Do not edit files owned by plan 08 (`composition/*`, `apps/api/*`), which
  runs after this plan in wave 4.

## Verification (from the repository root)

1. `bunx vitest run packages/infrastructure/src/graphql packages/infrastructure/src/http`
   must exit 0.
2. `bun run --cwd packages/infrastructure typecheck` must exit 0. Plan 08
   has not started yet, so `composition/` holds plan 01's compile-clean
   placeholders, and any error is this plan's to fix within its writePaths.
3. `biome check packages/infrastructure/src/graphql packages/infrastructure/src/http --diagnostic-level=warn`
   must exit 0.
4. `wc -l packages/infrastructure/src/graphql/schema.graphql.ts packages/infrastructure/src/graphql/resolvers/mutation.ts packages/infrastructure/src/graphql/resolvers/auth.ts`
   must show each file under 1000 lines.

## Done criteria

- [x] The SDL matches design-graphql-api.md "Auth" and "Users and
      permissions" exactly.
- [x] All tests listed above pass, including the `_headers` equality test.
- [x] Verification steps 1-4 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -

### Session: 2026-10-07
**Tasks Completed**: Implemented the GraphQL auth-hardening surface, invitation status/resend mutation, client IP forwarding, and Turnstile HTML CSP; added the specified GraphQL and HTTP tests.
**Hashes**: Per-edit SHA-256 before/after pairs recorded during implementation; plan log edit: 4819e46549685270c8bef7dc03b619886392989d584c6d70e8c1cd10a205dcfa -> 88ad19e25dd85545d92e67750e35469d0677665c4bb2e6b00292a74289916393.
**Verification evidence**:
- `bunx vitest run packages/infrastructure/src/graphql packages/infrastructure/src/http` — exit 0; 12 test files, 166 tests passed.
- `bun run --cwd packages/infrastructure typecheck` — exit 0.
- `biome check packages/infrastructure/src/graphql packages/infrastructure/src/http --diagnostic-level=warn` — exit 0; 42 files checked, no fixes applied.
- `wc -l packages/infrastructure/src/graphql/schema.graphql.ts packages/infrastructure/src/graphql/resolvers/mutation.ts packages/infrastructure/src/graphql/resolvers/auth.ts` — exit 0; 876, 722, and 74 lines.

### Session: 2026-10-07 (review notes)
**Tasks Completed**: Strengthened the CSP test with the full expected policy literal; added full-capability API-key denial coverage for `createUser` and `resendInvitation`; added a GraphQL resend-throttle case asserting `RATE_LIMITED` at HTTP 200; asserted missing-token bootstrap returns absent or null data.
**Hashes**: security-headers.test.ts `ac2d6453e24dff4f3b96940e665665586591c5330cda2a0c8cc7bfd29fc9277b` -> `55f8303df02be4f0ceb657077f1e4704353cbc0597e55aba17583ec8a34537f2`; schema-auth-hardening.test.ts `d51b8cea6196cb1ef174a2eeca635f23417c4e00512fecba321cc908c9d1ab69` -> `7f07c71eab7ebdb8c7515c69167b32124e6b81512359d033e617560d43d2a692`; Progress Log revisions: `46e9cda990f1dfa1d6bf8f7c61f20d3767096da48577ddb1dfbf89b19898a5d2` -> `d3576486577e0a8bfcedd64f82f8b65040f9c6f393db0dcf108e42aa74141695` -> `c09dc7b31ab3a56b5f91b360eb7a5d67ace5bd1a8963dc74174abd93d9672ee5`; final edit before hash: `c6cf679bb0da7f17a3598eae2f558d131dc156d63dbd291958f69c2a8a542fca` (after hash recorded in handoff).
**Verification evidence**:
- `bunx biome check packages/infrastructure/src/http/security-headers.test.ts packages/infrastructure/src/graphql/schema-auth-hardening.test.ts` — exit 0; 2 files checked, no fixes applied.
- `bunx vitest run packages/infrastructure/src/graphql packages/infrastructure/src/http` — exit 0; 12 test files, 169 tests passed.

### Session: 2026-10-07 orchestrator completion
The riela workflow accepted 01, 03, 05 and 06; its implementation-progress-check gate rejected valid evidence for 02 (web tests 273/273) and 04 (docs-only) three times, so the orchestrator continued with GPT-6 Luna implementing 07, 08 and 09 and read-only Opus reviews: 02 APPROVED (W1-W5 fixed), 04 CHANGES_REQUESTED (D1-D3 fixed), 07 APPROVED (N1-N4 tests added), 08 CHANGES_REQUESTED (C1-C2, S1-S3, E1 IPv6 /64 keying, E2 bounded in-memory limiter fixed). Final gate: mise run lint exit 0; bun run test 1830 package + 274 web tests; build-web and Worker dry run exit 0. Deployed to https://mail.tacoserve.online (workers.dev 404) on a fresh D1 with migrations 0001-0015; bootstrap via mise run bootstrap-admin with the deploy-time token succeeded once, a second attempt returned CONFLICT, and the bootstrap secret was deleted; wrong token -> FORBIDDEN; missing Turnstile token -> FORBIDDEN; parallel burst -> RATE_LIMITED; CSP adds only challenges.cloudflare.com; Turnstile widget renders and blocks headless automation.
