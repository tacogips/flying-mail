# Realtime Push 01: Contracts, Event Log Persistence and Composition

**Status**: Ready
**Plan ID**: realtime-push-01-contracts-and-persistence
**Wave**: 1 (phase 22)
**Depends On**: none
**Design Reference**: design-docs/specs/design-realtime-push.md sections 4.1-4.5, 7.2, 7.3 (`hasAnyMailRead`), 8.4, 9.2, 12
**Created**: 2026-10-08

## Intent and context

This plan adds every shared contract the later plans build on:

- the domain types and the cursor format
- the application ports `MailEventLog` and `MailEventNotifier`
- the `AppDependencies` fields
- the `recordMailEvents` helper, which every writer calls
- the hash-based viewer resolution
- `hasAnyMailRead`
- migration 0016 and the SQL repository
- the no-op and Durable Object notifier adapters
- the composition wiring

The rest of the system cannot compile against the realtime work without
these, so this plan must leave every workspace compile-clean.

## Non-goals

- No event emission inside use cases (plans 04a and 04b), no GraphQL
  (plan 05), no hub (plan 08), no `apps/api` edits (plans 09 and 10).
- Do not edit `packages/application/src/usecases/messages.ts`, `ingest.ts`,
  `send.ts`, `drafts.ts`, `delete-draft.ts`, `tagging.ts` or `rules.ts`.
- Never edit migrations 0001-0015.

## writePaths

- packages/domain/src/entities/mail-event.ts (new)
- packages/domain/src/entities/mail-event.test.ts (new)
- packages/domain/src/value-objects/mail-event-cursor.ts (new)
- packages/domain/src/value-objects/mail-event-cursor.test.ts (new)
- packages/application/src/ports/mail-event-log.ts (new)
- packages/application/src/ports/mail-event-notifier.ts (new)
- packages/application/src/dependencies.ts
- packages/application/src/usecases/mail-events.ts (new)
- packages/application/src/usecases/mail-events.test.ts (new)
- packages/application/src/usecases/auth.ts
- packages/application/src/usecases/auth-token-hash.test.ts (new)
- packages/application/src/usecases.ts
- packages/application/src/policies/authorization.ts
- packages/application/src/policies/authorization-mail-read.test.ts (new)
- packages/application/src/test-support/fakes.ts
- packages/application/src/test-support/mail-event-fakes.ts (new)
- apps/api/migrations/0016_mail_events.sql (new)
- packages/adapter/src/migrations/runner.test.ts (only the migration-name list)
- packages/adapter/src/repositories/mail-event-log-repository.ts (new)
- packages/adapter/src/repositories/mail-event-log-repository.test.ts (new)
- packages/adapter/src/realtime/mail-event-notifiers.ts (new)
- packages/adapter/src/realtime/mail-event-notifiers.test.ts (new)
- packages/adapter/package.json (one exports entry)
- packages/infrastructure/src/composition/config.ts
- packages/infrastructure/src/composition/config.test.ts
- packages/infrastructure/src/composition/build-dependencies.ts
- impl-plans/active/realtime-push-01-contracts-and-persistence.md (progress log only)

sharedPaths: none.

## File-level changes and pinned contracts

### Domain

`entities/mail-event.ts`:

- `enum MailEventType`, with the six values from design 4.1:
  `MessageReceived = "MESSAGE_RECEIVED"`, `MessageSent`, `MessageUpdated`,
  `MessageDeleted`, `DraftSaved`, `DraftDeleted`. LIVE is **not** in this
  enum; it is a transport control value (plan 05).
- `interface NewMailEvent`:
  `{ readonly type: MailEventType; readonly messageId: MessageId; readonly domainId: DomainId; readonly addresses: readonly string[] }`
- `interface MailEventRecord extends NewMailEvent`:
  `{ readonly seq: number; readonly occurredAt: string }`
- `interface MailEventScope`:
  `{ readonly domainId: DomainId | null; readonly address: string | null }`
