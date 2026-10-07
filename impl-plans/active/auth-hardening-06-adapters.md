# Auth Hardening 06: Turnstile and Rate-Limit Adapters

**Status**: Ready
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
- impl-plans/active/auth-hardening-06-adapters.md (progress log only)

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

- [ ] The pinned exports exist exactly as written.
- [ ] All tests listed above pass.
- [ ] No new dependency appears in any `package.json`.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
