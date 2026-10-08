# Realtime Push 09: Worker Upgrade Routing, MailEventHub Durable Object and Wrangler

**Status**: Ready
**Plan ID**: realtime-push-09-worker-durable-object
**Wave**: 4 (phase 25)
**Depends On**: realtime-push-01-contracts-and-persistence, realtime-push-05-graphql-surface-and-executor, realtime-push-08-hub-core
**Design Reference**: design-docs/specs/design-realtime-push.md sections 6.5 (auto-response), 7.1 (forwarded request), 8.2, 8.4 (Worker notifier and `waitUntil(settle())`), 9.1, 9.2, 9.4
**Created**: 2026-10-08

## Intent and context

This plan runs the hub core (plan 08) inside one hibernating Durable
Object. It routes WebSocket upgrades from the Worker to that object, wires
the Durable Object notifier (plan 01) so writers poke after their D1
commit, and declares the binding and migration in `wrangler.toml`.

## Non-goals

- No changes to the hub core, the executor or `http/*`. No Bun server
  changes (plan 10).
- No deploy and no remote wrangler. Use the dry run only.
- Do not add a cron trigger or a new rate-limit binding.

## writePaths

- apps/api/src/durable-object-types.ts (new)
- apps/api/src/mail-event-hub.ts (new)
- apps/api/src/mail-event-hub.test.ts (new)
- apps/api/src/worker-config.ts (new; `buildWorkerConfig` moves here)
- apps/api/src/worker.ts
- apps/api/src/worker.test.ts
- apps/api/src/env.ts
- apps/api/wrangler.toml
- impl-plans/active/realtime-push-09-worker-durable-object.md (progress log only)

sharedPaths: none.

## File-level changes

### `durable-object-types.ts`

Structural types only. Do not import `@cloudflare/workers-types` into
runtime code.

- `DurableObjectStateLike`, with:
  - `acceptWebSocket(ws, tags?)`
  - `getWebSockets(tag?)`
  - `setWebSocketAutoResponse(pair)`
  - `getWebSocketAutoResponseTimestamp(ws): Date | null`
  - `blockConcurrencyWhile(fn)`
  - `storage: { get<T>(key), put(key, value), delete(key), list<T>({ prefix }): Promise<Map<string, T>>, setAlarm(ms), deleteAlarm() }`
- `HibernatableWebSocketLike`: `send`, `close`, `serializeAttachment`,
  `deserializeAttachment`.
- `DurableObjectNamespaceLike`: re-export plan 01's type from
  `@flying-mail/adapter/realtime/mail-event-notifiers`.

### `env.ts`

- `Env` gains `MAIL_EVENT_HUB?: DurableObjectNamespaceLike` and
  `FLYING_MAIL_EVENT_RETENTION_SECONDS?: string`.
- `envToRecord` includes the new variable.

### `worker-config.ts`

- Move `buildWorkerConfig` here, with this pinned signature:

  ```ts
  buildWorkerConfig(env: Env, options?: { readonly mailEventNotifier?: MailEventNotifier | null }): BuildDependenciesConfig
  ```

  - It adds `eventRetentionSeconds: resolveEventRetentionSeconds(record)`.
  - It sets `mailEventNotifier` only when `options.mailEventNotifier` is
    non-null.
  - It **never constructs a notifier itself**.
- Pinned:
  `buildWorkerNotifier(env: Env): (MailEventNotifier & { settle(): Promise<void> }) | null`.
  It returns `createDurableObjectMailEventNotifier(env.MAIL_EVENT_HUB)` when
  the binding exists, and `null` otherwise.
- **Single-instance ownership (F-RP-C)**
  - `getOrBuildWorker` calls `buildWorkerNotifier(env)` exactly once per
    isolate.
  - It passes the result into `buildWorkerConfig(env, { mailEventNotifier
    })`.
  - It stores the same object as `BuiltWorker.notifier`.
  - The Durable Object calls `buildWorkerConfig(env)` with no notifier.
    The hub never writes mail, so it gets the no-op default.
- `worker.ts` re-exports `buildWorkerConfig` so the existing
  `worker.test.ts` imports keep working.

### `worker.ts`

- `export { MailEventHub } from "./mail-event-hub";` next to the default
  export.
