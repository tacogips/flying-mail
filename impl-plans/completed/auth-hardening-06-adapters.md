# Auth Hardening 06: Turnstile and Rate-Limit Adapters

**Status**: Completed
**Plan ID**: auth-hardening-06-adapters
**Wave**: 2 (phase 18)
**Depends On**: auth-hardening-01-contracts-and-persistence
**Design Reference**: design-docs/specs/design-security-model.md sections 5.2, 6.1, 6.2
**Created**: 2026-10-07

## Intent and context

This plan adds the concrete adapters behind the ports that plan 01 created:

- a fetch-based Cloudflare Turnstile siteverify verifier
- a Workers Rate Limiting binding adapter
- an in-memory fixed-window limiter for the Bun/Node server

Plan 08 wires them in composition.

## Non-goals

- No wiring into `build-dependencies.ts`. That is plan 08.
- No use-case logic.
- No new npm dependencies.
- Do not import `@cloudflare/workers-types`. Use local structural types, as
  `packages/adapter/src/sql/d1.ts:D1DatabaseLike` does.

## writePaths

- packages/adapter/src/turnstile/siteverify.ts (new)
- packages/adapter/src/turnstile/siteverify.test.ts (new)
- packages/adapter/src/rate-limit/workers-binding.ts (new)
- packages/adapter/src/rate-limit/in-memory.ts (new)
- packages/adapter/src/rate-limit/rate-limit.test.ts (new)
- packages/adapter/package.json. Add exactly three `exports` entries:
  - `"./turnstile/siteverify": "./src/turnstile/siteverify.ts"`
  - `"./rate-limit/workers-binding": "./src/rate-limit/workers-binding.ts"`
  - `"./rate-limit/in-memory": "./src/rate-limit/in-memory.ts"`

  Change nothing else in the file. In particular, do not touch dependencies.
- impl-plans/completed/auth-hardening-06-adapters.md (progress log only)

sharedPaths: none.

## Pinned exports (contract with plan 08)

```ts
// turnstile/siteverify.ts
export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export interface SiteverifyTurnstileOptions { readonly secret: string; readonly expectedHostname: string; readonly fetch?: typeof fetch; readonly timeoutMs?: number }
export function createSiteverifyTurnstileVerifier(options: SiteverifyTurnstileOptions): TurnstileVerifier;
// rate-limit/workers-binding.ts
export interface RateLimitBindingLike { limit(options: { readonly key: string }): Promise<{ readonly success: boolean }> }
export function createWorkersRateLimiter(binding: RateLimitBindingLike): RateLimiter;
// rate-limit/in-memory.ts
export interface InMemoryRateLimiterOptions { readonly limit: number; readonly periodSeconds: number; readonly clock: Clock; readonly maxKeys?: number }
export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions): RateLimiter;
export const AUTH_RATE_LIMIT = { limit: 10, periodSeconds: 60 } as const;
```

## Behaviour

### Siteverify adapter

- An empty token, or one longer than 2048 characters, returns `false`
  without calling fetch.
- The request is `POST` to `TURNSTILE_SITEVERIFY_URL`. The body is
  `URLSearchParams` with `secret` and `response`, plus `remoteip` only when
  it is non-null. Content type is
  `application/x-www-form-urlencoded`.
- The timeout is `AbortSignal.timeout(timeoutMs ?? 5000)`.
- It returns `true` only when all of these hold:
  - the response status is 2xx
  - the body is JSON
  - `success === true`
  - `hostname === expectedHostname`
  - `action === input.action`
- Any thrown error (network, abort, JSON parse) and every failed check
  returns `false`. On error, log with
  `console.error("Turnstile siteverify failed", reason)`. Never include the
  secret or token in the log. The adapter fails closed.
- Use `options.fetch ?? globalThis.fetch`, and call it unbound from a local
  const the same way `packages/adapter/src/carddav/carddav-client.ts`
  handles `fetchImpl`. The option is named `fetch`, as in
  `packages/adapter/src/mail/cloudflare-email-api.ts`.
- Tests build their fake fetch the same way
  `packages/adapter/src/mail/cloudflare-email-api.test.ts` does.

### Workers binding adapter

- `limit(key)` returns `(await binding.limit({ key })).success`.
- If the binding throws, log
  `console.error("Rate limiter binding failed", error)` and return `true`.
  This is fail-open by design (section 6.1).

### In-memory limiter

- It keeps a `Map<string, { windowStart: number; count: number }>` of fixed
  windows, with time taken from `clock.now()`.
- A new window starts when `now - windowStart >= periodSeconds * 1000`.
- The call is allowed while `count < limit`, incrementing the count, and
  denied otherwise.
- When the map size exceeds `maxKeys ?? 10000`, delete every entry whose
  window has expired before inserting a new key.
- `AUTH_RATE_LIMIT` must equal the wrangler binding
  `simple = { limit = 10, period = 60 }`.

## Pitfalls

- Do not trust or read request headers here. The IP arrives inside the key
  or as `remoteIp`.
