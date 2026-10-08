# Realtime Push 10: Bun Server WebSocket Wiring (In-Process Fan-out)

**Status**: Completed
**Plan ID**: realtime-push-10-bun-server
**Wave**: 4 (phase 25)
**Depends On**: realtime-push-01-contracts-and-persistence, realtime-push-05-graphql-surface-and-executor, realtime-push-08-hub-core
**Design Reference**: design-docs/specs/design-realtime-push.md sections 7.1, 8.3, 11 (Node returns 501)
**Created**: 2026-10-08

## Intent and context

The local Bun server must serve the same subscriptions without Cloudflare.
It uses plan 08's `createInProcessHost`, `createRealtimeHub`,
`checkRealtimeUpgrade` and `createLateBoundMailEventNotifier`, so local
writes poke the in-process hub. The Node runtime answers upgrades with 501.

## Non-goals

- Do not touch `worker.ts`, `env.ts`, `wrangler.toml` or
  `mail-event-hub.ts` (plan 09), or `packages/*`.
- No network listener in tests.

## writePaths

- apps/api/src/server.ts
- apps/api/src/realtime-bun.ts (new: Bun WebSocket handler adapter)
- apps/api/src/realtime-bun.test.ts (new)
- apps/api/src/server.test.ts
- impl-plans/completed/realtime-push-10-bun-server.md (progress log only)

sharedPaths: none.

## File-level changes

### `createLocalApp` (`server.ts:193`)

1. Create `const notifier = createLateBoundMailEventNotifier()`.
2. Pass `mailEventNotifier: notifier` into the config before
   `buildDependencies`.
3. After `createUseCases`, build the host, executor and hub:

   ```ts
   createInProcessHost()
   createSubscriptionExecutor({ schema: buildGraphQLSchema(), deps, usecases, publicOrigin: deps.instanceConfig.publicOrigin })
   createRealtimeHub({...})
   ```

4. Call `notifier.bind(hub)`.
5. Call `host.setWakeHandler(() => hub.wake())` (F-RP-A). Without this,
   the init timeout (4408), the idle close (4000) and the safety drain never
   run on Bun.
6. Return `realtime: { hub, host }` in `LocalApp`.

### `realtime-bun.ts`

`createBunRealtimeHandlers({ hub, host, deps })` returns:

- `upgrade(request, server): Promise<Response | undefined>`
  1. Client IP: `server.requestIP(request)?.address`, normalized with
     `normalizeClientIpForRateLimit`. Never use forwarding headers
     (design-security-model 2.1).
  2. `checkRealtimeUpgrade(...)`. Not ok: return its response.
  3. `hub.admit(ip)`: `IP_LIMIT` gives 429, `GLOBAL_LIMIT` gives 503.
  4. `server.upgrade(request, { data: { info }, headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" } })`.
     A `false` return gives 400.
  5. On success, return `undefined`, as Bun requires.
- `websocket`, a handler object:
  - `open(ws)`: `conn = host.attach({ send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) })`,
    store `conn` on `ws.data`, then `hub.open(conn, ws.data.info)`.
  - `message(ws, msg)`: `hub.message(ws.data.conn, typeof msg === "string" ? msg : <ArrayBuffer>)`.
  - `close(ws)`: `hub.closed(conn)`, then `host.detach(conn)`.
  - `maxPayloadLength: 65536`, so the hub's 16 KiB check is authoritative
    and produces 1009.
  - `idleTimeout`: Bun's maximum (960) or 0 where supported. The hub sweep
    is authoritative for idle detection; check the Bun docs and record the
    choice.

Type `server` and `ws` structurally (`{ requestIP(req), upgrade(req, opts) }`)
so tests need no Bun runtime.

### `startServer` (`server.ts:239`)

- Bun: export a factory `createBunFetchHandler({ app, handlers })`. It
  returns `(request, server) => Promise<Response | undefined>`, implemented
  as an **explicit branch** (F-RP-B):
  - `isRealtimeUpgradeRequest(request)` is true: `return await
    handlers.upgrade(request, server)`.
    - The result is a `Response` on rejection, or `undefined` after a
      successful `server.upgrade`.
    - `app.fetch` is **never** called on this branch.
  - Otherwise: `return app.fetch(request, { clientIp: server.requestIP(request)?.address ?? null })`,
    exactly as today.
  - Never combine the two branches with `??` or `||`. A successful upgrade
    returns `undefined`, which a fallback would turn into an `app.fetch`
    call.
- `Bun.serve({ port, fetch: createBunFetchHandler({ app, handlers }), websocket: handlers.websocket })`.
- Node: wrap `app.fetch`. When `isRealtimeUpgradeRequest(request)` is
  true, return `new Response("WebSocket subscriptions require the Bun or Workers runtime", { status: 501 })`.

## Pitfalls