- `normalizeEventAddresses(addresses: readonly string[]): readonly string[]`
  trims, lower-cases, de-duplicates and sorts with a plain code-unit sort.

Import `DomainId` and `MessageId` from `../value-objects/ids`, as
`entities/message.ts` does.

`value-objects/mail-event-cursor.ts`:

- `formatMailEventCursor(epoch: string, seq: number): string` returns
  `` `${epoch}.${seq}` ``.
- `parseMailEventCursor(raw: string): { epoch: string; seq: number } | null`
  - `epoch` must match `/^[0-9a-f]{16}$/`.
  - `seq` must match `/^(0|[1-9][0-9]*)$/` and be a safe integer.
  - Anything else returns `null`; the function never throws.

### Application ports (pin exactly)

```ts
// ports/mail-event-log.ts
export interface MailEventLogState { readonly epoch: string; readonly prunedThroughSeq: number; readonly headSeq: number }
export interface MailEventLog {
  append(events: readonly NewMailEvent[], timing: { readonly occurredAt: string; readonly retentionCutoff: string }): Promise<void>;
  state(): Promise<MailEventLogState>;
  listAfter(seq: number, limit: number): Promise<readonly MailEventRecord[]>;
}
// ports/mail-event-notifier.ts
export interface MailEventNotifier { notify(): void }
```

### `dependencies.ts`

- `AppDependencies` gains `readonly mailEventLog: MailEventLog` and
  `readonly mailEventNotifier: MailEventNotifier`.
- `InstanceConfig` gains `readonly eventRetentionSeconds: number`.

### `usecases/mail-events.ts`

- `collectMailEventAddresses(deps, messages: readonly Message[]): Promise<ReadonlyMap<MessageId, readonly string[]>>`
  - It makes one `deps.messageRepository.listRecipients(ids)` call and
    returns `[from, ...all recipients]`, normalized.
  - The address set is exactly the one `messageAddresses` in `messages.ts`
    builds; imitate it there.
- `recordMailEvents(deps, inputs: readonly { type: MailEventType; message: Message; addresses?: readonly string[] }[]): Promise<void>`
  1. An empty input returns immediately.
  2. Missing `addresses` are collected in one batch.
  3. `now = deps.clock.now()`.
  4. `cutoff = new Date(now - eventRetentionSeconds * 1000).toISOString()`.
  5. `await deps.mailEventLog.append(events, { occurredAt: now.toISOString(), retentionCutoff: cutoff })`.
  6. Only after `append` resolves, call `deps.mailEventNotifier.notify()`.
  7. Wrap steps 2-6 in try/catch. On any error, call
     `console.error("Failed to record mail events", { count, types })` with
     no addresses, ids or subjects, and return without calling `notify()`.
  8. It **never throws**.

### `auth.ts` and `usecases.ts`

- New `createResolveViewerFromTokenHashUseCase(deps): (tokenHash: string, options: { readonly recordUsage: boolean }) => Promise<Viewer | null>`.
  It holds today's body of `createResolveViewerFromTokenUseCase` from the
  session lookup onward. The fire-and-forget usage recording runs only when
  `recordUsage` is true.
- `createResolveViewerFromTokenUseCase` becomes: empty token returns
  `null`; otherwise hash and delegate with `{ recordUsage: true }`.
  Behaviour must stay byte-identical for HTTP.
- `UseCases` gains `readonly resolveViewerFromTokenHash: (tokenHash: string, options: { readonly recordUsage: boolean }) => Promise<Viewer | null>`,
  wired in `createUseCases`.

### `policies/authorization.ts`

`hasAnyMailRead(viewer: Viewer): boolean`:

- USER: `role === ADMIN`, or any permission with `effect === ALLOW`.
  VIEWER and MEMBER roles with an ALLOW count.
- API_KEY: any scope whose `capability === Capability.MailRead`.

### Test support

- `test-support/mail-event-fakes.ts`:
  - `createFakeMailEventLog()` keeps an in-memory array with real semantics:
    an incrementing seq, the prune rule from design 4.5, and a fixed epoch
    `"0123456789abcdef"`. It exposes a `records()` getter and
    `failNextAppend()`.
  - `createFakeMailEventNotifier()` counts `notify()` calls.
