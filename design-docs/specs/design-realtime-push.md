# Real-time Push: Mail Event Log, GraphQL Subscriptions and Live Clients

Status: Accepted for implementation (2026-10-08).
Scope: a durable mail event log in D1, `Subscription.mailEvents` over
WebSocket using the `graphql-transport-ws` subprotocol, Durable Object
fan-out with the WebSocket Hibernation API on the Worker, an in-process
equivalent on the Bun server, live updates in the web client, and the
`flying-mail watch` CLI command.

Related documents: `design-graphql-api.md` (operation catalogue, error
codes), `design-security-model.md` (client IP, rate limiting, CSP, custom
domain), `design-api-keys-and-permissions.md` and
`design-user-mail-permissions.md` (MAIL_READ evaluation),
`design-deployment.md` (bindings, variables), `design-web-client.md`
(store, sidebar, rail), `command.md` (`watch`), `notes.md` ("Why no Durable
Objects", amended). Open user decisions, each with a default already
applied, are in `design-docs/user-qa/pending-realtime-push.md`.

---

## 1. Goals and non-goals

Goals:

1. Clients learn about mail changes without polling: the web client
   (session cookie) and API-key clients (agents, the CLI).
2. Reconnects lose nothing and repeat nothing. Every event has a cursor.
   Resubscribing with `after: <cursor>` replays missed events in order and
   then continues live.
3. Clients get an explicit signal (`RESYNC_REQUIRED`) when that guarantee
   cannot hold because the cursor is older than retention.
4. Authorization is exactly as strict as `message(id)`, and it is
   re-evaluated for every delivered event.
5. On the Worker, idle connections cost nothing (hibernation). The Bun
   server and the whole test suite run without Cloudflare.

Non-goals:

- Replacing the fetch-state pull cursor. `fetchStatus` and
  `markMessagesFetched` stay the lossless, exactly-once consumption path for
  agents. Subscriptions are a low-latency notification path. When an API
  client receives `RESYNC_REQUIRED`, it falls back to `fetchStatus`.
- Events for anything other than messages and drafts: tags, contacts,
  templates, domains, users and keys. See section 4.2.
- Subscriptions over HTTP (SSE or multipart). See section 5.3.
- WebSocket proxying in `flying-mail client serve` and on the Node runtime
  of `apps/api`. See section 11.

## 2. Baseline (verified against the code, 2026-10-08)

| Fact | Where | Consequence for this design |
|------|-------|-----------------------------|
| No WebSocket, SSE, Durable Object, `scheduled()` or `type Subscription` exists | repository-wide | Greenfield; no compatibility shims |
| The composition root is cached per isolate (`getOrBuildWorker`), and use cases never receive `ExecutionContext` | `apps/api/src/worker.ts:124-150` | The notifier is a dependency. `worker.ts` keeps the pokes alive through `ctx.waitUntil` (section 8.4) |
| `applySecurityHeaders` and the `/graphql` handler rebuild every `Response` | `http/security-headers.ts:33-51`, `http/app.ts:128` | A `101` response must not pass through the hono app. Upgrades are intercepted in `worker.ts` and `server.ts` before `app.fetch` (section 7.1) |
| The CSRF origin check runs only for cookie auth on non-safe methods | `http/auth-middleware.ts:74-90, 200-205` | The upgrade is a `GET`, so it gets its own Origin rule, reusing `isCrossOriginRequest` (section 7.1) |
| `resolveViewerFromToken(token)` hashes, then looks up a session first and an API key second | `application/src/usecases/auth.ts:17-60` | Split it so it can resolve by hash. The socket stores only the hash, and resolution stays the single existing path (section 7.2) |
| `authorizesAnyAddress(viewer, MAIL_READ, domainId, addresses)` with `addresses = [from, ...all recipients]` decides every message read | `policies/authorization.ts:199-221`, `usecases/messages.ts:109-138` | Each event row stores `domain_id` and exactly that address set (section 4.3) |
| `SqlDatabase` has `query`/`execute`/atomic `batch`; there is no interactive transaction | `ports/sql-database.ts:20-30` | Event append is one batch. It is sequenced after the state write rather than inside it (decision D6) |
| `RateLimiter.limit(key)`; Worker binding `AUTH_RATE_LIMITER` (10/60 s, fails open); in-memory on Bun | `ports/rate-limiter.ts`, `adapter/src/rate-limit/*` | Connection attempts reuse the port and binding with `ws:` key prefixes (section 7.4) |
| CSP has no `connect-src`; `default-src 'self'` | `security-headers.ts:21-31`, `apps/web/public/_headers` | Add `connect-src 'self'` and nothing else (section 9.3) |
| Vite proxies `/graphql` without `ws` | `apps/web/vite.config.ts` | Add `ws: true` for local development |
| `graphql@17.0.2` is installed; yoga runs `useDepthLimit(12)` and `useSelectionLimit(2000)` as parse hooks | `graphql/schema.ts:125-141` | The WebSocket executor uses graphql-js 17 `validateSubscriptionArgs` / `executeSubscriptionEvent`, and applies the same two limits itself |
| `app-store.ts` 768 lines, `schema.graphql.ts` 876, `commands/index.ts` 715, `usecases.ts` 693 | line counts | New code goes in new files (section 12) |
| `graphql-ws` is not in `bun.lock`; `bunfig.toml` enforces exact versions and a 3-day minimum release age | `bun.lock`, `bunfig.toml` | No new third-party dependency (decision D9) |

## 3. Architecture overview

```
 writers (use cases)                       D1 (single primary)
 ingest / send / sendDraft / saveDraft ...   mail_events (seq AUTOINCREMENT)
   1. state write(s)  ---------------------> messages, recipients, tags ...
   2. MailEventLog.append(batch) ----------> mail_events + prune
   3. MailEventNotifier.notify()  (poke, no payload)
            |
            v
 +---------------------------- fan-out host -----------------------------+
 | Worker: Durable Object "MailEventHub" (one instance, hibernation)     |
 | Bun:    in-process host (same hub core)                               |
 |                                                                       |
 |  hub core (packages/infrastructure/src/realtime)                      |
 |   drain(): read mail_events WHERE seq > min(sub.lastSeq) ORDER BY seq |
 |            re-resolve each principal, authorize each event,           |
 |            execute the subscription selection, send "next",           |
 |            advance sub.lastSeq                                        |
 +-----------------------------------------------------------------------+
            ^  graphql-transport-ws over wss://<public origin>/graphql
            |
   web client (cookie)        CLI `flying-mail watch` / agents (API key)
   @flying-mail/realtime-client (hand-written, zero dependencies)
```

The central decision is that **D1 is the only source of events**. A notify
carries no data. It only means "the log may have grown". The hub always
reads the log from each subscription's last cursor. Replay after a
reconnect and live delivery are therefore the same code path (section 6.4).
This removes the replay/live race, tolerates lost, duplicated and
reordered pokes, and makes a notify failure a latency problem rather than
a correctness problem.

## 4. Event model

### 4.1 Event types

| Type | Meaning | `message` field |
|------|---------|-----------------|
| `MESSAGE_RECEIVED` | An inbound message was stored, or a duplicate delivery added a new envelope recipient | Current message |
| `MESSAGE_SENT` | An outbound message reached its delivery outcome (`SENT` or `FAILED`), or a draft was sent | Current message |
| `MESSAGE_UPDATED` | Read/unread, tags (including the TRASH/ARCHIVED/STARRED system tags), spam verdict, or a retry of a failed send changed | Current message |
| `MESSAGE_DELETED` | A message was hard-deleted (purge from Trash) | `null` |
| `DRAFT_SAVED` | A draft was created or updated | Current draft |
| `DRAFT_DELETED` | A draft was discarded | `null` |
| `LIVE` | Control event, never stored. Sent once per subscription when the replay has caught up with the log head | `null` |

`LIVE` carries the subscription's current cursor. That gives every client a
resumable cursor even when no mail event arrives, and it marks the
replay/live boundary that clients use to trigger their catch-up refresh
(sections 10.3 and 10.4).

### 4.2 Writers

Events are emitted only by these use cases. The emission happens after
their last state write has resolved.

| Use case (file) | Event | Notes |
|-----------------|-------|-------|
| `receiveMessage` (`usecases/ingest.ts`) | `MESSAGE_RECEIVED` | On `STORED`. On `DUPLICATE`, only when `addEnvelopeRecipient` added a row. Never on `REJECTED`. This covers the Worker `email()` handler, the dev `POST /dev/inbound` route, and the external-mail fetch path, which ingests through `receiveMessage` |
| `sendMessage` (`usecases/send.ts`), and therefore `sendTemplatedMessage` | `MESSAGE_SENT` | One event, after `deliver()` has persisted `SENT` or `FAILED` |
| `retrySend` | `MESSAGE_UPDATED` | After the new delivery outcome is persisted |
| `sendDraft` (`usecases/drafts.ts`) | `MESSAGE_SENT` | Same message id as the draft. Clients move it out of Drafts |
| `saveDraft` (create and update) | `DRAFT_SAVED` | |
| `deleteDraft` (`usecases/delete-draft.ts`) | `DRAFT_DELETED` | The addresses are captured before the delete |
| `markRead`, `tagMessages`, `untagMessages`, `markSpam`, `markNotSpam` | `MESSAGE_UPDATED` | One event per affected message |
| `deleteMessages` | `MESSAGE_UPDATED` (moved to Trash) or `MESSAGE_DELETED` (purged) | For a purge, the addresses are captured before the delete |
| `applyClassificationRule` (`usecases/rules.ts`) | `MESSAGE_UPDATED` | Per affected message, appended per page |

Deliberately no events, and why:

- `markMessagesFetched` and `markMessagesNotFetched`. Fetch state belongs to
  one API key and is invisible to every other principal.
- `createTag`, `renameTag`, `deleteTag`. These change the tag catalogue,
  not messages. Clients reload tags on `LIVE` (section 10.3).
- Cascading deletes from `deleteDomain` or `deleteMailAddress`. These are
  rare admin operations. Clients converge on their next catch-up.

### 4.3 Stored row (migration `apps/api/migrations/0016_mail_events.sql`)

```
mail_events
  seq          INTEGER PRIMARY KEY AUTOINCREMENT   -- the cursor position
  type         TEXT NOT NULL CHECK (type IN ('MESSAGE_RECEIVED','MESSAGE_SENT',
                 'MESSAGE_UPDATED','MESSAGE_DELETED','DRAFT_SAVED','DRAFT_DELETED'))
  message_id   TEXT NOT NULL      -- no foreign key: deleted messages keep their events
  domain_id    TEXT NOT NULL      -- messages.domain_id at emission time
  addresses    TEXT NOT NULL      -- JSON array: from + every recipient (TO, CC, BCC,
                                  --   ENVELOPE), lower-cased, de-duplicated, sorted
  occurred_at  TEXT NOT NULL      -- ISO-8601 UTC server time of the append
INDEX idx_mail_events_occurred_at ON mail_events(occurred_at)

mail_event_log_state              -- exactly one row, id = 1
  id                  INTEGER PRIMARY KEY CHECK (id = 1)
  epoch               TEXT NOT NULL   -- lower(hex(randomblob(8))) at migration time
  pruned_through_seq  INTEGER NOT NULL DEFAULT 0
```

- The row holds **no mail content**: no subject, body or names. Content is
  resolved at delivery time through the normal read path (section 5.2).
  Deleting a message therefore leaves no copy of its content in the log.
- `addresses` is exactly the set that `messageAddresses()` returns today.
  The per-event authorization check (section 7.3) is then the same
  predicate as `loadReadableMessage`.
- The migration seeds the state row in the same file. It contains no `;`
  inside a statement, because the migration runner splits on `;`. Existing
  migrations 0001-0015 are not modified.
- The replay query is a primary-key range scan (`seq > ? ORDER BY seq LIMIT
  ?`), so it needs no extra index. `idx_mail_events_occurred_at` serves only
  pruning.

### 4.4 Cursor

- **Wire format:** the opaque string `"<epoch>.<seq>"`, for example
  `"9f2c4e1a7b3d5f60.1842"`. Clients must treat it as opaque, except for the
  dedupe rule below.
- **Ordering guarantee:** D1 executes writes serially on a single primary,
  and every `batch` is a transaction. A row with sequence `N` therefore
  becomes visible only after every row with a smaller sequence has
  committed or rolled back. A reader that has seen `N` never later
  discovers an unseen row below `N`. Sequence numbers are global, so they
  are also strictly increasing within every scope; within a scope they are
  sparse. The per-scope cursor that was requested is this global cursor
  filtered by scope (decision D3).
- **Reads go to the primary.** The D1 Sessions API (read replicas) must not
  be used for event-log reads. The libsql file and in-memory databases used
  by Bun and the tests are single-writer SQLite, so the same guarantee holds
  there.
- **Client dedupe rule:** within one epoch, an event whose `seq` is not
  greater than the last processed `seq` is a duplicate. A different epoch
  means a fresh log (section 4.5). The server never sends duplicates in
  normal operation (section 6.4). The rule is defense in depth for a
  Durable Object crash between send and persist.

### 4.5 Retention, pruning and `RESYNC_REQUIRED`

- **Retention:** `FLYING_MAIL_EVENT_RETENTION_SECONDS`, an integer in
  `[3600, 2592000]`. The default is `604800` (7 days). Any other value falls
  back to the default, the same policy as `FLYING_MAIL_INVITE_TTL_SECONDS`.
  The resolver lives in `composition/config.ts`, and `Env`/`envToRecord`
  gain the variable.
- **Pruning is opportunistic, on every append.** It needs no cron, no
  alarm and no runtime-specific scheduler. It runs the same way on the
  Worker, Bun and the tests. The append batch is:
  1. `INSERT` the new rows.
  2. `UPDATE mail_event_log_state SET pruned_through_seq =
     MAX(pruned_through_seq, COALESCE((SELECT MAX(seq) FROM mail_events
     WHERE occurred_at < :cutoff), 0)) WHERE id = 1`
  3. `DELETE FROM mail_events WHERE seq <= (SELECT pruned_through_seq FROM
     mail_event_log_state WHERE id = 1)`

  Clocks can be slightly skewed across isolates. Because of the ordering
  above, a deleted row can never have a `seq` above `pruned_through_seq`. A
  surviving old row below it is harmless.
- **Cursor validation at subscribe.** One query reads `epoch`,
  `pruned_through_seq` and `head = COALESCE(MAX(seq), pruned_through_seq)`.
  - Unparsable cursor: the subscription gets an `error` with `BAD_USER_INPUT`.
  - `epoch` differs from the current epoch: `RESYNC_REQUIRED`. The database
    was reset or replaced.
  - `seq < pruned_through_seq`: `RESYNC_REQUIRED`. Events after the cursor
    may have been pruned. `seq == pruned_through_seq` is valid, because
    every event after it still exists.
  - `seq > head`: `RESYNC_REQUIRED`. The cursor comes from a log that no
    longer exists.
  - Otherwise the subscription starts at `lastSeq = seq`.
  - No `after`: the subscription starts at `lastSeq = head`.
- **How `RESYNC_REQUIRED` is delivered.** It is an `error` message for that
  subscription id, with
  `[{ message: "Cursor is outside the event retention window; resynchronize",
  extensions: { code: "RESYNC_REQUIRED" } }]`. As the protocol defines,
  this ends that subscription only. The socket stays open.

## 5. GraphQL surface

### 5.1 SDL (new file `packages/infrastructure/src/graphql/schema-realtime.graphql.ts`)

```graphql
enum MailEventType {
  MESSAGE_RECEIVED MESSAGE_SENT MESSAGE_UPDATED MESSAGE_DELETED
  DRAFT_SAVED DRAFT_DELETED LIVE
}

input MailEventScope {
  domainId: ID        # only events whose message belongs to this domain
  address: String     # only events whose authorized addresses include it
  types: [MailEventType!]  # only these event types; null/omitted = all
                           # (added 2026-10-08, see 5.2)
}

type MailEvent {
  cursor: String!
  type: MailEventType!
  messageId: ID            # null only for LIVE
  domainId: ID             # null only for LIVE
  addresses: [String!]!    # authorized subset (5.2); empty for LIVE
  occurredAt: DateTime!    # append time; for LIVE, the time the replay caught up
  message: Message         # current state via the normal read path; null when
                           # deleted, no longer readable, or LIVE
}

type Subscription {
  mailEvents(scope: MailEventScope, after: String): MailEvent!
}
```

`MailEvent` is unrelated to the existing `MessageEvent` (deadlines and
reminders). The names are kept distinct.

### 5.2 Field semantics

- **`scope` is a filter, not a grant.** `address` is trimmed and
  lower-cased, and must be a syntactically valid address; otherwise the
  result is `BAD_USER_INPUT`. A scope the viewer cannot read yields no
  events and no error, so it never reveals whether a domain or address
  exists. The semantics match `MessageFilter.domainId` and
  `MessageFilter.address` (sender or any recipient).
- **`scope.types`** (added 2026-10-08) narrows delivery to the listed event
  types. It is applied on the server with the domain and address filter.
  - `null` or omitted means every type, which is the original behavior.
  - An empty list, or a list containing `LIVE`, is rejected with
    `BAD_USER_INPUT` on field `scope.types`. An empty list would deliver
    nothing. `LIVE` is a control event, always delivered whatever `types`
    says.
  - The executor's `coerceScope` deduplicates the list and sorts it into
    enum declaration order.
  - The domain `MailEventScope` gains the optional field
    `types?: readonly MailEventType[] | null`. Absent and `null` both mean
    all types. The field is optional so that existing scope literals and
    states persisted before this change stay valid.
  - The subscription's persisted `scope` carries it. A state persisted
    before this change has no `types`, and `matchesScope` reads that as
    `null`.
  - Like the rest of the scope, `types` is a filter and never a grant.
- **`addresses`** is the event's stored address set, filtered to the
  addresses for which `authorizesAnyAddress(viewer, MAIL_READ, domainId,
  [address])` holds. User `DENY` rules are therefore honoured per address.
  It is never empty for a delivered message event.
- **`message`** is resolved by the same code as `Query.message(id)`, with
  the subscriber's viewer and a fresh loader set for each event execution.
  A `NOT_FOUND` result becomes `null`. Field-level rules, such as admin-only
  fields, apply unchanged. The executor is not given a separate projection.

### 5.3 HTTP transport

graphql-yoga would serve subscription operations over SSE on `/graphql`.
That path is closed: the `mailEvents` `subscribe` resolver used by yoga
always throws `BAD_USER_INPUT` "Subscriptions are served only over
WebSocket (graphql-transport-ws) at /graphql". The WebSocket executor never
calls that `subscribe` resolver (section 6.3). So no streaming HTTP response
can bypass the connection limits.

### 5.4 Error codes added to `design-graphql-api.md`

| Code | Where | Meaning |
|------|-------|---------|
| `RESYNC_REQUIRED` | `error` message of a subscription | The cursor is unusable (4.5). Do a full refresh (web) or `fetchStatus` sync (API), then subscribe without `after` |
| `RATE_LIMITED` (existing) | `error` message of a subscription | The connection already holds the maximum number of subscriptions |

## 6. Protocol and connection lifecycle

### 6.1 Protocol

The server speaks the `graphql-transport-ws` protocol of the graphql-ws
project (`connection_init`, `connection_ack`, `ping`, `pong`, `subscribe`,
`next`, `error`, `complete`), so the stock `graphql-ws` npm client works
against it (README example). The server is hand-written because the
`graphql-ws` `makeServer` keeps per-connection state in closures, and that
state is lost when a Durable Object hibernates (decision D8).

### 6.2 Lifecycle and state

**Upgrade.** The upgrade checks in section 7.1 run first. The host then
accepts the socket with subprotocol `graphql-transport-ws` and creates the
connection state:

```
ConnectionState {
  v: 1
  connId                  random id
  clientIp                normalized (normalizeClientIpForRateLimit)
  cookieTokenHash         string | null, only when 7.1 allowed cookie auth
  openedAt, initDeadline  initDeadline = openedAt + 10 s
  acked                   boolean
  principal               { tokenHash, kind: USER | API_KEY, id } | null
  lastMessageAt           last inbound frame
  subscriptions           [{ id, query, operationName, variables, scope, lastSeq, live }]
}
```

The state never contains a raw cookie, raw API key, or `connection_init`
payload. Only SHA-256 token hashes are stored, which is what D1 already
stores.

**`connection_init`.** Payload: an absent payload or an object; only
`authorization` is read.
- Payload validation: a payload that is not an object, or an
  `authorization` that is not a string, closes `4400`. A string that does
  not start with `Bearer ` closes `4401`.
- Credential choice:
  - `authorization: "Bearer <token>"` is resolved through
    `resolveViewerFromToken`, with usage recorded.
  - Otherwise `cookieTokenHash` is resolved through
    `resolveViewerFromTokenHash`.
  - Otherwise close `4401`.
- Failed resolution: close `4401`.
- A principal holding no MAIL_READ grant at all: close `4403`. For an API
  key, that means no `MAIL_READ` scope. For a user, it means neither the
  `ADMIN` role nor any `ALLOW` rule. This is the new `hasAnyMailRead`
  policy helper in `policies/authorization.ts`.
- Limits: the per-principal checks in section 7.4.
- Success: send `connection_ack` and set `acked`.
- A second `connection_init`: close `4429`.

**`subscribe`.**
- Before ack: close `4401`.
- Duplicate id: close `4409`.
- The connection already holds 4 subscriptions: `error` `RATE_LIMITED`.
- Document checks, any of which yields an `error` with GraphQL validation
  errors while the connection stays open:
  - parse;
  - validate against the full schema;
  - depth at most 12 and selection count at most 2000, using the same
    functions as `useDepthLimit` and `useSelectionLimit`;
  - exactly one operation, of type `subscription`, with exactly one root
    field, `mailEvents` (an alias is allowed).
- `scope` and `after` come from **this subscription's own** coerced
  `mailEvents` arguments: the field arguments resolved against its own
  `variables`. They are stored in its `ConnectionState.subscriptions` entry
  (`scope`, and `lastSeq` derived from `after`). They never come from
  another subscription or from a cache keyed by query text.
- Cursor validation (section 4.5).
- Success: store the subscription with `live = false` and request a drain.

**`complete` from the client** removes the subscription.
**`ping`** gets `pong`. **`pong`** is ignored.

### 6.3 Executing one event for one subscription

The executor uses graphql-js 17:

1. `validateSubscriptionArgs({ schema, document, variableValues,
   operationName, contextValue })`, once per subscription.
   - The validated arguments contain the selected operation and that
     subscription's coerced variable values. They are therefore held per
     subscription, in memory, keyed by `connId` + subscription id.
   - They are never shared between subscriptions, even when the query text
     is identical.
   - After a hibernation wake they are rebuilt from the subscription's
     stored `query`, `operationName` and `variables`.
   - Only the parsed `DocumentNode` may be cached by the hash of the query
     text, because it holds no variables.
2. For each event, `executeSubscriptionEvent({ ...validated, rootValue: {
   mailEvents: event }, contextValue: freshContext })`.
   - `freshContext` comes from `buildGraphQLContext({ viewer, token: null,
     requestOrigin: publicOrigin, clientIp: null })`. Its new loaders are
     never shared across events or principals.
   - Errors go through `toGraphQLError`, the same masking as HTTP.
   - The result is sent as `next`.
   - An execution error for one event is delivered inside that `next`
     (`errors` next to `data`). The cursor still advances.

### 6.4 Replay-then-live: one drain loop

The hub core has a single `drain()`. Pokes, new subscriptions and the
safety timer all call it. At most one drain runs per hub. A call that
arrives during a drain sets `dirty`, and the running drain loops again.

```
drain():
  repeat:
    dirty = false
    subs  = every subscription on every acked connection
    if subs is empty: stop
    from  = min(sub.lastSeq over subs)
    rows  = eventLog.listAfter(from, limit = 200)          # seq ascending
    if rows is not empty:
        re-resolve each distinct principal once (7.3); close the
        connections of an invalid principal (4401 / 4403) and drop them
    for each remaining connection, for each sub, for each row in order
            with row.seq > sub.lastSeq:
        if matchesScope(sub.scope, row) and authorizesRead(viewer, row):
            execute (6.3), send "next"
        sub.lastSeq = row.seq
    if rows.length < 200:                    # this pass read up to the head
        for each sub with live = false:
            send "next" LIVE(cursor = sub.lastSeq); live = true
    persist changed connection states
    stop when rows.length < 200 and not dirty
```

Why this is gap-free and duplicate-free:

- **Gap-free.** Every subscription advances `lastSeq` only over rows that it
  has read from D1 in `seq` order, and section 4.4 guarantees that no
  unseen row can appear below a seen one. A row that commits during a
  replay has a higher `seq`. It is picked up by the same pass (when it is
  within the page) or by the next pass: its writer's poke sets `dirty`,
  and if the poke is lost, the safety timer runs a drain.
- **Duplicate-free.** A row is sent to a subscription only if `row.seq >
  sub.lastSeq`, and `lastSeq` is set to that `seq` right after the send.
  Resubscribing with `after = c` starts at `lastSeq = c`.
- **Ordering.** Rows are processed in ascending `seq` for every
  subscription, so `next` messages are strictly increasing within a
  subscription. `LIVE` is sent after all replayed rows and before any later
  row.

Filtered and unauthorized rows still advance `lastSeq`. A client's resume
cursor is the last cursor it received (an event or `LIVE`), so on resume the
server re-scans, and again filters out, any rows skipped after that point.
That is correct, merely redundant.

`matchesScope(sub.scope, row)` also checks
`sub.scope.types === null || sub.scope.types.includes(row.type)`. A row
excluded by type is handled exactly like a row excluded by domain or
address. The `sub.lastSeq = row.seq` assignment stays outside the match
branch, so a type filter cannot create a gap, a duplicate or a stuck
cursor. `LIVE` is emitted by the head-reached branch, which never consults
`types`.

### 6.5 Heartbeat and timeouts

| Mechanism | Value | Behaviour |
|-----------|-------|-----------|
| `connection_init` timeout | 10 s after open | Close `4408` |
| Client ping | Every 25 s, exactly `{"type":"ping"}` | The Durable Object answers with `setWebSocketAutoResponse` without waking. The Bun host answers in the hub core |
| Idle (half-open) timeout | 75 s without any inbound frame, including an auto-answered ping | Close `4000`. Checked on every wake, at most 60 s apart, so a half-open socket is closed within 135 s |
| Client pong wait | 10 s | The client closes and reconnects (10.2) |
| Safety drain | Every 60 s while any subscription exists | Recovers lost pokes. The maximum live latency when a poke is lost is 60 s |

The Durable Object computes last activity as the maximum of
`getWebSocketAutoResponseTimestamp(ws)` and `lastMessageAt`.

Third-party `graphql-ws` clients must enable `keepAlive` (25 s or less).
Without it they are closed after 75 s idle, and they reconnect. The README
example sets it.

### 6.6 Close codes (documented in README and here)

| Code | Name | Sent when | Client action (10.2) |
|------|------|-----------|----------------------|
| 1000 | Normal | Server shutdown or client stop | Reconnect, unless stopped by the client |
| 1009 | Message too big | Inbound frame over 16 KiB | Fatal (client bug) |
| 1013 | Try again later | Per-principal rate or concurrency limit (7.4) | Reconnect with backoff |
| 4000 | Heartbeat timeout | Idle more than 75 s | Reconnect |
| 4400 | Bad request | Invalid JSON, unknown message type, binary frame, invalid `connection_init` payload | Fatal |
| 4401 | Unauthorized | No or invalid credential at init; credential expired or revoked mid-connection; `subscribe` before ack | Re-authenticate (web: re-check the session, else `/login`; CLI: exit 3) |
| 4403 | Forbidden | Valid principal without any MAIL_READ grant, at init or after a permission change | Fatal (web: offline with a message; CLI: exit 4) |
| 4408 | Init timeout | No `connection_init` within 10 s | Reconnect |
| 4409 | Subscriber already exists | Duplicate subscription id | Fatal |
| 4429 | Too many init requests | Second `connection_init` | Fatal |
| 4500 | Internal error | Unexpected server failure (masked, logged without secrets) | Reconnect |

HTTP rejections before the upgrade (section 7.1) appear to browser clients
as close `1006`, and the client reconnects with backoff.

### 6.7 Limits

| Limit | Value | Enforced |
|-------|-------|----------|
| Inbound frame size | 16 KiB | Hub core, checked before parsing (close `1009`) |
| Subscriptions per connection | 4 | Hub core (`RATE_LIMITED` error) |
| Concurrent connections per IP | 20 | Host at upgrade, before accept (HTTP 429) |
| Concurrent acked connections per principal | 10 | Hub core at init (close `1013`) |
| Connections per hub | 1000 | Host at upgrade (HTTP 503) |
| Connection attempts per IP | 10 / 60 s | `RateLimiter`, key `ws:connect:<ip>` (HTTP 429) |
| `connection_init` per principal | 10 / 60 s | `RateLimiter`, key `ws:init:<kind>:<id>` (close `1013`) |
| Replay page | 200 rows | Hub core |

## 7. Security

### 7.1 Upgrade checks (shared function `checkRealtimeUpgrade`, `packages/infrastructure/src/realtime/upgrade.ts`)

Applied by `worker.ts` and `server.ts` **before** `app.fetch`, only to
`GET /graphql` with `Upgrade: websocket`, in this order:

1. `Sec-WebSocket-Protocol` must list `graphql-transport-ws`. Otherwise
   HTTP 400.
2. **Origin (CSWSH).** If `isCrossOriginRequest(request, publicOrigin)` is
   true, the result is HTTP 403. That is the existing predicate: an
   `Origin` that is malformed or differs from `FLYING_MAIL_PUBLIC_ORIGIN`
   (or, when that is unset, from the request's own origin) is rejected.
3. **Cookie auth only with a matching Origin.** The session cookie is used
   only when an `Origin` header is present and passed step 2. Without an
   `Origin` header (non-browser clients), the cookie is ignored, and only a
   Bearer token in `connection_init` can authenticate.
4. Per-IP attempt limit `ws:connect:<ip>`. Otherwise HTTP 429.
5. The session cookie, if it is used, is hashed with `TokenHasher` here.
   Only the hash crosses into the hub. On the Worker it travels in the
   internal header `x-flying-mail-session-token-hash` of a **newly
   constructed** request to the Durable Object. Client-supplied headers
   with that name are never forwarded, because the forwarded request
   carries only `Upgrade`, `Sec-WebSocket-Protocol`, the client IP and that
   hash.

The Worker is reachable only on the custom domain (`workers_dev = false`,
`preview_urls = false`). The upgrade is therefore served only on
`wss://mail.tacoserve.online/graphql`. No API key or token is ever accepted
in the URL: query strings on the upgrade URL are ignored and never logged.

### 7.2 Credential resolution (no new authentication path)

`createResolveViewerFromTokenUseCase` is split:

- `resolveViewerFromTokenHash(tokenHash, { recordUsage })` holds the
  current logic: session first, then API key; expiry, active-user and
  usable-key checks; permission loading.
- `resolveViewerFromToken(token)` becomes `hash` +
  `resolveViewerFromTokenHash(hash, { recordUsage: true })`. HTTP
  behaviour is unchanged.

Sockets authenticate only with credentials that `/graphql` already
accepts: the session cookie, or `Bearer <token>`. Login and invitations stay
manual browser flows.

### 7.3 Per-event authorization

- **Re-resolution.** At the start of each drain pass, every distinct
  principal is re-resolved from its stored `tokenHash` with `recordUsage:
  false`. The cost is one resolution per principal per pass, not per event.
  - `null` (session expired or logged out, user deactivated, key revoked or
    expired): every connection of that principal is closed with `4401`.
  - `hasAnyMailRead` false: closed with `4403`.
- **Delivery decision.** A row is delivered only if `authorizesAnyAddress(
  viewer, MAIL_READ, row.domainId, row.addresses)` holds. That is the same
  predicate as `loadReadableMessage`, applied to the address snapshot taken
  at emission.
- **Permission changes take effect without a reconnect,** from the next
  drain pass. Granting access, revoking access, adding or removing a key
  scope, and changing a role are all picked up there. A grant does not
  replay events that were filtered out earlier; the client sees that mail
  through its next catch-up.

### 7.4 Connection limits

- The per-IP attempt and per-principal init limits use the existing
  `RateLimiter` port. On the Worker this is the existing `AUTH_RATE_LIMITER`
  binding (10 per 60 s, failing open); on Bun it is the in-memory adapter.
  The `ws:` key prefixes give these checks budgets separate from the auth
  mutations. No new binding is added (decision D10).
- Concurrency caps are counted by the host from live connections:
  - Durable Object: `getWebSockets("ip:<ip>")`, tagged at accept.
  - Principals: counted over the in-memory connection map.

### 7.5 Logging

Log lines carry `connId`, close code and event counts only. Tokens, cookies,
the `connection_init` payload, query variables and mail addresses are never
logged.

## 8. Fan-out runtimes

### 8.1 Hub core and host boundary

`packages/infrastructure/src/realtime/` holds everything that is not
runtime-specific: protocol parsing, the state machine of section 6.2, the
drain of section 6.4, the executor of section 6.3, and the upgrade checks
of section 7.1. It talks to its runtime through one interface:

```
RealtimeHost
  listConnections(): HubConnection[]               all open sockets
  loadState(conn) / saveState(conn, state) / deleteState(conn)
  send(conn, text) / close(conn, code, reason)
  lastActivityAt(conn): number
  scheduleWake(atMs): void                         alarm or setTimeout
  now(): number
```

The hub keeps an in-memory map of connection states as the working copy.
Every mutation writes through to `saveState`. After a Durable Object wakes,
the map is rebuilt from storage, reconciled with the open sockets, and
orphaned states are deleted, all before any event is handled.

### 8.2 Worker: Durable Object `MailEventHub` (`apps/api/src/mail-event-hub.ts`)

- **Partitioning: one instance,** `MAIL_EVENT_HUB.idFromName("mail-events")`.
  - Writers cannot cheaply know which principals may read a message, so
    per-principal objects would need a fan-out of their own.
  - A per-domain object cannot hold a socket that subscribes across
    domains (the "All" mailbox).
  - One hibernating object handles thousands of idle sockets, and every
    poke costs one D1 page read for all subscribers together. That is
    proportionate for a self-hosted instance.
  - **Scaling path, documented but not built:** N objects chosen by a hash
    of the principal, with writers poking all N.
- **Class shape.** A plain class `constructor(ctx, env)`, without
  `extends DurableObject` and without RPC, so it type-checks and tests
  under vitest without `cloudflare:workers`. Structural types
  (`DurableObjectStateLike` and friends) live next to `Env`.
- **`fetch(request)` serves exactly two internal paths.** Only `worker.ts`
  constructs these URLs:
  - `POST https://mail-event-hub.internal/notify` runs the drain and
    answers 204.
  - `GET https://mail-event-hub.internal/connect` with `Upgrade` checks the
    per-IP and global caps, creates a `WebSocketPair`, calls
    `ctx.acceptWebSocket(server, ["ip:<ip>"])`, stores `{ connId }` with
    `serializeAttachment`, writes the initial state, and returns `101` with
    `Sec-WebSocket-Protocol: graphql-transport-ws`.
- **Handlers.**
  - `webSocketMessage` and `webSocketClose` / `webSocketError` delegate to
    the hub core.
  - `alarm()` closes init timeouts and idle sockets, runs the safety drain,
    and reschedules: the earliest pending `initDeadline` if any, otherwise
    now + 60 s while sockets exist, otherwise none.
- **State persistence.** Connection state lives in the object's
  SQLite-backed storage under `conn:<connId>`. The attachment holds only
  `connId`, well below the 2 KiB attachment limit. Subscription documents
  stay in storage, so hibernation loses nothing.
- **Startup.** The constructor calls
  `ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(
  '{"type":"ping"}', '{"type":"pong"}'))`.
- **Dependencies** (D1, `TokenHasher`, use cases, schema) are built lazily
  from `env` with the same `buildDependencies(buildWorkerConfig(env))` that
  the Worker uses, and cached on the instance.
- **Deploys** disconnect all sockets. Clients reconnect with jitter and
  resume by cursor.

### 8.3 Bun server: in-process host (`apps/api/src/server.ts` + `realtime/in-process-host.ts`)

- `Bun.serve` gains a `websocket` handler.
  - `fetch` runs `checkRealtimeUpgrade` for upgrades and then
    `server.upgrade(request, { data: { connId, clientIp, cookieTokenHash },
    headers: { "Sec-WebSocket-Protocol": "graphql-transport-ws" } })`.
  - The `open`, `message` and `close` callbacks delegate to the hub core.
- The host keeps state in a `Map` and wakes with `setTimeout`.
- The notifier calls `hub.requestDrain()` directly.
- **Node** (`@hono/node-server`): an upgrade request receives HTTP 501
  "WebSocket subscriptions require the Bun or Workers runtime". Bun is the
  supported local runtime.
- `vite.config.ts` gains `ws: true` on the `/graphql` proxy.

### 8.4 Writing side: ports and notify timing

New application ports:

- `ports/mail-event-log.ts`:
  - `append(events: readonly NewMailEvent[], retentionCutoffIso: string):
    Promise<void>`, one batch (4.5)
  - `state(): Promise<{ epoch, prunedThroughSeq, headSeq }>`
  - `listAfter(seq: number, limit: number): Promise<readonly
    MailEventRecord[]>`
- `ports/mail-event-notifier.ts`: `notify(): void`. This is fire-and-forget:
  it never throws, and it is never awaited by use cases.

`AppDependencies` gains `mailEventLog`, `mailEventNotifier` (a no-op
adapter when realtime is disabled) and `eventRetentionSeconds`.

A shared helper, `recordMailEvents(deps, events)` in
`usecases/mail-events.ts`, does the following:

1. It awaits `append`. If `append` throws, the helper logs the error and
   returns. The use case's result is unchanged and no notify is sent
   (decision D6).
2. It calls `notify()` only after `append` has resolved, that is, after the
   D1 commit.

Notifier adapters:

| Runtime | Adapter | Behaviour |
|---------|---------|-----------|
| Worker | `adapter/src/realtime/durable-object-notifier.ts` | Coalesces: at most one in-flight `POST /notify` per isolate. A notify during flight sets a follow-up flag. It keeps the pending promise. `worker.ts` `fetch` and `email` call `ctx.waitUntil(notifier.settle())` before returning, so pokes outlive the response without delaying it. Failures are logged and swallowed |
| Worker without the `MAIL_EVENT_HUB` binding | no-op | Upgrades get HTTP 503 |
| Bun | in-process | `hub.requestDrain()` |
| Tests | fake | Records calls |

The adapter `adapter/src/repositories/mail-event-log-repository.ts` is
written against `SqlDatabase`, so D1, libsql and the in-memory test
database share it.

## 9. Configuration and deployment

### 9.1 `apps/api/wrangler.toml` (new keys only)

```toml
[[durable_objects.bindings]]
name = "MAIL_EVENT_HUB"
class_name = "MailEventHub"

[[migrations]]
tag = "v1-mail-event-hub"
new_sqlite_classes = ["MailEventHub"]

# [vars] optional:
# FLYING_MAIL_EVENT_RETENTION_SECONDS = "604800"
```

- `worker.ts` exports `MailEventHub` as a named export next to the default
  handler.
- The tag and class name are permanent once deployed. Renaming the class
  later needs a `renamed_classes` migration. No secrets are involved.
- SQLite-backed Durable Objects are available on Workers Paid, which this
  deployment already requires.
- The dry run (`bun run --cwd apps/api cf:deploy -- --dry-run --outdir
  /tmp/flying-mail-dryrun`) must succeed with this file.

### 9.2 `Env` (`apps/api/src/env.ts`)

`Env` gains:

- `MAIL_EVENT_HUB?: DurableObjectNamespaceLike`
- `FLYING_MAIL_EVENT_RETENTION_SECONDS?: string`, also added to
  `envToRecord`

### 9.3 CSP

Both CSP strings gain exactly `connect-src 'self'`:

- `HTML_CSP` in `packages/infrastructure/src/http/security-headers.ts`
- `apps/web/public/_headers`

Under CSP Level 3, `'self'` matches `ws:` and `wss:` URLs on the page's own
host. `'self'` is therefore the same-origin `wss` endpoint and nothing
else, and it works unchanged for the local `ws://localhost` origin. No
host, scheme or wildcard source is added. The existing CSP test is
extended: both strings are equal, each contains `connect-src 'self'`
verbatim, and neither contains `ws:`, `wss:` or any new `https:` source.

### 9.4 Rollout order (the orchestrator performs every live step)

1. Remote D1 migration 0016 (`mise run cf-deploy` applies migrations before
   it deploys). Until the new code is deployed, the old code ignores the
   new tables.
2. Deploy the Worker. The Durable Object migration `v1-mail-event-hub` is
   applied by `wrangler deploy` itself.
3. Post-deploy smoke check, added to the flying-mail-deploy skill:
   1. Run `flying-mail watch --json` with a read-scoped key from `kinko
      exec`.
   2. Expect a `LIVE` line.
   3. Send a test mail to a managed address.
   4. Expect a `MESSAGE_RECEIVED` line within a few seconds.
   5. Check in the browser that the connection indicator shows "Live".

Rollback: redeploying the previous Worker version leaves the tables and the
Durable Object class unused, and both are harmless. Do not delete the class
binding in a rollback deploy; a `deleted_classes` migration is the only way
to remove it.

## 10. Clients

### 10.1 Shared client package `packages/realtime-client` (`@flying-mail/realtime-client`)

- A zero-dependency TypeScript package that runs in browsers, Bun and
  Node 22 or later, using the global `WebSocket`.
- It imports no other workspace package.
- `apps/web` and `apps/cli` depend on it with `workspace:*`. No
  third-party entry is added to `bun.lock`.
- It holds the protocol message types, one connection with one
  subscription, and the reconnect controller.
- Injected: a `WebSocket` factory, timers and a random source, so that
  unit tests use vitest fake timers and a fake socket.

**Why not the `graphql-ws` npm client (decision D9).** Its built-in retry
resubscribes with the original variables, so a stale `after` would replay
already-seen events. It also has no notion of `RESYNC_REQUIRED`, of the
`LIVE` boundary, or of the 4401 re-auth flow. Wrapping it would disable
most of its value. Its peer range (`graphql` 15/16) also conflicts with the
installed `graphql@17`, and it would be the web bundle's first GraphQL
library. The protocol subset that is needed is small. The `graphql-ws`
client stays fully supported as a third-party client (README).

### 10.2 Reconnect policy

| Aspect | Rule |
|--------|------|
| Backoff | Full jitter: wait `random(0, min(30 s, 1 s * 2^attempt))`. The attempt counter resets when `LIVE` arrives |
| Resume | Every (re)subscribe uses the last processed cursor (event or `LIVE`) as `after`. The cursor dedupe rule of section 4.4 applies |
| Re-auth | `connectionParams()` is evaluated per attempt. The browser sends the current cookie on every new upgrade |
| `RESYNC_REQUIRED` | Clear the cursor, call `onResync`, resubscribe at once on the same socket without `after` |
| Codes | `4401` calls `onAuthFailure("UNAUTHENTICATED")`. `4403`, `4400`, `4409`, `4429` and `1009` stop with `onFatal`. Everything else, including `1006` and HTTP rejections, retries |
| Heartbeat | Ping every 25 s. If no pong arrives within 10 s, close locally and retry |
| Ack timeout | No `connection_ack` within 10 s: close and retry |
| Status | `connecting`, `live`, `reconnecting`, `offline` |

### 10.3 Web client

- `apps/web/src/store/app-store-live.ts` (new) owns one unscoped
  subscription per tab.
  - It starts once `viewer` is known and stops on logout.
  - It selects `cursor type messageId domainId addresses occurredAt
    message { ...the existing list-row fields }`.
  - Cursors stay in memory only; a reload starts fresh.
- **Event handling.**
  - `MESSAGE_UPDATED`, `MESSAGE_SENT` or `DRAFT_SAVED` with a non-null
    `message`: patch the matching loaded row and the open message view in
    place.
  - `MESSAGE_DELETED` and `DRAFT_DELETED`: remove the row at once; if the
    open message is gone, show the existing "not found" state.
  - Every event also schedules one debounced (750 ms) `refreshVisible()`.
    That refetches the first page of the current view, merged so that rows
    beyond the first page and the selection survive; rows that no longer
    match disappear and new rows appear at the top. It also runs
    `reloadAddressActivity()` and `reloadInboxUnread()`.
    - Unread counts, domain-rail badges and the recent-address order are
      covered by these refetches; all three derive from
      `viewer.addressActivity`.
    - The Drafts folder is a message-list view, so draft changes are
      covered as well.
  - The server is the authority for folder membership. The client does not
    re-implement filter logic.
- **On every `LIVE`** (first connect, reconnect, after a resync): run the
  catch-up, which is `refreshVisible()` immediately plus `reloadTags()`.
  - On first connect this closes the window between the initial page load
    and the subscription head.
  - After a resync it is the full refresh.
- **On `4401`:** re-run the `viewer` query.
  - `null`: the existing signed-out flow goes to `/login`.
  - Otherwise: retry.
- **Connection indicator.** `components/connection-indicator.tsx` (+ css),
  a small dot with a text tooltip and `aria-label` in the sidebar header:
  - "Live"
  - "Reconnecting..."
  - "Offline". Covers fatal codes and environments without WebSocket
    support, such as `client serve`. The app keeps working with manual
    refresh, as today.

### 10.4 CLI `flying-mail watch` (`apps/cli/src/commands/watch.ts`)

```
flying-mail watch [--domain <name|id>] [--address <addr>] [--type <list>] [--json]
```

- **`--type`** (added 2026-10-08) is repeatable and comma-separated, and
  matching is case-insensitive.
  - Short names map to enum values: `received` to `MESSAGE_RECEIVED`,
    `sent` to `MESSAGE_SENT`, `updated` to `MESSAGE_UPDATED`, `deleted` to
    `MESSAGE_DELETED`, `draft-saved` to `DRAFT_SAVED`, and `draft-deleted`
    to `DRAFT_DELETED`. The full enum names are also accepted.
  - `live`, an unknown name, or an empty value exits 2 before connecting.
  - The deduplicated values, sorted in enum order, are sent as
    `scope.types`. Without `--type`, no `types` is sent.
  - `packages/realtime-client` `MailEventStreamOptions.scope` gains
    `types?: readonly string[]`.

- **Endpoint.** `wss://` or `ws://` is derived from the configured
  `--endpoint`, with path `/graphql`. The API key is sent only in the
  `connection_init` payload as `authorization: "Bearer <key>"`.
- **`--domain`** accepts a name or an id. A name is resolved through
  `domains`, like other commands.
- **Output.**
  - Human: one line per event, `occurredAt TYPE messageId subject
    addresses`. Status and resync notices go to stderr.
  - `--json`: NDJSON, one object per event. `LIVE` and `RESYNC_REQUIRED`
    appear as `{"type":"LIVE","cursor":...}` and
    `{"type":"RESYNC_REQUIRED"}` lines. Agents then run a `fetchStatus`
    sync, for example `flying-mail mail fetch`.
- **Cursor persistence.**
  - File: `<config dir>/watch-cursors.json`, the directory of the existing
    config file, written with mode 0600.
  - Keyed by `endpoint | key prefix | domain | address`. With `--type`, the
    suffix `|types=<comma-joined sorted enum values>` is appended. Without
    `--type`, the key is byte-identical to the original format, so stored
    cursors keep working. A filtered stream never shares a cursor with an
    unfiltered one. The key secret is never stored there.
  - Written at most once per second and on exit.
  - On resync, the entry is cleared.
- **Termination.**
  - Runs until SIGINT or SIGTERM, then exits 0 after persisting the cursor.
  - `4401` exits 3 and `4403` exits 4, matching `command.md`.
  - Other fatal codes exit 1.
  - Network failures retry forever with the backoff of section 10.2.

## 11. Out of scope and accepted limitations

- `flying-mail client serve` does not proxy WebSocket upgrades (its
  proxy strips `upgrade`). Under it, the web client shows "Offline" and
  behaves as before.
- Node runtime of `apps/api`: HTTP 501 for upgrades (section 8.3).
- Events for tag catalogue changes and admin cascades (section 4.2).
- Notify loss raises live latency to at most 60 s; it does not lose events.
- The event append is not atomic with the state write (decision D6).

## 12. Module layout and size budget

| Path | New / changed | Content |
|------|---------------|---------|
| `packages/domain/src/entities/mail-event.ts` | new | `MailEventType`, `MailEventRecord`, `NewMailEvent`, `MailEventScope` |
| `packages/domain/src/value-objects/mail-event-cursor.ts` | new | Parse and format `<epoch>.<seq>` |
| `packages/application/src/ports/mail-event-log.ts`, `ports/mail-event-notifier.ts` | new | Section 8.4 |
| `packages/application/src/usecases/mail-events.ts` | new | `recordMailEvents`, address snapshot helper |
| `packages/application/src/usecases/{ingest,send,drafts,delete-draft,messages,tagging,rules}.ts` | changed | Emission (section 4.2) |
| `packages/application/src/usecases/auth.ts` | changed | Hash-based resolution split (section 7.2) |
| `packages/application/src/policies/authorization.ts` | changed | `hasAnyMailRead` |
| `packages/application/src/dependencies.ts`, `usecases.ts` | changed | New dependencies |
| `packages/adapter/src/repositories/mail-event-log-repository.ts` | new | SQL log, append with pruning |
| `packages/adapter/src/realtime/durable-object-notifier.ts` | new | Worker notifier |
| `packages/infrastructure/src/graphql/schema-realtime.graphql.ts`, `resolvers/realtime.ts` | new | SDL and resolvers |
| `packages/infrastructure/src/realtime/{protocol,hub,drain,executor,upgrade,host,in-process-host}.ts` | new | Hub core, each well under 400 lines |
| `packages/infrastructure/src/composition/{config,build-dependencies}.ts` | changed | Retention variable and dependency wiring |
| `packages/infrastructure/src/http/security-headers.ts`, `apps/web/public/_headers` | changed | `connect-src 'self'` |
| `apps/api/migrations/0016_mail_events.sql` | new | Section 4.3 |
| `apps/api/src/{mail-event-hub,worker,server,env}.ts`, `wrangler.toml` | new / changed | Sections 8 and 9 |
| `packages/realtime-client/` | new package | Section 10.1 |
| `apps/web/src/store/app-store-live.ts`, `components/connection-indicator.tsx`, `vite.config.ts` | new / changed | Section 10.3 |
| `apps/cli/src/commands/watch.ts`, `main.ts`, `args.ts` | new / changed | Section 10.4 |
| `README.md`, `.agents/skills/flying-mail-deploy/SKILL.md` | changed | API subscription section with a `graphql-ws` client example (with `keepAlive`), close codes, smoke check |

No touched file may reach 1000 lines. `schema.graphql.ts` (876),
`app-store.ts` (768), `commands/index.ts` (715) and `usecases.ts` (693)
receive only wiring lines.

## 13. Verification

| Area | Tests |
|------|-------|
| Event log repository (in-memory libsql + real migrations) | Append assigns increasing seq; `listAfter` order and paging; prune advances `pruned_through_seq` and deletes only rows at or below it; skewed `occurred_at` never deletes above it; state read; migration 0016 applies on top of 0001-0015 |
| Cursor | Format and parse round trip; malformed input; epoch mismatch, `< pruned`, `== pruned`, `> head` cases give the outcomes in section 4.5 |
| Emission (application, fakes) | Each row of the section 4.2 table emits the listed type with `domain_id` and the full address set; no event for fetch-state, REJECTED or no-op duplicates; notify only after append resolves; an append failure does not fail the use case and sends no notify |
| Hub core (in-process host, fake sockets, fake clock) | Init timeout 4408; 4401 without credential and for subscribe-before-ack; Bearer and cookie-hash paths; 4403 without MAIL_READ; 4409; 4429; 1009 over 16 KiB; 4 subscriptions max; 4000 idle; ping answered with pong |
| Replay/live ordering | Subscribe with `after` while appends are injected between `listAfter` pages and during execution: every matching row above the cursor is delivered exactly once, in strictly increasing seq; `LIVE` appears once, after all replayed rows and before later rows; lost pokes are recovered by the safety drain; duplicated and reordered pokes produce no duplicates |
| Authorization | Scope filter by domain and address; two subscriptions (same or different connections and principals) with identical query text and different `scope` variables (domain A and domain B) each receive only the events of their own scope, and each stores its own scope and `lastSeq`; the event for a message outside the viewer's scope is never sent; `addresses` is the authorized subset (user DENY honoured); revoking a permission stops delivery on the next pass without a reconnect; key revocation closes 4401; `message` is `null` after delete |
| HTTP transport | A subscription over `POST /graphql` and over SSE returns `BAD_USER_INPUT`; the Query/Mutation suites stay unchanged |
| Upgrade checks | Missing subprotocol 400; cross-origin and malformed Origin 403; absent Origin ignores the cookie; matching Origin passes the hash only; per-IP limit 429; Worker forwards a freshly built request without client-supplied internal headers; Node 501 |
| Durable Object (fake `DurableObjectStateLike`) | Accept with tag and attachment; auto-response registered; state survives a simulated hibernation (new instance, same storage); alarm rescheduling; `/notify` drains; caps 429/503; `worker.ts` routes upgrades to the stub and calls `waitUntil(settle())` in `fetch` and `email` |
| CSP | Strings equal; `connect-src 'self'` present; no `ws:`, `wss:` or new origin |
| realtime-client (fake timers, fake socket) | Backoff bounds and jitter; reset on LIVE; resume uses the latest cursor; dedupe rule; RESYNC clears and resubscribes without `after`; 4401 calls onAuthFailure; fatal codes stop; pong timeout reconnects; connectionParams re-evaluated per attempt |
| Web (vitest + jsdom) | Row patch and removal; debounced refresh coalesces; catch-up on LIVE; indicator states; 4401 leads to the viewer re-check |
| CLI | NDJSON output; cursor file mode 0600 and keying; resume from stored cursor; RESYNC clears; exit codes 0/3/4/1 |
| Type filter (2026-10-08) | Drain: with `types=[MESSAGE_SENT]` over interleaved RECEIVED/SENT rows, only SENT rows are delivered, in strictly increasing seq, and `lastSeq` equals the last row read, filtered rows included; resume from the last delivered cursor delivers no duplicate and no gap; `LIVE` is still sent once; two subscriptions on one connection with different `types` each get their own subset; a persisted state without `types` behaves as all types. Executor: empty list and `LIVE` give `BAD_USER_INPUT` on `scope.types`; duplicates are collapsed. CLI: `--type` mapping, invalid names exit 2, cursor key unchanged without `--type` and distinct with it |

Repository gates (unchanged commands):

- `mise run lint`, `bun run test` and `mise run build-web` pass. The
  baseline of 1830 package tests and 274 web tests passes, plus the new
  tests.
- `bun run --cwd apps/api cf:deploy -- --dry-run --outdir
  /tmp/flying-mail-dryrun` succeeds.

## 14. Decisions

| Id | Decision | Rationale |
|----|----------|-----------|
| D1 | D1 is the only event source; a notify is a payload-free poke | Replay and live share one code path, so there is no boundary race, and lost or reordered pokes cannot cause gaps |
| D2 | One drain loop with per-subscription `lastSeq` | Gap-free and duplicate-free by construction (section 6.4) |
| D3 | A global `AUTOINCREMENT` seq as the cursor, filtered per scope | D1's serial commits give a total order. Per-scope counters would need read-modify-write under contention for no benefit |
| D4 | Cursor `<epoch>.<seq>` with the epoch seeded by the migration | Detects a database reset that would otherwise silently reuse sequence numbers |
| D5 | Content is resolved at delivery through the normal read path; the log stores ids, domain and addresses only | One authorization path, no mail content copied into the log, smallest rows |
| D6 | Append after the state write, as its own batch; an append failure is logged and does not fail the mutation | D1 has no interactive transactions, and several mutations already write in several statements. The mutation is the truth; a lost event costs at most staleness until the next catch-up. API consumers keep the lossless `fetchStatus` path |
| D7 | A single `MailEventHub` Durable Object | Writers cannot know their readers, and cross-domain sockets cannot be split per domain. This is proportionate for a self-hosted scale (section 8.2) |
| D8 | A hand-written `graphql-transport-ws` server with state in Durable Object storage | `graphql-ws` `makeServer` keeps closure state that hibernation drops |
| D9 | A hand-written client in a shared zero-dependency package | Section 10.1 |
| D10 | Connection limits reuse `RateLimiter` and `AUTH_RATE_LIMITER` with `ws:` prefixes | The request asks to reuse the port; no new namespace id; separate budgets per key prefix |
| D11 | Opportunistic pruning on append; no cron | Runtime-agnostic, deterministic in tests, and no new trigger configuration |
| D12 | `connect-src 'self'` | Minimal, origin-agnostic, and identical in both CSP strings |
| D13 | Cookie auth on sockets only with a matching `Origin` header | CSWSH protection without a new token mechanism |
| D14 | `LIVE` control event | Gives a resumable cursor without traffic and marks the catch-up point |
| D15 | `MailEventScope.types` is a server-side filter folded into `matchesScope`; `lastSeq` still advances over every read row; `LIVE` is not filterable | Agents that care about one event kind avoid receiving and discarding the rest, while D2's gap-free and duplicate-free argument holds unchanged because filtering never touches cursor advancement (2026-10-08) |

## 15. References

- graphql-ws protocol (`graphql-transport-ws`):
  https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md
- Durable Objects WebSocket Hibernation API:
  https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Objects migrations:
  https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- Bun WebSockets: https://bun.sh/docs/api/websockets
- CSP Level 3, matching `'self'` for `ws:`/`wss:`:
  https://www.w3.org/TR/CSP3/#match-url-to-source-expression

All of these are indexed in `design-docs/references/README.md`.
