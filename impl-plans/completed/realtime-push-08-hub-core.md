# Realtime Push 08: Runtime-Neutral Hub Core (Protocol, Drain, Upgrade Checks, In-Process Host)

**Status**: Completed
**Plan ID**: realtime-push-08-hub-core
**Wave**: 3 (phase 24)
**Depends On**: realtime-push-01-contracts-and-persistence, realtime-push-05-graphql-surface-and-executor
**Design Reference**: design-docs/specs/design-realtime-push.md sections 4.4, 4.5 (cursor validation), 6.1-6.7, 7.1-7.5, 8.1, 8.3 (in-process host), decisions D1, D2, D8, D13
**Created**: 2026-10-08

## Intent and context

This plan implements the server half of `graphql-transport-ws` once, for
both runtimes:

- the message state machine (design 6.2);
- the single drain loop (6.4);
- heartbeat and timeout sweeps (6.5);
- close codes (6.6) and limits (6.7);
- per-pass principal re-resolution and per-event authorization (7.3);
- the pre-upgrade checks (7.1).

It also provides the in-process host used by Bun and by every test.

Plan 09 (Durable Object) and plan 10 (Bun) only adapt sockets and storage
to the `RealtimeHost` interface.

Inputs from earlier plans:

| Input | Source |
|-------|--------|
| `MailEventLog`, `resolveViewerFromTokenHash`, `hasAnyMailRead`, cursor helpers, `MAIL_EVENT_HUB_*` constants | plan 01 |
| `SubscriptionExecutor`, `MailEventPayload` | plan 05 (`packages/infrastructure/src/realtime/executor.ts`, `mail-event-payload.ts`) |
| `authorizesAnyAddress` | existing, `policies/authorization.ts:199` |

## Non-goals

- No Cloudflare or Bun types. Only the interfaces below.
- Do not edit `executor.ts`, `mail-event-payload.ts`, `http/*` or
  `graphql/*`.
- No delivery of mail content beyond what the executor produces.

## writePaths

- packages/infrastructure/src/realtime/protocol.ts (new)
- packages/infrastructure/src/realtime/protocol.test.ts (new)
- packages/infrastructure/src/realtime/host.ts (new)
- packages/infrastructure/src/realtime/hub.ts (new)
- packages/infrastructure/src/realtime/drain.ts (new)
- packages/infrastructure/src/realtime/hub.test.ts (new)
- packages/infrastructure/src/realtime/drain.test.ts (new)
- packages/infrastructure/src/realtime/upgrade.ts (new)
- packages/infrastructure/src/realtime/upgrade.test.ts (new)
- packages/infrastructure/src/realtime/in-process-host.ts (new)
- packages/infrastructure/src/realtime/hub-test-support.ts (new)
- impl-plans/completed/realtime-push-08-hub-core.md (progress log only)

sharedPaths: none. The `./realtime/*` export already exists from plan 05.

## Pinned contracts (plans 09 and 10 code against these)