- `fakes.ts`: `createFakeDependencies` accepts `mailEventLog?` and
  `mailEventNotifier?`, defaulting to the fakes. It sets
  `instanceConfig.eventRetentionSeconds` to `604800` unless overridden.
  Follow how `rateLimiter` is threaded there (fakes.ts:136, 210). Keep the
  `FakeDependencies` handles pattern so tests can reach the fakes.

### Migration `apps/api/migrations/0016_mail_events.sql`

- Columns and checks exactly as in design 4.3: `mail_events`,
  `idx_mail_events_occurred_at`, and `mail_event_log_state` with
  `CHECK (id = 1)`.
- `INSERT INTO mail_event_log_state (id, epoch, pruned_through_seq) VALUES (1, lower(hex(randomblob(8))), 0)`.
- **No `;` inside any statement and none in comments**, because the runner
  splits on `;` (`packages/adapter/src/migrations/runner.ts:26-39`). Use
  `--` comments without semicolons.

### Adapter

`repositories/mail-event-log-repository.ts`:
`createMailEventLogRepository(db: SqlDatabase): MailEventLog`. Imitate
`repositories/message-event-repository.ts` for row mapping and the SQL
helper style.

- `append`:
  - One `db.batch` with one `INSERT` per event (`addresses` as a
    `JSON.stringify` of the normalized array), then the `UPDATE` of
    `pruned_through_seq`, then the `DELETE ... WHERE seq <= (SELECT
    pruned_through_seq ...)`, exactly as in design 4.5.
  - An empty `events` array returns without touching the database.
- `state()`: one query returning `epoch`, `pruned_through_seq` and
  `COALESCE((SELECT MAX(seq) FROM mail_events), pruned_through_seq)`.
- `listAfter(seq, limit)`: `WHERE seq > ? ORDER BY seq ASC LIMIT ?`. Parse
  `addresses` JSON defensively (a malformed value becomes `[]`).

`realtime/mail-event-notifiers.ts`:

- `createNoopMailEventNotifier(): MailEventNotifier`.
- `MAIL_EVENT_HUB_NAME = "mail-events"`.
- `MAIL_EVENT_HUB_NOTIFY_URL = "https://mail-event-hub.internal/notify"`.
- Structural `DurableObjectNamespaceLike`:
  `{ idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } }`.
- `createDurableObjectMailEventNotifier(namespace): MailEventNotifier & { settle(): Promise<void> }`:
  - It coalesces: at most one in-flight POST. A `notify()` during flight
    sets a follow-up flag, which triggers exactly one more POST after the
    current one.
  - Errors and non-2xx responses: `console.error("Mail event notify failed", { status })`.
    They never throw.
  - `settle()` resolves when nothing is in flight or queued.

Add the export `"./realtime/mail-event-notifiers": "./src/realtime/mail-event-notifiers.ts"`
to `packages/adapter/package.json`.

### Composition

- `config.ts`:
  - `DEFAULT_EVENT_RETENTION_SECONDS = 604800`.
  - `resolveEventRetentionSeconds(env: EnvLike): number`, a copy of
    `resolveInviteTtlSeconds` (config.ts:355) with bounds
    `[3600, 2592000]` and the variable `FLYING_MAIL_EVENT_RETENTION_SECONDS`.
  - `BuildDependenciesConfig` gains `eventRetentionSeconds?: number` and
    `mailEventNotifier?: MailEventNotifier`.
  - `loadConfigFromEnv` sets `eventRetentionSeconds`.
- `build-dependencies.ts`:
  - `mailEventLog: createMailEventLogRepository(db)`
  - `mailEventNotifier: config.mailEventNotifier ?? createNoopMailEventNotifier()`
  - `instanceConfig.eventRetentionSeconds: config.eventRetentionSeconds ?? DEFAULT_EVENT_RETENTION_SECONDS`

## Pitfalls

