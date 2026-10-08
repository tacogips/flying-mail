# MCP Server 10: HTTP Transport Pipeline and Runtime Wiring

**Status**: Not Started
**Plan ID**: mcp-server-10-transport-wiring
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-01-application-usecases, mcp-server-02-content-shaping, mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 3, 3.1-3.4, 7, 8; design-docs/specs/design-security-model.md 9c; design-docs/specs/design-deployment.md (MCP_RATE_LIMITER block)
**Created**: 2026-10-08

## Intent and context

This plan exposes `POST /mcp` on the shared hono app, which serves the
Worker, Bun and Node. It runs design section 3's ordered pipeline:

1. method
2. Origin
3. limiter configured
4. per-IP limit
5. API-key-only Bearer auth
6. per-key limit
7. Accept
8. Content-Type
9. body cap
10. JSON parse, then `dispatchMcpMessage`

It also wires the `MCP_RATE_LIMITER` binding (Worker) and an in-memory
limiter (Bun/Node), and adds OAuth-discovery JSON 404s.

Repository context:

- `packages/infrastructure/src/http/app.ts:createApp`:
  `app.use("*", createSecurityHeadersMiddleware())`, then
  `app.use("*", createAuthMiddleware(...))`, then routes. `/mcp` must be
  registered **between** these two `use` calls, so the auth middleware
  never runs for it.
- `packages/infrastructure/src/http/auth-middleware.ts`:
  `extractBearerToken`, `isCrossOriginRequest`.
- `apps/api/src/worker.ts:getOrBuildWorker`: builds `createApp` with
  `resolveClientIp` from `cf-connecting-ip`.
- `apps/api/src/worker-config.ts`: the `AUTH_RATE_LIMITER` wiring pattern.
- `apps/api/src/env.ts:Env`.
- `apps/api/src/server.ts:createLocalApp`: an in-memory limiter for auth
  using `createInMemoryRateLimiter({...AUTH_RATE_LIMIT, clock})`.
- `apps/api/wrangler.toml`: the `[[ratelimits]] AUTH_RATE_LIMITER` block.

Contracts consumed:

- `usecases.resolveApiKeyViewerFromToken` (plan 01);
- `dispatchMcpMessage`, `MCP_TOOL_REGISTRY`, `consoleAuditSink`,
  `jsonRpcError` and its codes, and the constants `MCP_MAX_REQUEST_BYTES`
  and `MCP_RATE_LIMIT` (plan 03);
- the `./mcp/*` package export (plan 02).

## Non-goals

- Do not edit `apps/api/src/worker.test.ts`. It is 998 lines; add new test
  files instead.
- Do not edit `app.test.ts`, `auth-middleware.ts` or `security-headers.ts`.
- No change to `AUTH_RATE_LIMITER`, `AppDependencies.rateLimiter`, CSP or
  the realtime upgrade path.
- No SSE, no sessions, no OAuth endpoints beyond the 404s.
- Do not deploy, do not run remote wrangler, do not set secrets.

## writePaths

- packages/infrastructure/src/mcp/http-handler.ts (new)
- packages/infrastructure/src/mcp/http-handler.test.ts (new)
- packages/infrastructure/src/http/app.ts
- apps/api/src/env.ts
- apps/api/src/worker.ts
- apps/api/src/server.ts
- apps/api/src/worker-mcp.test.ts (new)
- apps/api/src/server-mcp.test.ts (new)
- apps/api/wrangler.toml
- impl-plans/active/mcp-server-10-transport-wiring.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: `http-handler.ts`

```
export interface McpHttpHandlerOptions { readonly deps: AppDependencies; readonly usecases: UseCases; readonly rateLimiter: RateLimiter | null; readonly resolveClientIp: (c: Context) => string | null; readonly registry?: McpToolRegistry; readonly audit?: McpAuditSink }
export function createMcpHttpHandler(options: McpHttpHandlerOptions): (c: Context) => Promise<Response>;
```

Steps, in order. The first failure answers.