```ts
// host.ts
export interface HubConnection { readonly id: string }
export interface UpgradeInfo { readonly clientIp: string | null; readonly cookieTokenHash: string | null }
export interface SubscriptionState { readonly id: string; readonly query: string; readonly operationName: string | null;
  readonly variables: Record<string, unknown> | null; readonly scope: MailEventScope; lastSeq: number; live: boolean }
export interface ConnectionState { readonly v: 1; readonly connId: string; readonly clientIp: string | null;
  readonly cookieTokenHash: string | null; readonly openedAt: number; readonly initDeadline: number; acked: boolean;
  principal: { readonly tokenHash: string; readonly kind: "USER" | "API_KEY"; readonly id: string } | null;
  lastMessageAt: number; subscriptions: SubscriptionState[] }
export interface RealtimeHost {
  listConnections(): readonly HubConnection[];
  loadState(conn: HubConnection): Promise<ConnectionState | null>;
  saveState(conn: HubConnection, state: ConnectionState): Promise<void>;
  deleteState(conn: HubConnection): Promise<void>;
  send(conn: HubConnection, text: string): void;
  close(conn: HubConnection, code: number, reason: string): void;
  lastAutoResponseAt(conn: HubConnection): number | null;   // DO ping auto-response; null in-process
  scheduleWake(atMs: number | null): void;                   // null = cancel
  now(): number;
}
// hub.ts
export type AdmitResult = "OK" | "IP_LIMIT" | "GLOBAL_LIMIT";
export interface RealtimeHub {
  rehydrate(): Promise<void>;                     // rebuild map from host; call before any other method after wake
  admit(clientIp: string | null): AdmitResult;    // before accepting a socket
  open(conn: HubConnection, info: UpgradeInfo): Promise<void>;
  message(conn: HubConnection, data: string | ArrayBuffer): Promise<void>;
  closed(conn: HubConnection): Promise<void>;
  requestDrain(): Promise<void>;
  wake(): Promise<void>;                          // sweep + safety drain + reschedule
}
export function createRealtimeHub(options: { readonly host: RealtimeHost; readonly deps: AppDependencies;
  readonly usecases: UseCases; readonly executor: SubscriptionExecutor }): RealtimeHub;
// upgrade.ts
export function isRealtimeUpgradeRequest(request: Request): boolean;   // GET, pathname "/graphql", Upgrade: websocket (case-insensitive)
export function checkRealtimeUpgrade(request: Request, options: { readonly publicOrigin: string | null;
  readonly clientIp: string | null; readonly rateLimiter: RateLimiter | null; readonly tokenHasher: TokenHasher })
  : Promise<{ readonly ok: false; readonly response: Response } | { readonly ok: true; readonly info: UpgradeInfo }>;
export const SUBPROTOCOL = "graphql-transport-ws";
// in-process-host.ts
export function createInProcessHost(options?: { now?: () => number; setTimeout?: ..., clearTimeout?: ... }): RealtimeHost & {
  attach(socket: { send(text: string): void; close(code: number, reason: string): void }): HubConnection;
  detach(conn: HubConnection): void;
  setWakeHandler(handler: () => Promise<void>): void };   // late binding: host is built before the hub
export function createLateBoundMailEventNotifier(): MailEventNotifier & { bind(target: { requestDrain(): Promise<void> }): void };
```

## Behaviour (design sections in brackets)

### `protocol.ts`

- Constants:
  - `MAX_FRAME_BYTES = 16384`, measured in UTF-8 bytes;
  - `MAX_SUBSCRIPTIONS = 4`;
  - `INIT_TIMEOUT_MS = 10000`;
  - `IDLE_TIMEOUT_MS = 75000`;
  - `SAFETY_DRAIN_MS = 60000`;
  - `REPLAY_PAGE = 200`;
  - `MAX_CONN_PER_IP = 20`, `MAX_CONN_PER_PRINCIPAL = 10`,
    `MAX_CONN_TOTAL = 1000`;
  - `CloseCode` with every code from 6.6.
- `parseClientMessage(data)` returns a typed message or `{ error: "TOO_BIG" | "BAD_REQUEST" }`.
  - A binary frame is `BAD_REQUEST`.
  - The size check runs **before** `JSON.parse`.

### State machine (6.2), in `hub.ts`

- `open`: create the state with `initDeadline = now + 10 s`, save it, and
  `scheduleWake` at the earliest deadline.
- Close mapping:
  - `TOO_BIG` closes 1009.
  - `BAD_REQUEST` and an unknown type close 4400.
