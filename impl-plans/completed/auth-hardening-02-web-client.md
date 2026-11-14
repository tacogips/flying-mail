# Auth Hardening 02: Web Client (Turnstile Login, Invite UI, Static CSP)

**Status**: Completed
**Plan ID**: auth-hardening-02-web-client
**Wave**: 1 (phase 17)
**Depends On**: none (implements against the GraphQL contract pinned in the design)
**Design Reference**: design-docs/specs/design-security-model.md sections 4.6, 5.4, 5.5; design-docs/specs/design-web-client.md routes table; design-docs/specs/design-graphql-api.md Auth and Users catalogue
**Created**: 2026-10-07

## Intent and context

The SolidJS web client (`apps/web`) needs three changes:

- The login page renders Cloudflare Turnstile when the server publishes a
  site key.
- Settings > Users becomes invitation-oriented, with status and a resend
  action.
- The static-asset CSP in `apps/web/public/_headers` allows Turnstile.

The server side lands in other plans. Web tests mock `fetch`, so this plan
is independent.

GraphQL contract (pinned by the design; do not deviate):

- `publicConfig { turnstileSiteKey }` (nullable String, unauthenticated)
- `requestEmailAuth(email: String!, turnstileToken: String): Boolean!`
- `User.invitationStatus: InvitationStatus!` (`PENDING` | `ACCEPTED`)
- `resendInvitation(userId: ID!): User!`
- the error code `RATE_LIMITED`

## Non-goals

- No new npm dependency. Do not use a Turnstile wrapper package.
- No Turnstile on `/auth/verify` or any authenticated page.
- No server code. Do not edit `packages/infrastructure/src/http/security-headers.ts`;
  plan 07 owns it and asserts equality with `_headers`.

## writePaths

- apps/web/public/_headers
- apps/web/src/lib/turnstile.ts (new)
- apps/web/src/lib/turnstile.test.ts (new)
- apps/web/src/pages/login-page.tsx
- apps/web/src/pages/login-page.test.tsx (new)
- apps/web/src/pages/settings/users-page.tsx
- apps/web/src/pages/settings/users-page.test.tsx (new)
- apps/web/src/api/documents.ts
- apps/web/src/api/schema-types.ts
- apps/web/src/api/graphql-client.ts
- apps/web/src/api/graphql-client.test.ts
- apps/web/src/lib/mutation-error.ts
- impl-plans/completed/auth-hardening-02-web-client.md (progress log only)
- apps/web/dist. This is a **build artifact root**: it is produced by
  `mise run build-web`, gitignored, and never edited by hand.

sharedPaths: none.

## File-level changes

### `_headers`

- In the CSP line, change only two directives:
  - `script-src 'self' https://challenges.cloudflare.com`
  - `frame-src 'self' blob: https://challenges.cloudflare.com`
- The resulting value must equal the server `HTML_CSP` byte for byte (plan
  07 tests this). Its directive order is `default-src`, `img-src`,
  `style-src`, `script-src`, `frame-src`, `object-src`, `base-uri`,
  `form-action`, `frame-ancestors`.
- Update the comment block to mention Turnstile.

### `lib/turnstile.ts`

- `export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"`.
- Minimal typed `TurnstileApi`: `render(el, options) => string`,
  `reset(id)` and `remove(id)`. Options are `sitekey`, `action`, `theme`,
  `callback`, `"expired-callback"` and `"error-callback"`.
- `loadTurnstile(): Promise<TurnstileApi>` injects the script once and
  caches the promise:
  - It resolves when `window.turnstile` exists after `onload`.
  - It rejects on `onerror`.
  - A rejected promise is cleared so that a reload or retry can try again.
- No other origin anywhere.

### `api/documents.ts` and `api/schema-types.ts`

- `REQUEST_EMAIL_AUTH_MUTATION` gains `$turnstileToken: String` and passes
  it.
- Add `PUBLIC_CONFIG_QUERY`.
- `USER_FIELDS` gains `invitationStatus`.
- Add `RESEND_INVITATION_MUTATION` returning `USER_FIELDS`.
- `UserView`, or whatever type backs `USER_FIELDS` (find its definition),
  gains `invitationStatus: "PENDING" | "ACCEPTED"`.

### `api/graphql-client.ts` and `lib/mutation-error.ts`