| # | Check | Failure response |
|---|-------|------------------|
| 1 | `method !== "POST"` | 405, header `Allow: POST`, empty body |
| 2 | `isCrossOriginRequest(c.req.raw, deps.instanceConfig.publicOrigin)` | 403, body `jsonRpcError(null, -32000, "Origin not allowed")` |
| 3 | `rateLimiter === null` | 503, `-32000` "MCP is not configured on this server" |
| 4 | `ip = resolveClientIp(c)`; when non-null and `!(await rateLimiter.limit("mcp:ip:" + ip))` | 429, `Retry-After: 60`, `-32000` "Rate limited", `data: { code: "RATE_LIMITED" }` |
| 5 | `token = extractBearerToken(c.req.raw)`; `viewer = token === null ? null : await usecases.resolveApiKeyViewerFromToken(token)` | when `null`: 401, `WWW-Authenticate: Bearer realm="flying-mail"`, `-32000` "Authentication required". **Never read the Cookie header.** |
| 6 | `limit("mcp:key:" + viewer.apiKeyId)` fails | 429, as in step 4 |
| 7 | `Accept` present and none of `application/json`, `application/*`, `*/*` appears in it | 406 |
| 8 | `Content-Type` missing or not `application/json` (case-insensitive, ignoring parameters) | 415 |
| 9 | `Content-Length` greater than `MCP_MAX_REQUEST_BYTES` | 413 without reading, `data: { maxBytes }` |
| 9 | Otherwise | read `c.req.raw.body` with a reader, summing bytes; above the cap, cancel the reader and answer 413. A null body is empty. |
| 10 | `JSON.parse(new TextDecoder().decode(bytes))` throws | 400, `jsonRpcError(null, -32700, "Parse error")` |

**Step 11 (dispatch).** Call `dispatchMcpMessage` with:

- `message`;
- `headers: c.req.raw.headers`;
- `registry: options.registry ?? MCP_TOOL_REGISTRY`;
- `context: { viewer, usecases, deps }`;
- `keyPrefix: token.slice(0, 16)`;
- `clientIp: ip`;
- `audit: options.audit ?? consoleAuditSink`;
- `nowMs: () => Date.now()`.

Respond with `status`, and with the JSON body or no body when it is `null`.

**On every response:**

- `Cache-Control: no-store`;
- `Content-Type: application/json` when there is a body;
- never `Set-Cookie` and never `Mcp-Session-Id`.

### TASK-002: `app.ts`

- Add `readonly mcp?: { readonly rateLimiter: RateLimiter }` to
  `CreateAppOptions`, with a doc comment.
- Immediately after the security-headers `use`, and **before**
  `app.use("*", createAuthMiddleware(...))`, register:
  `app.all("/mcp", createMcpHttpHandler({ deps, usecases, rateLimiter: options.mcp?.rateLimiter ?? null, resolveClientIp: options.resolveClientIp ?? (() => null) }))`.