- `BuiltWorker` gains `notifier: { settle(): Promise<void> } | null`.
- **`fetch`**, before `worker.app.fetch`, if `isRealtimeUpgradeRequest(request)`:
  1. No `env.MAIL_EVENT_HUB`: return 503 (plain text).
  2. Normalize the client IP exactly as the existing `resolveClientIp`
     does: `normalizeClientIpForRateLimit(request.headers.get("cf-connecting-ip")?.trim() || null)`.
  3. `checkRealtimeUpgrade(request, { publicOrigin: deps.instanceConfig.publicOrigin, clientIp, rateLimiter: deps.rateLimiter, tokenHasher: deps.tokenHasher })`.
     Not ok: return its response.
  4. Build a **new** `Headers` holding only:
     - `Upgrade: websocket`
     - `Sec-WebSocket-Protocol: graphql-transport-ws`
     - `x-flying-mail-client-ip`, when an IP exists
     - `x-flying-mail-session-token-hash`, when the hash exists

     Copy nothing from the client request: no cookie, and no client-supplied
     `x-flying-mail-*` header.
  5. `const stub = env.MAIL_EVENT_HUB.get(env.MAIL_EVENT_HUB.idFromName(MAIL_EVENT_HUB_NAME))`.
     Return
     `stub.fetch("https://mail-event-hub.internal/connect", { method: "GET", headers })`
     directly.
     - The first argument is a **URL string**. This matches plan 01's
       pinned `DurableObjectNamespaceLike` `fetch(input: string, init?:
       RequestInit)`. Do not pass a `Request` object, and do not edit plan
       01's type.
     - Never pass the result through the hono app.
- `BuiltWorker` must expose `deps` (for `checkRealtimeUpgrade`); add it.
- **After `app.fetch` resolves** in `fetch`, and in `email` in a `finally`:
  `ctx.waitUntil(notifier.settle())` when a notifier exists. The response is
  returned unchanged.

### `mail-event-hub.ts`

`export class MailEventHub { constructor(ctx: DurableObjectStateLike, env: Env) }`.
This is a plain class; it does **not** extend `DurableObject`.

- **Constructor**
  - `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))`.
  - Every Workers-only construct goes through a small injectable
    `runtime` object: the second constructor parameter, defaulting to the
    Workers globals. Pinned shape:

    ```ts
    interface HubRuntime {
      createAutoResponsePair(request: string, response: string): unknown;               // default: new WebSocketRequestResponsePair(...)
      createSocketPair(): { readonly client: HibernatableWebSocketLike; readonly server: HibernatableWebSocketLike }; // default: Object.values(new WebSocketPair())
      createUpgradeResponse(client: HibernatableWebSocketLike): Response;               // F-RP-C
    }
    ```

  - The default `createUpgradeResponse` is the **only** place that builds
    `new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" } } as ResponseInit)`.
    The `as ResponseInit` cast is confined to this one default.
    - Status 101 throws `RangeError` under Node, where vitest runs.
    - `webSocket` is not part of `ResponseInit` under the repo's
      `types: ["bun"]`.
    - So tests always inject a fake runtime and never touch the default.
  - Lazily build `deps`, `usecases`, the schema (`buildGraphQLSchema()`),
    the executor and the hub. Use
    `buildDependencies(buildWorkerConfig(env))` and cache on the instance.
  - `ctx.blockConcurrencyWhile(() => hub.rehydrate())` on first use.
- **Host adapter** (`RealtimeHost`, from plan 08)
  - Connection id: the `connId` from `ws.deserializeAttachment()`.
  - `listConnections`: `ctx.getWebSockets()`.
  - `loadState`, `saveState`, `deleteState`: `ctx.storage` key
    `conn:<connId>`.
  - `lastAutoResponseAt`: `getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null`.
  - `scheduleWake(ms)`: `setAlarm(ms)`, or `deleteAlarm()` when null.
  - `send` and `close` wrap the socket in try/catch.
- **`fetch(request)`**, by URL pathname:
  - `/notify` POST: `await hub.requestDrain()`, then 204.
  - `/connect` with `Upgrade`:
    1. `hub.admit(ip)`: `IP_LIMIT` returns 429, `GLOBAL_LIMIT` returns 503.
    2. `const { client, server } = runtime.createSocketPair()`.
    3. `ctx.acceptWebSocket(server, ["ip:" + (ip ?? "unknown")])`.
    4. `server.serializeAttachment({ connId })`, with `connId =
       crypto.randomUUID()`.
    5. `await hub.open(conn, { clientIp, cookieTokenHash })`.
    6. `return runtime.createUpgradeResponse(client)`. Never construct a
       101 `Response` inline.
  - Anything else: 404.
- **`webSocketMessage(ws, data)`**: `hub.message`.
  **`webSocketClose` / `webSocketError`**: `hub.closed`.
  **`alarm()`**: `hub.wake()`.

### `wrangler.toml`

Add exactly the design 9.1 block:

- `[[durable_objects.bindings]]` with `name = "MAIL_EVENT_HUB"` and
  `class_name = "MailEventHub"`.
- `[[migrations]]` with `tag = "v1-mail-event-hub"` and
  `new_sqlite_classes = ["MailEventHub"]`.
- A commented `FLYING_MAIL_EVENT_RETENTION_SECONDS` under `[vars]`.

Do not change any existing key.

## Pitfalls