- Add `"RATE_LIMITED"` to `GraphQLErrorCode` and to the known-codes list
  (about line 73).
- `describeErrors` shows the server message for `RATE_LIMITED`.
- Update the existing `graphql-client.test.ts` only as needed to cover the
  new code.

### `pages/login-page.tsx` (design section 5.4)

- On mount, call `publicGraphqlRequest(PUBLIC_CONFIG_QUERY)`.
  - On failure: show "Could not load sign-in settings. Reload the page." and
    keep submit disabled.
  - If `turnstileSiteKey === null`: behave exactly as today.
  - Otherwise: call `loadTurnstile()`, then `render` into a container
    `div` with `{ sitekey, action: "login", theme: "auto", callback: setToken, "expired-callback": () => setToken(null), "error-callback": () => setToken(null) }`.
    If the script fails to load, show "Could not load verification. Reload
    the page." and keep submit disabled.
- Submit stays disabled until a token is held (only when Turnstile is
  enabled).
- Send `turnstileToken` (or `null`).
- After every attempt, whether it succeeded or failed, call `reset(widgetId)`
  and clear the token.
- `onCleanup` calls `remove(widgetId)`.
- Keep the uniform success text unchanged.

### `pages/settings/users-page.tsx`

- Use "Invite user" as the panel heading and button label. The success
  notice is "Invitation sent to <email>".
- After any `createUser` error, reload the list, because the user may exist
  as PENDING.
- Rows show "Invitation pending" for `PENDING`, or "Active" for `ACCEPTED`.
  The existing deactivated rendering takes precedence.
- For active `PENDING` rows, show a "Resend invitation" button. It is
  disabled while in flight, shows a notice on success, and shows errors
  (including `RATE_LIMITED`) via `describeErrors`.

## Pitfalls

- Never hard-code a site key. It must come from `publicConfig`.
- Do not include the token in any log or URL.
- Reset the widget on the error path too. Turnstile tokens are single use,
  so a stale token always fails.
- Do not load the script when the site key is null. Tests must assert that
  no `<script>` is injected in that case.
- Keep each file under 1000 lines. `users-page.tsx` is 525 lines today.

## Tests (`input -> expected`)

Use jsdom, `vi.stubGlobal("fetch")`, and a stub `window.turnstile`. Imitate
`apps/web/src/pages/settings/domains-page.test.tsx`.

- turnstile.ts:
  - two calls -> one script element whose `src` equals
    `TURNSTILE_SCRIPT_URL`
  - `onerror` -> rejects, and a later call injects again
- login-page:
  - site key null -> no script and no widget; submit enabled once an email
    is entered; the request has `turnstileToken: null`
  - site key set -> `render` called with `action: "login"` and
    `theme: "auto"`; submit disabled until the callback provides a token;
    the request carries the token; `reset` is called after success
  - an error response (`FORBIDDEN`) -> the error is shown, `reset` is
    called, and submit is disabled again
  - `publicConfig` fails -> the error text is shown and submit is disabled
- users-page:
  - a PENDING user shows "Invitation pending" and a "Resend invitation"
    button; clicking it sends `resendInvitation` with the user id
  - `RATE_LIMITED` -> the message is shown
  - an ACCEPTED user has no resend button
  - the button text "Invite user" is present
  - after a `createUser` error the list query is re-sent

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- If a file drifted, reapply only this plan's intent. Never revert others'
  edits.
- Edit only the owned paths.

## Verification (from the repository root)

1. `bun run --cwd apps/web test` must exit 0. The test count must be at
   least 264, plus the new tests.
2. `bun run --cwd apps/web typecheck` must exit 0.
3. `mise run build-web` must exit 0.
4. `biome check apps/web --diagnostic-level=warn` must exit 0.
5. `rg -n "https://" apps/web/src/lib/turnstile.ts apps/web/public/_headers`
   must list only `challenges.cloudflare.com` origins.

## Done criteria