- `connection_init`:
  - A second init closes 4429.
  - Payload validation as in design 6.2.
  - With an `authorization` string: it must start with `Bearer `, else
    4401. Resolve with `usecases.resolveViewerFromToken(token)`, then store
    `tokenHash = await deps.tokenHasher.hash(token)`.
  - Without `authorization`: resolve `cookieTokenHash` through
    `resolveViewerFromTokenHash(hash, { recordUsage: false })`.
  - `null` viewer closes 4401. `!hasAnyMailRead(viewer)` closes 4403.
  - Per-principal attempt limit: `deps.rateLimiter?.limit("ws:init:" + kind + ":" + id)`;
    `false` closes 1013.
  - Concurrent acked connections for the same principal `>= 10` closes
    1013.
  - On success: `acked = true`, save, send `{"type":"connection_ack"}`.
- `subscribe`:
  - Not acked closes 4401. A duplicate id closes 4409.
  - The fifth subscription gets an `error` with `RATE_LIMITED`.
  - Re-resolve the viewer, then call
    `executor.prepare({ query, operationName, variables }, viewer)`. Errors
    produce an `error` message and the socket stays open.
  - **scope and after come from this subscription's own `prepared`**
    (F1).
  - Cursor validation (4.5), using `mailEventLog.state()` and
    `parseMailEventCursor`:
    - unparsable gives `BAD_USER_INPUT`;
    - an epoch mismatch, `seq < prunedThroughSeq` or `seq > headSeq`
      gives `RESYNC_REQUIRED` (the exact message from design 4.5);
    - no `after` gives `lastSeq = headSeq`.
  - Store the subscription with `live: false`, save, `requestDrain()`.
- `complete` removes the subscription. `ping` sends `pong`. `pong` is
  ignored. Every frame updates `lastMessageAt`.
- `closed` deletes the state.

### Drain (6.4), in `drain.ts`

Follow the design pseudo-code **exactly**:

- **Single flight.** One drain at a time. A call during a drain sets
  `dirty` and returns the running promise.
- **Read.** `from = min(lastSeq)` over all subscriptions of acked
  connections, then `listAfter(from, 200)`.
- **Principals.** If rows were read, re-resolve each distinct principal
  once, through `resolveViewerFromTokenHash(tokenHash, { recordUsage: false })`.
  - `null` closes every connection of that principal with 4401.
  - No MAIL_READ closes them with 4403.
- **Per subscription and row, ascending, where `row.seq > sub.lastSeq`:**
  - deliver when the scope matches (`domainId` equal, or `address`
    included in `row.addresses`) and
    `authorizesAnyAddress(viewer, MailRead, row.domainId, row.addresses)`
    holds;
  - delivery means `executor.execute(prepared, payload, viewer)`, then send
    `{"id", "type":"next", "payload": result}`;
  - then set `sub.lastSeq = row.seq`, whether or not it was delivered.
- **LIVE.** If `rows.length < 200`, every non-live subscription gets a
  LIVE `next`:
  - `cursor = formatMailEventCursor(epoch, sub.lastSeq)`;
  - `occurredAt` = now, as an ISO string;
  - `messageId` and `domainId` null, `addresses` `[]`.

  Then set `live = true`.
- **Persist** every changed state. Loop while `rows.length === 200 || dirty`.
- **Cursor of a delivered row:** `formatMailEventCursor(state.epoch, row.seq)`.
  Read the epoch once per drain via `mailEventLog.state()`.
- **Prepared cache.** Keep `PreparedSubscription` in an in-memory map keyed
  by `connId + "\u0000" + subId`. After `rehydrate`, rebuild each entry on
  first use from the stored `query`, `operationName` and `variables`.

  Never share an entry between subscriptions.

### Sweep and wake (6.5), `wake()`

- Close connections whose `initDeadline` has passed while not acked with
  4408.
- Close connections whose `max(lastMessageAt, lastAutoResponseAt) + 75 s <
  now` with 4000.
- Run `requestDrain()`.
- Reschedule:
  - the earliest pending `initDeadline`, otherwise
  - `now + 60 s` while any connection exists, otherwise
  - `null`.