- Next to the existing `app.all("/api/*", ...)` JSON 404, add JSON 404s
  (`{ error: "Not found" }`) for:
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-protected-resource/*`
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/oauth-authorization-server/*`
- Update the route-order doc comment.

### TASK-003: Runtime wiring

- **`env.ts`:** `readonly MCP_RATE_LIMITER?: RateLimitBindingLike;` in
  `Env`. Do not add it to `envToRecord`; it is a binding, not a variable.
- **`worker.ts:getOrBuildWorker`:** pass
  `...(env.MCP_RATE_LIMITER === undefined ? {} : { mcp: { rateLimiter: createWorkersRateLimiter(env.MCP_RATE_LIMITER) } })`
  to `createApp`. Import `createWorkersRateLimiter` from
  `@flying-mail/adapter/rate-limit/workers-binding`.
- **`server.ts:createLocalApp`:** pass
  `mcp: { rateLimiter: createInMemoryRateLimiter({ ...MCP_RATE_LIMIT, clock: { now: () => new Date() } }) }`,
  with `MCP_RATE_LIMIT` from `@flying-mail/infrastructure/mcp/constants`.
- **`wrangler.toml`:** after the `AUTH_RATE_LIMITER` block, add:

  ```
  [[ratelimits]]
  name = "MCP_RATE_LIMITER"
  namespace_id = "1002"
  simple = { limit = 120, period = 60 }
  ```

  Precede it with a one-line comment referencing design-mcp-server.md 3.3.
  No other `wrangler.toml` change.

## Pitfalls

- **Registration order is the security boundary.** If `/mcp` is registered
  after the auth middleware, a session cookie would be resolved, and a
  cross-origin cookie POST would hit the CSRF 403 path instead of the MCP
  Origin check. A test asserts that `resolveViewerFromToken` is never called
  for `/mcp`.
- The per-IP limit runs **before** auth. The body is read **after** auth.
  Do not swap them.
- `resolveApiKeyViewerFromToken` must be the only resolver used. Never
  `resolveViewerFromToken`.
- The 401 body and headers are identical for a missing, malformed, unknown,
  revoked or expired key, and for a session token.
- Do not log the token or the body. Audit happens only inside the dispatch.
- `exactOptionalPropertyTypes`: pass `mcp` via a conditional spread; never
  pass `mcp: undefined`.
- Keep `app.ts` under 260 lines and `http-handler.ts` under 300.

## Tests (input -> expected)

`http-handler.test.ts` goes through `createApp`. Imitate
`packages/infrastructure/src/http/app.test.ts:createHarness` to issue a real
API key and a session.

The rate limiter is
`createFakeRateLimiter` from `@flying-mail/application/test-support/auth-hardening-fakes`,
or an in-memory limiter, and the audit lines are captured with a spy on
`console.log`.

| Situation | Expected |
|-----------|----------|
| `GET /mcp` | 405 with `Allow: POST` |
| `DELETE /mcp` | 405 |
| POST with `Origin: https://evil.test` | 403 with a JSON-RPC body and `id: null` |
| Malformed `Origin` | 403 |
| No `Origin` | passes to auth |
| `Origin` equal to the app origin | passes to auth |
| `createApp` without `mcp` | 503 |
| Fake limiter denying `mcp:ip:*` | 429 with `Retry-After`; `resolveApiKeyViewerFromToken` is not called (spy) |
| No `Authorization` header | 401 with `www-authenticate` starting `Bearer` |
| `Bearer garbage` | 401 |
| Revoked key | 401 |
| Expired key | 401 |
| Bearer `session-token` (a valid session) | 401 |
| `Cookie: mailcal_session=session-token` and no Bearer | 401, and `usecases.resolveViewerFromToken` is never called (spy) |
| Valid key with the limiter denying `mcp:key:<id>` | 429 |
| `Accept: text/html` | 406 |
| `Content-Type: text/plain` | 415 |
| `Content-Length: 7340033` | 413, and the body is not read |
| A streamed body larger than the cap without `Content-Length` (a `ReadableStream` request body) | 413 |
| A body of `{` | 400 `-32700` |
| Valid key, legacy `initialize` | 200, `result.protocolVersion`, no `mcp-session-id` header, `cache-control: no-store` |
| Valid key, `notifications/initialized` | 202 with an empty body |
| Valid key, `tools/list` | 200 with an array (the contents depend on wave-2 tool plans; assert only the array shape) |
| `GET /.well-known/oauth-protected-resource` | 404 JSON |
| `/.well-known/oauth-authorization-server/x` | 404 JSON |

`worker-mcp.test.ts`:

- Build `Env` the way `apps/api/src/worker.test.ts` does (structural fakes;
  `clearWorkerCacheForTesting` between cases).
- With `MCP_RATE_LIMITER` bound to an allow-all fake: an unauthenticated
  `POST /mcp` -> 401, and `ASSETS.fetch` is not called.
- Without the binding -> 503.

`server-mcp.test.ts`:

- `createLocalApp()` (imitate `apps/api/src/server.test.ts`): unauthenticated
  `POST /mcp` -> 401, which proves the in-memory limiter is wired.
- `GET /mcp` -> 405.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/http-handler.test.ts apps/api/src/worker-mcp.test.ts apps/api/src/server-mcp.test.ts 2>&1 | tee /tmp/mcp-server-10-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bunx vitest run packages/infrastructure/src/http apps/api/src 2>&1 | tee /tmp/mcp-server-10-regression.log`
   - Expected: exit 0. The existing app, worker and server tests are
     unchanged and green.
3. `bun run typecheck 2>&1 | tee /tmp/mcp-server-10-typecheck.log`
   - Expected: exit 0. Cross-plan transients are recorded and re-run.
4. `bunx biome check <each writePaths TypeScript file>`
   - Expected: exit 0.
5. `grep -n "MCP_RATE_LIMITER" apps/api/wrangler.toml apps/api/src/env.ts apps/api/src/worker.ts`
   - Expected: at least 1 match in each file.
6. `wc -l packages/infrastructure/src/http/app.ts packages/infrastructure/src/mcp/http-handler.ts apps/api/src/worker.ts apps/api/src/server.ts`
   - Expected: every file under 1000 lines (targets: app.ts under 260,
     http-handler.ts under 300).

## Done criteria

- [ ] `/mcp` is mounted before the auth middleware, and the pipeline order
      matches the table above.
- [ ] The Worker, Bun and Node wiring and the wrangler binding are present.
- [ ] Verification steps 1-6 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- Put evidence under `tmp/mcp-server-s316/mcp-server-10-transport-wiring/<attempt>/`.

## Progress Log

(empty)
