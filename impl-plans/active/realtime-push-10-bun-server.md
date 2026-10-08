# Realtime Push 10: Bun Server WebSocket Wiring (In-Process Fan-out)

**Status**: Ready
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
- impl-plans/active/realtime-push-10-bun-server.md (progress log only)

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

- [ ] Bun subscriptions work end to end in tests; Node returns 501.
- [ ] Verification steps 1-4 pass, with outputs recorded.

## Drift protocol

- Plan 09 edits other files in `apps/api/src` in the same wave. Never touch
  them.
- Record the sha256 of each file before and after editing it.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