### `admit`

Count states by `clientIp` (`>= 20` gives `IP_LIMIT`) and in total
(`>= 1000` gives `GLOBAL_LIMIT`).

### Upgrade checks (7.1), in `upgrade.ts`

Order:

1. The subprotocol header lists `graphql-transport-ws`, otherwise 400.
2. `isCrossOriginRequest(request, publicOrigin)` (`http/auth-middleware.ts:74`)
   is true, so 403.
3. `rateLimiter?.limit("ws:connect:" + (clientIp ?? "unknown"))` is
   `false`, so 429.
4. `cookieTokenHash`: computed only when an `Origin` header is present and
   passed step 2. Use `extractSessionCookie` (`auth-middleware.ts:92`),
   then `tokenHasher.hash`.

Responses are plain `text/plain` with no echo of request data.

### In-process `scheduleWake` timer semantics (F-RP-A)

The in-process host must actually call `hub.wake()` when its timer fires.

- **`scheduleWake(atMs)`**
  - Always clear the previous timer first; there is at most one armed
    timer.
  - `null`: only clear.
  - Otherwise: arm `options.setTimeout(Math.max(0, atMs - now()))`.
- **When the timer fires**
  - With a bound handler: call it, and catch a rejection with
    `console.error("Realtime wake failed")`. Log no secrets.
  - Without a bound handler: do nothing.
- **`setWakeHandler(handler)`**
  - Replaces any previous handler.
  - Binding after a timer was armed is fine: the handler is read when the
    timer fires.
- **Callers:** plan 10 binds `host.setWakeHandler(() => hub.wake())`. The
  Durable Object host (plan 09) does not use this; its `alarm()` calls
  `hub.wake()`.

### Late-bound notifier

`notify()` before `bind` is a no-op. After `bind`, it calls
`target.requestDrain()` and catches and logs rejections.

## Pitfalls

- Never log tokens, cookies, `connection_init` payloads, variables or
  addresses. Log `connId` and code only.
- `send` and `close` on an already-closed connection must not throw; guard
  with try/catch in the hub.
- Persist `lastSeq` after each page, not only at the end, so a crash
  between pages replays at most one page. Client dedupe covers it.
- Do not let one connection's executor error abort the drain for others.
- **Branded types for authorization.** `row.addresses` are plain strings
  and `row.domainId` is stored text. Convert them with the domain factories
  (`createEmailAddress`, and the `DomainId` brand helper from
  `value-objects/ids`) before calling `authorizesAnyAddress`. Skip an
  address that fails parsing; never cast it.
- Close the connections of an invalid principal **before** delivering any
  row in that pass.
- Each file must stay under 400 lines. Split `drain.ts` from `hub.ts` as
  listed.

## Tests (in-process host, plan 01 fakes, plan 05 executor, fake clock via `hub-test-support.ts`)

**`protocol.test.ts`**
- 16384 bytes -> parsed. 16385 bytes -> `TOO_BIG`.
- Invalid JSON, or a binary frame -> `BAD_REQUEST`.

**`hub.test.ts`**
- No init within 10 s, then `wake()` -> close 4408.
- **Timer-driven, F-RP-A.** Do not call `wake()` by hand.
  - Setup: vitest fake timers, and
    `createInProcessHost({ now: () => Date.now(), setTimeout, clearTimeout })`
    using the faked globals. Call `host.setWakeHandler(() => hub.wake())`,
    then `open` with no init.
  - `vi.advanceTimersByTimeAsync(10_000)` -> the socket is closed with 4408.
  - A second case: an acked connection with no frames, advanced by
    `75_000` plus one safety interval -> closed with 4000.
- **In-process host scheduling**
  - `scheduleWake(t1)` then `scheduleWake(t2)` -> only one timer fires.
  - `scheduleWake(null)` -> nothing fires.
  - No handler bound -> the timer firing is a no-op.
  - A handler that rejects -> logged, no unhandled rejection.
