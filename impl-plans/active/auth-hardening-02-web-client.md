# Auth Hardening 02: Web Client (Turnstile Login, Invite UI, Static CSP)

**Status**: Ready
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
- impl-plans/active/auth-hardening-02-web-client.md (progress log only)
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

- [ ] The `_headers` CSP has exactly the two directive changes.
- [ ] All tests listed above exist and pass.
- [ ] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