- The 101 response must bypass `applySecurityHeaders` and the `/graphql`
  handler. Route it **before** `app.fetch`.
- Never forward the client's original request or headers to the Durable
  Object. A client could otherwise spoof `x-flying-mail-*`.
- The class name and migration tag are permanent. Use the exact strings
  above.
- The Durable Object must not import from `worker.ts`; that creates a
  module cycle. Import `buildWorkerConfig` from `worker-config.ts`.
- `waitUntil(settle())` must not delay or alter the response.
- Never create a second Durable Object notifier, for example inside
  `buildWorkerConfig`. A second instance means `settle()` does not await
  the real pokes.
- `stub.fetch` takes a URL string plus init, never a `Request` object.
- `apps/api/src/server.ts` is plan 10's. Do not touch it.

## Tests

**`mail-event-hub.test.ts`** uses a fake `DurableObjectStateLike` (an
in-memory storage `Map` and alarm), fake sockets, a fake `WebSocketPair`,
and an env whose `DB` is `createMigratedDatabase()` wrapped as a D1-like
binding. Alternatively, inject deps through an optional test hook; follow
how `worker.test.ts` builds its env.

All tests inject a fake `HubRuntime`. The fake `createUpgradeResponse`
records its argument and returns a marker `new Response("upgraded", {
status: 200 })`, which is Node-safe.

- The constructor registers the auto-response through
  `runtime.createAutoResponsePair('{"type":"ping"}', '{"type":"pong"}')`,
  with those exact strings.
- `/connect`:
  - `createUpgradeResponse` is called once, with the **client** half of the
    fake pair, and its marker response is returned unchanged.
  - The **server** half is accepted with tag `ip:203.0.113.9`.
  - The attachment holds `connId`.
  - The state is stored under `conn:<connId>`.
  - An alarm is set.
- A source-level guard: `grep -n "status: 101" apps/api/src/mail-event-hub.ts`
  finds exactly one match, inside the default `createUpgradeResponse`.
- The 21st connection from one IP gets 429.
- `/notify` returns 204 and runs a drain (an appended event reaches an
  acked subscription).
- Hibernation: create a **new** `MailEventHub` with the same fake ctx and
  storage, deliver a message to an existing socket, and the subscription
  continues from the stored `lastSeq`.
- `alarm()` closes an un-acked socket after 10 s with 4408.
- Unknown path returns 404.

**`worker.test.ts`** (extend):

- The env mapping includes `FLYING_MAIL_EVENT_RETENTION_SECONDS`.
- An upgrade without the binding returns 503.
- An upgrade with a cross-origin `Origin` returns 403, and the stub is not
  called.
- An upgrade with a matching `Origin`, a cookie, and a client-supplied
  `x-flying-mail-session-token-hash: forged` header. The fake stub captures
  `(input, init)`:
  - `input === "https://mail-event-hub.internal/connect"` (a string);
  - `init.method === "GET"`;
  - `init.headers` holds exactly `upgrade`, `sec-websocket-protocol`,
    `x-flying-mail-client-ip` and `x-flying-mail-session-token-hash`, the
    last equal to the server-computed hash and **not** `"forged"`;
  - no `cookie` header.
- A normal POST `/graphql` still goes to the app, and `ctx.waitUntil`
  received the `settle` promise.
- `email()` calls `waitUntil(settle())` when the binding exists.
- **Single notifier instance (F-RP-C).** Use a fake namespace whose stub
  `fetch` for `/notify` stays pending until the test resolves it.
  1. Trigger a mutation through the Worker `fetch` (or call
     `deps.mailEventNotifier.notify()` via the built worker), so a POST
     `/notify` is in flight.
  2. The promise given to `ctx.waitUntil` is still pending.
  3. Resolve the fake POST: the promise then resolves.
  4. Also assert `deps.mailEventNotifier === worker.notifier`; expose a
     test accessor if needed.
- Without the binding: `buildWorkerNotifier(env) === null`, and no
  `waitUntil(settle)` is registered.

## Verification (repo root)

1. `bunx vitest run apps/api`: exit 0.
   - Plan 10 edits `server.ts`, `server.test.ts` and `realtime-bun*.ts`
     concurrently.
   - If a failure is located only in those files, re-run after plan 10
     reports done.
   - Record both runs. The same applies to step 2.
2. `bun run --cwd apps/api typecheck`: exit 0.
3. `bunx biome check apps/api/src`: exit 0.
4. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`:
   exit 0. Record the log path. The output lists the `MAIL_EVENT_HUB`
   Durable Object binding.
5. `grep -n "v1-mail-event-hub\|MailEventHub\|MAIL_EVENT_HUB" apps/api/wrangler.toml`
   shows all three.

## Done criteria

- [ ] Upgrade routing, the Durable Object, the notifier settle and
      wrangler are done as specified.
- [ ] Verification steps 1-5 pass, with logs recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