- Subscribe before ack -> 4401.
- Init without a credential and without a cookie hash -> 4401.
- A Bearer key with MAIL_READ -> ack. A key with only MAIL_SEND -> 4403.
- Cookie-hash path -> ack.
- A second init -> 4429.
- A duplicate subscription id -> 4409.
- The fifth subscription -> `error` with `RATE_LIMITED`.
- 16385-byte frame -> 1009.
- `ping` -> `pong`.
- 76 s idle, then `wake()` -> 4000.
- The 11th acked connection of one principal -> 1013.
- The rate limiter denies `ws:init:...` -> 1013.

**`drain.test.ts`** (ordering)
- 5 events appended, then subscribe with `after = cursor(2)` -> `next` for
  3, 4, 5 in order, then LIVE with `cursor(5)`.
- Appends injected between `listAfter` pages (a 450-event backlog) and
  during `execute` -> every matching row above the cursor is delivered
  exactly once, in strictly increasing seq, and LIVE appears once, after
  the replayed rows and before later rows.
- Duplicate and reordered pokes (`requestDrain` called 5 times during a
  drain) -> no duplicates.
- A lost poke (append without `requestDrain`), then `wake()` -> delivered.
- Scope: subscriptions with identical query text and `scope.domainId` A and
  B -> each sees only its own domain's rows (F1 at hub level).
- Authorization:
  - a row outside the viewer's permissions is never sent;
  - a permission revoked between two appends stops delivery on the next
    pass, without reconnect;
  - a key revoked (fake resolver returns null) -> 4401.
- Cursor validation:
  - epoch mismatch, `seq < pruned`, `seq > head` -> `RESYNC_REQUIRED`;
  - `seq == pruned` -> accepted;
  - malformed -> `BAD_USER_INPUT`.
- Hibernation simulation: a new hub on the same host storage, then
  `rehydrate()`, then a new event is delivered after the prior `lastSeq`,
  with no duplicates.

**`upgrade.test.ts`**
- Missing subprotocol -> 400.
- Cross-origin or malformed `Origin` -> 403.
- Absent `Origin` with a cookie -> ok and `cookieTokenHash` null.
- Matching `Origin` with a cookie -> the hash of the cookie value, never
  the raw value.
- Limiter denies -> 429.
- `isRealtimeUpgradeRequest` false for POST, for another path, and without
  an `Upgrade` header.

## Verification (repo root)

1. `bunx vitest run packages/infrastructure/src/realtime`: exit 0.
2. `bun run --cwd packages/infrastructure typecheck`: exit 0.
3. `bunx biome check packages/infrastructure/src/realtime`: exit 0.
4. `wc -l packages/infrastructure/src/realtime/*.ts`: every file is under
   400 lines.

## Done criteria

- [x] The pinned contracts are exported exactly.
- [x] Every test listed above passes.
- [x] Verification steps 1-4 are recorded.

## Progress Log

### Session: 2026-10-08
**Tasks Completed**: Implemented the runtime-neutral protocol parser, connection host contract and subscription handler, hub lifecycle/auth/admission/sweep, single-flight replay/live drain, upgrade validation and in-process host/notifier. Added protocol, hub, drain and upgrade tests covering close behavior, cursor validation, per-event MAIL_READ, scope isolation, gap-free replay/live ordering, wake recovery, and timer-driven expiry. Split protocol handling across the assigned `protocol.ts`, `host.ts` and `hub.ts` paths so every realtime TypeScript file remains below 400 lines.
**Hashes**: Current source SHA-256 values are recorded in `tmp/realtime-push-s306/realtime-push-08-hub-core/attempt-1/final-source-sha256.txt`; pre-plan hash in `pre-plan-progress-sha256.txt` and post-plan hash is recorded after this update.
**Verification evidence**: Stable final-source logs in `tmp/realtime-push-s306/realtime-push-08-hub-core/attempt-1/`: `stable-vitest.log` (5 files, 38 tests passed), `stable-typecheck.log`, `stable-biome.log`, and `stable-line-counts.log` (largest file is `hub.ts` at 399 lines). All four commands exited 0. Plans 09 and 10 own runtime adapters and integration; no adapter wiring was pulled into plan 08.