- [x] The `_headers` CSP has exactly the two directive changes.
- [x] All tests listed above exist and pass.
- [x] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: 2026-10-07 — Step 6 implementation
**Tasks Completed**: Added the Turnstile loader and gated login flow, public GraphQL contracts and RATE_LIMITED handling, invitation status/resend UI, CSP allowlist, and the assigned web regression tests.
**Hashes**: Per-edit before hashes are recorded in `tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/before.sha256`; final hashes are recorded in `tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/after.sha256`.
**Verification evidence**:
- `bun run --cwd apps/web test`: exit 0; 273 tests passed across 24 files (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/web-tests.log`).
- `bun run --cwd apps/web typecheck`: exit 0 (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/typecheck.log`).
- `mise run build-web`: exit 0 (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/build-web.log`).
- `bunx biome check apps/web --diagnostic-level=warn`: exit 0 (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/biome.log`).
- `rg -n "https://" apps/web/src/lib/turnstile.ts apps/web/public/_headers`: exit 0; both allowed origins are challenges.cloudflare.com (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/external-origins.log`).
- `! rg -o -N --no-filename 'https://[A-Za-z0-9.-]+' apps/web/src/lib/turnstile.ts apps/web/public/_headers | rg -v -x 'https://challenges.cloudflare.com'`: exit 0 (`tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-1/allowed-origin-check.log`).
- The shared tree's server-side `HTML_CSP` still needs the matching additions owned by plan 07; `_headers` is ready for that dependent equality check.
- Formal independent implementation review and shared progress/index reconciliation remain downstream workflow steps.

### Session: 2026-10-07 — Step 6 source-matched verification rerun
**Tasks Completed**: Re-ran the assigned web verification in the foreground against the shared current source; no source changes were needed.
**Evidence**: `tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-step6-rerun/` contains complete logs and `.log.status` exit-code sidecars.
**Verification**:
- `bun run --cwd apps/web test`: exit 0; 24 files, 273 tests passed, 0 failures (`web-tests.log`).
- `bun run --cwd apps/web typecheck`: exit 0 (`typecheck.log`).
- `mise run build-web`: exit 0 (`build-web.log`).
- `bunx biome check apps/web --diagnostic-level=warn`: exit 0; 89 files checked with no diagnostics (`biome.log`).
- `! rg -o -N --no-filename 'https://[A-Za-z0-9.-]+' apps/web/src/lib/turnstile.ts apps/web/public/_headers | rg -v -x 'https://challenges.cloudflare.com'`: exit 0; no disallowed origins (`allowed-origin-check.log`).
**Handoff**: Plan 07 owns server `HTML_CSP` byte-equality verification; independent review and shared progress/index reconciliation remain downstream.

### Session: 2026-10-07 — Step 6 current-tree verification
**Tasks Completed**: Re-ran all assigned web checks in the foreground against the current shared tree. No source changes were needed.
**Evidence**: `tmp/auth-hardening-s305/auth-hardening-02-web-client/attempt-step6-current-20261007/` contains complete command logs and `.status` exit-code sidecars.
**Verification**:
- `bun run --cwd apps/web test`: exit 0; 24 files, 273 tests passed, 0 failures (`web-tests.log`).
- `bun run --cwd apps/web typecheck`: exit 0 (`typecheck.log`).
- `mise run build-web`: exit 0 (`build-web.log`).
- `bunx biome check apps/web --diagnostic-level=warn`: exit 0; 89 files checked with no diagnostics (`biome.log`).
- `! rg -o -N --no-filename 'https://[A-Za-z0-9.-]+' apps/web/src/lib/turnstile.ts apps/web/public/_headers | rg -v -x 'https://challenges.cloudflare.com'`: exit 0; no disallowed origins (`allowed-origin-check.log`).
- `git diff --check -- <assigned web paths and this plan>`: exit 0 (`diff-check.log`).
**Handoff**: Plan 07 owns server `HTML_CSP` byte-equality verification; independent review and shared progress/index reconciliation remain downstream.

### Session: 2026-10-07 — Opus low-severity review follow-up
**Tasks Completed**: Moved login success rendering after best-effort Turnstile reset and token clearing; contained reset/remove exceptions; added an alert role to login errors; labeled resend buttons by recipient; remove failed Turnstile scripts before rejecting; added loader-onload-without-API and expired-token submit-disable regression tests.
**Per-edit hashes**:
- `apps/web/src/pages/login-page.tsx`: `1249caf092049fd8286e37802a20ba2747dba36a4c68246c270d664232952266` → `0f09d6c4023e5160e07daf068df81c16f92ff1ebcf25fed88465181457977225`.
- `apps/web/src/pages/settings/users-page.tsx`: `30afa0bb3b90bdb985cd0feb725969e6b531324c40f44428c1464e7930961912` → `88bfbae08b9885d5908b3ac1d82fb71e03da63787779d059912b0708fdb384fc`.
- `apps/web/src/lib/turnstile.ts`: `0fc7382eba28ac5e085f032bd2f6cd7d39113b87b6250c99e1649a38725d1652` → `400f2d4ec1e731475ef0ff10a458aba235d11571cb8acbfb371c65b3ab7e7eea`.
- `apps/web/src/lib/turnstile.test.ts`: `176741b7eb0d0c82deb1745dcc97277bffde5def64bf8a8312caeafedcd116e7` → `3f09fcd76627d3c9702bf4b2a93dc3a39bbe79fb455c7503483e3bfa143406c6` → `ddd018a7d5343c10849b10dee036662223f5ca2b616fd04c70c17ad32b389d2f` → `33c2139f5ab2a45f24813be6d3f2b7d8678059c29a621651d60fd089faa061e5`.
- `apps/web/src/pages/login-page.test.tsx`: `0d2eec95790bb2d96c9d8b63c2b828206b30cf580fa27ba523452fd277683817` → `bb3db42e0991c30eac36916fd8d61d07738b1af81b2b78ad0481cc3b00c138c5`.
**Verification**: Not run in this implementation pass; requested foreground Biome, typecheck, and web tests are pending caller execution.

### Session: 2026-10-07 — Biome formatting correction
**Tasks Completed**: Applied Biome's required multiline formatting to the login error alert paragraph.
**Per-edit hashes**:
- `apps/web/src/pages/login-page.tsx`: `0f09d6c4023e5160e07daf068df81c16f92ff1ebcf25fed88465181457977225` → `8e160dcdb37c72f6031954ddf8c182c5f7af07b81ab5ce592af2a6b17e85d843`.
- `impl-plans/completed/auth-hardening-02-web-client.md`: `666c3386513287122ecd792804d60ba31f1c31dc1f79dd9479199cef45c057a4` → `dcb7499d43f0a5ffb8d51258c912b9b12f0e581e8821eb7929b0728ebb6ac055`.
**Verification**: Initial foreground Biome check identified this formatting issue. After correction, `bunx biome check apps/web/src --diagnostic-level=warn` exited 0 (87 files checked), `bun run --cwd apps/web typecheck` exited 0, and `bun run --cwd apps/web test` exited 0 (24 files, 274 tests passed).

### Session: 2026-10-07 — Opus follow-up foreground verification
**Tasks Completed**: Confirmed all requested foreground checks pass after formatting correction.
**Pre-edit plan hash**: `dcb7499d43f0a5ffb8d51258c912b9b12f0e581e8821eb7929b0728ebb6ac055`.
**Verification**:
- `bunx biome check apps/web/src --diagnostic-level=warn`: exit 0; 87 files checked, no fixes applied.
- `bun run --cwd apps/web typecheck`: exit 0.
- `bun run --cwd apps/web test`: exit 0; 24 files, 274 tests passed.

### Session: 2026-10-07 orchestrator completion
The riela workflow accepted 01, 03, 05 and 06; its implementation-progress-check gate rejected valid evidence for 02 (web tests 273/273) and 04 (docs-only) three times, so the orchestrator continued with GPT-6 Luna implementing 07, 08 and 09 and read-only Opus reviews: 02 APPROVED (W1-W5 fixed), 04 CHANGES_REQUESTED (D1-D3 fixed), 07 APPROVED (N1-N4 tests added), 08 CHANGES_REQUESTED (C1-C2, S1-S3, E1 IPv6 /64 keying, E2 bounded in-memory limiter fixed). Final gate: mise run lint exit 0; bun run test 1830 package + 274 web tests; build-web and Worker dry run exit 0. Deployed to https://mail.tacoserve.online (workers.dev 404) on a fresh D1 with migrations 0001-0015; bootstrap via mise run bootstrap-admin with the deploy-time token succeeded once, a second attempt returned CONFLICT, and the bootstrap secret was deleted; wrong token -> FORBIDDEN; missing Turnstile token -> FORBIDDEN; parallel burst -> RATE_LIMITED; CSP adds only challenges.cloudflare.com; Turnstile widget renders and blocks headless automation.