- `recordMailEvents` must not be awaited inside a D1 batch, and must never
  turn a successful mutation into an error.
- Notify **after** append. A notify before the commit breaks the design's
  ordering argument.
- Do not log addresses, tokens or message content.
- Keep `resolveViewerFromToken` semantics identical: sessions first, then
  API keys, and usage recorded only for API keys as today.
- The SQL `DELETE` must be bounded by `pruned_through_seq`, never by
  `occurred_at` directly. Clock skew must not delete rows above the
  watermark.
- `usecases.ts` (693 lines) gets wiring lines only.

## Tests (`situation -> expected`)

**Cursor**
- `format("0123456789abcdef", 42)` -> `"0123456789abcdef.42"`, and it
  round-trips through parse.
- Each of these -> `null`: `"x.1"`, `"0123456789abcdef.-1"`,
  `"0123456789abcdef.01"`, `"0123456789abcdef"`, `""`, an uppercase hex
  epoch, and a seq above `Number.MAX_SAFE_INTEGER`.

**Address normalization**
- `[" B@x.com", "a@x.com", "b@x.com"]` -> `["a@x.com", "b@x.com"]`.

**Repository** (`createMigratedDatabase()` from
`repositories/test-support.ts`)
- Three appends -> seq strictly increasing; `listAfter(0, 2)` returns the
  first two in order.
- `state()` on an empty log -> epoch of 16 hex characters, `headSeq = 0`,
  `prunedThroughSeq = 0`.
- Rows older than the cutoff -> deleted; `prunedThroughSeq` equals their
  max seq.
- An old row with a seq above a newer row (skew) -> nothing above the
  watermark is deleted.
- Migration 0016 applies after 0001-0015. Update the name list in
  `runner.test.ts` (around lines 115 and 169).

**Notifier**
- Three `notify()` calls while one fetch is pending -> exactly two POSTs to
  `MAIL_EVENT_HUB_NOTIFY_URL`.
- A fetch rejection -> no throw; `settle()` resolves.
- The no-op adapter -> no side effects.

**`recordMailEvents`** (fakes)
- Two inputs -> two records with normalized addresses (from plus every
  recipient kind) and `notify` called once after append.
- `failNextAppend` -> resolves, `notify` count 0, `console.error` called
  once with no address strings.
- Empty input -> no append and no notify.

**Auth**
- `resolveViewerFromTokenHash(hash(token), { recordUsage: false })` returns
  the same viewer as `resolveViewerFromToken(token)` for a session and for
  an API key.
- With `recordUsage: false`, `recordUsage` on the key repository is not
  called.
- Unknown hash -> `null`.

**`hasAnyMailRead`**
- ADMIN -> true.
- MEMBER without ALLOW -> false.
- VIEWER with ALLOW -> true.
- Key with only MAIL_SEND -> false.
- Key with MAIL_READ -> true.

**Config**
- `resolveEventRetentionSeconds` -> default for unset, `"abc"`, `"3599"`
  and `"2592001"`; accepts `"3600"` and `"2592000"`.

## Drift protocol

- Before each edit, re-read the file and record its sha256 before and
  after the edit in the progress log.
- On drift, re-apply only this plan's intent.
- This plan runs in wave 1 next to plans 02 and 03, which touch none of
  these paths.

## Verification (repo root; record exit codes)

1. `bunx vitest run packages/domain packages/application packages/adapter packages/infrastructure/src/composition`
   exits 0.
2. `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck`
   exits 0. This proves the new required `AppDependencies` fields compile
   everywhere.
3. `bunx biome check packages/domain/src packages/application/src packages/adapter/src packages/infrastructure/src/composition apps/api/migrations`
   exits 0.
4. `wc -l packages/application/src/usecases.ts packages/application/src/policies/authorization.ts packages/application/src/usecases/auth.ts`
   shows every file under 1000 lines.

## Done criteria

- [ ] All pinned signatures exist exactly as written above.
- [ ] Verification steps 1-4 pass, with outputs recorded.
- [ ] No file outside writePaths changed (`git status --short` reviewed).

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