- `server.upgrade` must be called inside the `fetch` callback with the
  original request. Returning `undefined` after a successful upgrade is
  required. The fetch handler must branch explicitly; never use
  nullish or OR fallbacks into `app.fetch`.
- Forgetting `host.setWakeHandler` leaves all timeouts dead. The wake test
  above guards against it.
- The upgrade path must bypass `app.fetch`: the security-headers middleware
  rebuilds responses.
- Do not trust `CF-Connecting-IP` or `X-Forwarded-For` locally.
- The hub must be bound before the first request. `createLocalApp` returns
  only after `notifier.bind`.

## Tests

**`realtime-bun.test.ts`** uses a fake server, a fake ws with a
`{ data }` object, and the real hub from `createLocalApp` against a
temporary libsql file. Alternatively, use the in-memory database through
the existing `server.test.ts` setup pattern.

- An upgrade with a valid subprotocol and no `Origin` -> `server.upgrade`
  is called with the subprotocol header and `data.info.cookieTokenHash`
  null, and the result is `undefined`.
- Cross-origin `Origin` -> 403 and no `server.upgrade` call.
- `open` then `connection_init` with a Bearer API key (seeded through the
  use cases) -> the fake ws receives `connection_ack`.
- Subscribe, then a write through `usecases.markRead` (or a dev-inbound
  ingest) -> the fake ws receives `next` for that message, then LIVE
  first. This proves the late-bound notifier poke.
- `close` -> the hub state is deleted.

**`createBunFetchHandler`** (F-RP-B; a spy `app.fetch`, a fake server):

- A valid upgrade request with `server.upgrade()` returning true -> the
  handler resolves `undefined`, and the `app.fetch` spy is called **0**
  times.
- `server.upgrade()` returning false -> a Response with status 400, and
  `app.fetch` is not called.
- A plain `POST /graphql` -> `app.fetch` is called once, with
  `{ clientIp }` from `server.requestIP`.

**`server.test.ts`** (extend):

- `createLocalApp` returns `realtime.hub`.
- **Wake binding (F-RP-A):**
  - With vitest fake timers, `createLocalApp` and a socket opened through
    `realtime-bun` handlers that sends nothing, advancing 10 s closes the
    fake ws with 4408. `wake()` is never called by hand.
  - If timer control over `createLocalApp` is impractical, export the
    wiring step as `wireRealtime(deps, usecases, options)` and test that
    instead.
- The Node fetch wrapper (export it for testing) returns 501 for an
  upgrade request, and passes through otherwise.

## Verification (repo root)

1. `bunx vitest run apps/api`: exit 0.
   - Plan 09 edits other `apps/api/src` files concurrently.
   - If a failure is located only in plan 09's files
     (`worker*.ts`, `mail-event-hub*.ts`, `env.ts`,
     `durable-object-types.ts`), re-run after plan 09 reports done.
   - Record both runs. The same applies to step 2.
2. `bun run --cwd apps/api typecheck`: exit 0.
3. `bunx biome check apps/api/src`: exit 0.
4. `wc -l apps/api/src/server.ts apps/api/src/realtime-bun.ts`: every file
   is under 1000 lines.

## Done criteria

- [x] Bun subscriptions work end to end in tests; Node returns 501.
- [x] Verification steps 1-4 pass, with outputs recorded.

## Drift protocol

- Plan 09 edits other files in `apps/api/src` in the same wave. Never touch
  them.
- Record the sha256 of each file before and after editing it.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -

### Session: 2026-10-07
**Tasks Completed**: Implemented local in-process host/notifier/hub wiring, Bun upgrade and WebSocket callbacks, explicit Bun fetch branching, Node 501 handling, and scoped adapter/server tests. The test covers Bearer `connection_init`/`connection_ack`, event append and the late-bound notifier poke; delivery through subscription preparation remains blocked by an upstream hub runtime error.
**Hashes before editing**:
- `apps/api/src/server.ts`: `6abb1c50cfa40de98092e23f6eac72a24acce1d7e12b77f11db475175acdce74`
- `apps/api/src/server.test.ts`: `6585d65bdfbb59d804d3b140aec72319c8b2acd538cbbb773b0d4e560688387c`
- `apps/api/src/realtime-bun.ts`: absent (new file)
- `apps/api/src/realtime-bun.test.ts`: absent (new file)
- this plan: `b99018ba3a9d398aa99fb0ad461ed37a7ab5c4d3b0b9260891348d9e89c30209`
**Hashes after editing**:
- `apps/api/src/server.ts`: `33eb3696f85fdef27f7ff50a7ff52a28dfccf238245393f28e8f95ee73f46524`
- `apps/api/src/server.test.ts`: `b813117e31920db8c2ac809ed991369d1c78a52875f7e67d12aa7bcb9e8d48f7`
- `apps/api/src/realtime-bun.ts`: `b3dfaaa90fd487a3dcc6371aca89788422ae8b617fa8d4b6c0c488a3c046fc0f`
- `apps/api/src/realtime-bun.test.ts`: `aa4a0a9c02426a73d654b551bdae8abd6e9284f8fb74e651491da2a09a503092`
- this plan: pending hash after this log entry
**Bun idle timeout**: Set `idleTimeout: 960` seconds as the plan-selected long server timeout. Bun documents seconds (default 120); the hub wake loop remains authoritative for its own idle close policy.
**Verification evidence**:
- `bunx biome check --write apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/realtime-bun.ts apps/api/src/realtime-bun.test.ts` — exit 0.
- `bunx biome check apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/realtime-bun.ts apps/api/src/realtime-bun.test.ts` — exit 0.
- `bunx vitest run apps/api/src/realtime-bun.test.ts apps/api/src/server.test.ts` — exit 0; 2 files, 18 tests passed.
- `bunx vitest run apps/api` — exit 1; 3 files passed, 1 failed; 49 passed, 1 failed of 50 tests. The failure is in plan 09 `apps/api/src/mail-event-hub.test.ts:275`: its subscription setup reaches `packages/infrastructure/src/realtime/hub.ts:411` and throws `ReferenceError: MAX_SUBSCRIPTIONS is not defined`.
- `bun run --cwd apps/api typecheck` — exit 2; plan 09 `apps/api/src/worker.test.ts:725` reports TS2349 (`never` not callable), and plan 08 `packages/infrastructure/src/realtime/hub.ts:411` reports TS2304 (`MAX_SUBSCRIPTIONS` is not defined).
- `bunx biome check apps/api/src` — exit 1; plan 09 `apps/api/src/worker.test.ts:682` reports `noConstAssign` for reassignment of `release`.
- `wc -l apps/api/src/server.ts apps/api/src/realtime-bun.ts` — exit 0; 329 and 140 lines.
**Unresolved**: End-to-end `next` delivery cannot be verified until the plan 08 hub runtime error is fixed. The full API gates also fail in plan 09 files listed above. No out-of-scope files were edited.

### Session: 2026-10-07 (foreground verification recheck)
**Tasks Completed**: Re-ran the exact plan verification commands and the scoped tests/checks after concurrent API edits settled. The prior API test count and the plan 09 diagnostics changed between attempts; this entry records the latest run.
**Verification evidence**:
- `bunx vitest run apps/api` — exit 1; 3 files passed, 1 failed; 50 passed, 1 failed of 51 tests. The failure is `apps/api/src/mail-event-hub.test.ts:280`; it reaches the out-of-scope plan 08 reference `packages/infrastructure/src/realtime/hub.ts:332` (`MAX_SUBSCRIPTIONS` is undefined).
- `bun run --cwd apps/api typecheck` — exit 2; only reports `packages/infrastructure/src/realtime/hub.ts:332:11` (`TS2304: Cannot find name 'MAX_SUBSCRIPTIONS'`).
- `bunx biome check apps/api/src` — exit 1; only reports a formatting difference at `apps/api/src/worker.test.ts:1002` (plan 09).
- `wc -l apps/api/src/server.ts apps/api/src/realtime-bun.ts` — exit 0; 329 and 140 lines.
- `bunx vitest run apps/api/src/realtime-bun.test.ts apps/api/src/server.test.ts` — exit 0; 2 files, 18 tests passed.
- `bunx biome check apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/realtime-bun.ts apps/api/src/realtime-bun.test.ts` — exit 0; 4 files clean.
**Unresolved**: The required end-to-end `next` event delivery assertion remains blocked by the missing `MAX_SUBSCRIPTIONS` constant outside plan 10. Full API typecheck and Biome remain blocked by files outside this plan. No out-of-scope files were edited.

### Session: 2026-10-08 (Opus review fixes)
**Tasks Completed**: Added a local-app executor injection seam for deterministic adapter-level testing, then exercised the real Bun connection lifecycle, Bearer authentication, subscription, ingest write, notifier poke, drain, event `next`, and LIVE marker. Wrapped Bun open/message/close callbacks against async failures, logging and closing failed sockets with 1011. Moved test mock cleanup to `afterEach` and added adapter failure coverage.
**Verification evidence**: `bunx vitest run apps/api` passed (5 files, 55 tests); `bun run --cwd apps/api typecheck` and `bunx biome check apps/api/src` exited 0; `apps/api/src/server.ts` and `realtime-bun.ts` are 333 and 171 lines. Full repository verification passed: `bun run typecheck`, `bunx biome check . --diagnostic-level=warn`, and `bun run test` (154 files/2,002 root tests plus 26 files/299 web tests). `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun` exited 0 and listed the `MAIL_EVENT_HUB` binding.
**Notes**: The Bun integration test injects a deterministic executor at the GraphQL boundary because the Node test runtime exposes duplicate GraphQL module instances; the production executor remains the default.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