### Session: 2026-10-08 (plan 05 handoffs)
**Tasks Completed**: Confirmed subscription preparation failures are caught and returned as graphql-ws `error` messages without closing the socket; added an invalid-document regression that then successfully subscribes on the same connection. Made per-row `authorizesAnyAddress` explicit in the drain before filtering the payload to individually readable addresses; added coverage for skipping a denied row, advancing `lastSeq`, and delivering a later authorized row.
**Verification evidence**: `bunx vitest run packages/infrastructure/src/realtime` (5 files, 40 tests passed), `bun run --cwd packages/infrastructure typecheck`, and `bunx biome check packages/infrastructure/src/realtime --diagnostic-level=warn` all exited 0. `wc -l packages/infrastructure/src/realtime/*.ts` reported every file below 400 lines; largest file is `hub.ts` at 399 lines.

### Session: 2026-10-08 (independent security review fixes)
**Tasks Completed**: Updated the drain to use the hub's in-memory state accessor, drop revoked connections before deriving replay cursors, resolve principals even when no subscriptions exist, and save only still-current state. Added subscription-presence checks around preparation, execution, and sends. Added per-connection message serialization with synchronous init and subscription reservations, open-time cap enforcement, and rejection recovery for queued messages. Made upgrade limiter failures fail open, rejected empty Origin for cookie authentication, and added the early frame-length guard.
**Regression coverage added**: Revoked principal with 250 queued rows alongside a valid principal; copied host load results and deleted state during execution; complete during execution; revoked principal with no subscriptions; concurrent init and subscription bursts; open cap burst; limiter rejection; empty Origin cookie auth; and oversized input without encoding.
**Contract changes**: No changes to `RealtimeHost`, `ConnectionState`, or `createRealtimeHub` signatures. Added backward-compatible message processor exports from `host.ts`, implemented in `hub-message-processor.ts`, plus private drain helpers in `drain-helpers.ts` to keep each realtime file under 400 lines.
**Verification evidence**: `bunx vitest run packages/infrastructure/src/realtime` passed (6 files, 50 tests); `bun run --cwd packages/infrastructure typecheck` exited 0; `bunx biome check packages/infrastructure/src/realtime --diagnostic-level=warn` checked 17 files with no diagnostics; `wc -l packages/infrastructure/src/realtime/*.ts` reported every file below 400 lines (maximum 397, `hub.ts`). All requested checks were run in the foreground after formatting.

### Session: 2026-10-08 (Opus review fixes)
**Tasks Completed**: Guarded persisted state against connections closed during in-flight authentication or message persistence; avoid consuming init limiter capacity after a closed connection; made message processing close with 4500 on internal persistence failure; made subscription-triggered and follow-up drain requests logged fire-and-forget; made init limiter failures fail open; removed queued subscription ID/count reservations in favor of serialized in-handler checks. Added regressions for closed-during-auth, failing persistence/drains, fail-open limiter behavior, invalid earlier subscriptions, and pipelined complete/resubscribe.
**Verification evidence**: `bunx vitest run packages/infrastructure/src/realtime` passed (7 files, 56 tests); `bun run --cwd packages/infrastructure typecheck` exited 0; `bunx biome check packages/infrastructure/src/realtime` exited 0; all realtime TypeScript files are below 400 lines (maximum 397, `hub.test.ts`). Full repository verification also passed: `bun run typecheck`, `bunx biome check . --diagnostic-level=warn`, and `bun run test` (154 files/2,002 root tests plus 26 files/299 web tests).

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