- Do not treat a missing `action` as a match.
- Do not cache a verification result. Turnstile tokens are single use.
- A denied in-memory request must not increment the count beyond the limit
  in a way that extends the window. Keep the fixed window.

## Tests (`input -> expected`)

- Siteverify, with an injected fake fetch that records the request:
  - success with matching hostname and action -> true. The body contains
    `secret`, `response` and `remoteip`, and the URL is exact.
  - `remoteIp: null` -> the body has no `remoteip`.
  - hostname mismatch -> false
  - action mismatch -> false
  - action missing -> false
  - `success:false` -> false
  - HTTP 500 -> false
  - non-JSON body -> false
  - fetch throws -> false
  - abort or timeout (a fetch that rejects with `AbortError`) -> false
  - empty token -> false, with fetch not called
  - a 2049-character token -> false, with fetch not called
- Workers binding:
  - success:true -> true
  - success:false -> false
  - the key passes through unchanged
  - the binding throws -> true
- In-memory, with a mutable fake clock (imitate
  `packages/application/src/test-support/runtime-fakes.ts:fixedClock` or a
  local stub):
  - 10 calls -> allowed, and the 11th -> denied
  - after 60 s -> allowed again
  - different keys are independent
  - with `maxKeys: 2`, inserting a third key after the earlier windows
    expired prunes them (the map size stays bounded)

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- Reapply only this plan's intent if the file drifted. Never revert others'
  edits.
- Edit only the owned paths.

## Verification (from the repository root)

1. `bunx vitest run packages/adapter/src/turnstile packages/adapter/src/rate-limit`
   must exit 0, with all listed cases present.
2. `bun run --cwd packages/adapter typecheck` must exit 0. If it fails only
   because of in-flight edits by plan 05 in `packages/application`, record
   that and rerun once plan 05 has finished.
3. `biome check packages/adapter/src/turnstile packages/adapter/src/rate-limit --diagnostic-level=warn`
   must exit 0.

## Done criteria

- [x] The pinned exports exist exactly as written.
- [x] All tests listed above pass.
- [x] No new dependency appears in any `package.json`.

## Progress Log

### Session: 2026-10-07, step6-20261007-01
**Tasks Completed**: Implemented and tested the siteverify Turnstile adapter, Workers binding rate limiter, in-memory fixed-window limiter, and three package exports. No dependency changed. Plan 08 owns composition wiring; plan 09 owns combined-tree verification and reconciliation.
**Hashes**: Final source hashes are recorded in `tmp/auth-hardening-s305/auth-hardening-06-adapters/step6-20261007-01/final-source-sha256.txt`; per-edit intentions and before/after hashes are in `edit-intentions.jsonl`.
**Verification evidence**: `verification-safe-log/` records final-source results: `bunx vitest run packages/adapter/src/turnstile packages/adapter/src/rate-limit` exit 0 (2 files, 18 tests passed); `bun run --cwd packages/adapter typecheck` exit 0; `biome check packages/adapter/src/turnstile packages/adapter/src/rate-limit --diagnostic-level=warn` exit 0 (5 files, no diagnostics). The earlier formatting-only Biome failure and its scoped formatter correction are retained in `verification/` and the step evidence directory.

### Session: 2026-10-07, review fixes
**Tasks Completed**: The in-memory rate limiter now prunes expired windows and, if still at `maxKeys`, evicts the oldest Map entry before tracking a new key. Added coverage confirming expired pruning and oldest-key eviction preserve fixed-window behavior while bounding tracked keys.
**Verification evidence**: `bunx biome check` on the eight touched TypeScript files passed; `bun run typecheck` passed for all packages; `bunx vitest run apps/api packages/infrastructure/src/composition packages/adapter/src/rate-limit` passed (4 files, 113 tests).

### Session: 2026-10-07 orchestrator completion
The riela workflow accepted 01, 03, 05 and 06; its implementation-progress-check gate rejected valid evidence for 02 (web tests 273/273) and 04 (docs-only) three times, so the orchestrator continued with GPT-6 Luna implementing 07, 08 and 09 and read-only Opus reviews: 02 APPROVED (W1-W5 fixed), 04 CHANGES_REQUESTED (D1-D3 fixed), 07 APPROVED (N1-N4 tests added), 08 CHANGES_REQUESTED (C1-C2, S1-S3, E1 IPv6 /64 keying, E2 bounded in-memory limiter fixed). Final gate: mise run lint exit 0; bun run test 1830 package + 274 web tests; build-web and Worker dry run exit 0. Deployed to https://mail.tacoserve.online (workers.dev 404) on a fresh D1 with migrations 0001-0015; bootstrap via mise run bootstrap-admin with the deploy-time token succeeded once, a second attempt returned CONFLICT, and the bootstrap secret was deleted; wrong token -> FORBIDDEN; missing Turnstile token -> FORBIDDEN; parallel burst -> RATE_LIMITED; CSP adds only challenges.cloudflare.com; Turnstile widget renders and blocks headless automation.
