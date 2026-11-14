# Realtime Push 06: Web Client Live Updates and Connection Indicator

**Status**: Completed
**Plan ID**: realtime-push-06-web-live-updates
**Wave**: 2 (phase 23)
**Depends On**: realtime-push-02-realtime-client
**Design Reference**: design-docs/specs/design-realtime-push.md section 10.3; design-docs/specs/design-web-client.md "Live updates (2026-10-08)"
**Created**: 2026-10-08

## Intent and context

The SolidJS client subscribes once per signed-in tab through
`createMailEventStream` from `@flying-mail/realtime-client`. Plan 02 pins
its API and links the package.

The client:

- patches or removes loaded rows in place;
- schedules a debounced refresh of the visible first page plus the
  counts;
- runs a catch-up on every `LIVE`;
- handles `4401` by re-checking the session;
- shows a Live / Reconnecting / Offline indicator.

## Non-goals

- Do not edit `apps/web/public/_headers` (plan 05 owns the CSP) or
  `apps/web/package.json` (plan 02 added the dependency).
- No client-side re-implementation of folder or filter matching. The
  server stays authoritative via refetch.
- No polling, and no change to existing mutations' optimistic behaviour.
- Do not edit `api/documents.ts` (649 lines). Put the new document in a new
  file.

## writePaths

- apps/web/src/api/realtime-documents.ts (new)
- apps/web/src/store/app-store-live.ts (new)
- apps/web/src/store/app-store-live.test.ts (new)
- apps/web/src/store/app-store.ts
- apps/web/src/components/connection-indicator.tsx (new)
- apps/web/src/components/connection-indicator.css (new)
- apps/web/src/components/connection-indicator.test.tsx (new)
- apps/web/src/components/mailbox-sidebar.tsx
- apps/web/src/app.tsx
- apps/web/vite.config.ts
- impl-plans/completed/realtime-push-06-web-live-updates.md (progress log only)

sharedPaths: none.

## File-level changes

### `api/realtime-documents.ts`

`MAIL_EVENTS_SUBSCRIPTION`:

```graphql
subscription MailEvents($scope: MailEventScope, $after: String) {
  mailEvents(scope: $scope, after: $after) {
    cursor type messageId domainId addresses occurredAt
    message { ...the same fields MESSAGES_QUERY selects per row }
  }
}
```

Copy the row field list from `MESSAGES_QUERY` in `api/documents.ts`, so
patched rows have the identical `MessageView` shape. If a field constant
already exists there, import it rather than copying.

### `store/app-store.ts` (768 lines; add at most about 80 lines)

Add to `AppStore` and implement inside `createAppStore`:

- `patchMessage(message: MessageView): void`: replace the loaded row with
  the same id. If the id is absent, do nothing.
- `removeMessage(id: string): void`: drop the row and the id from
  `selectedIds`.
- `refreshVisible(): Promise<void>`:
  1. Fetch the first page with the current filter, without resetting the
     `cursor` of already-loaded later pages.
  2. Replace the rows that belong to the first-page window with the server
     result.
  3. Keep the rows beyond the first page that are not in the result.
  4. Keep the selection for ids still present.
  5. Then run `reloadAddressActivity()` and `reloadInboxUnread()`, both
     best-effort.

  Reuse the existing `fetchPage` request-building code (app-store.ts:224).
  Factor out a small helper if needed, and do not duplicate the filter
  construction.
- `reloadTags` becomes accessible as `reloadTags(): Promise<void>` on the
  store, if it is not already exposed.

### `store/app-store-live.ts`

`createLiveUpdates(store: AppStore, options?: { streamFactory?: typeof createMailEventStream; location?: Location })`
returns `{ status: () => ConnectionStatus; start(): void; stop(): void }`.

- **URL:** `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/graphql`.
- **Connection:** `connectionParams` is undefined (cookie auth). `scope` is
  null (unscoped). Cursors live in memory only.
- **`onEvent` by type:**
  - `MESSAGE_UPDATED`, `MESSAGE_SENT` or `DRAFT_SAVED` with a non-null
    `message`: `store.patchMessage(message)`.
  - `MESSAGE_DELETED` or `DRAFT_DELETED`:
    `store.removeMessage(messageId)`.
  - `LIVE`: run the catch-up immediately (below).
  - Every non-LIVE event also schedules one debounced
    `store.refreshVisible()`, coalesced with a 750 ms trailing timer.
- **Catch-up on LIVE:** `store.refreshVisible()` and `store.reloadTags()`,
  run on every LIVE, including the first one.
- **`onAuthFailure`:** call `store.rehydrateSession()`.
  - If `store.viewer()` is then null: stop. The existing `AuthGuard` sends
    the user to `/login`.
  - Otherwise: `start()` again.
- **`onFatal`:** status `offline`; stop.
- **WebSocket missing:** if `typeof WebSocket === "undefined"`, set status
  `offline` and never throw.

### `app.tsx`

After `loadReferenceData`, create the live updates when `store.viewer() !==
null`. Use `createEffect` on `store.viewer()` so that logout (viewer
becomes null) calls `stop()` and sign-in calls `start()`. Provide the
status to the sidebar through props or the store context: extend
`store-context` only if needed, otherwise pass a prop.

### `components/connection-indicator.tsx` (+ css)

- An 8 px dot with the text in `title` and `aria-label`: "Live",
  "Reconnecting...", "Offline".
- `connecting` renders as "Reconnecting...".
- Place it in the `MailboxSidebar` header next to the domain or "All mail"
  title (`mailbox-sidebar.tsx`, 397 lines).
- Use CSS tokens like the neighbouring component CSS files.

### `vite.config.ts`

`/graphql` proxy becomes `{ target: API_ORIGIN, ws: true }`. `/api` and
`/files` are unchanged.

## Pitfalls

- The debounce timer must be cleared on `stop()`.
- `refreshVisible` must not wipe pages loaded through `loadMore`, and must
  not reset scroll or selection.
- Patching a row must not resurrect a row the user just removed
  optimistically. That is acceptable: the debounced refresh is
  authoritative.
- Do not toast on live-update failures. Refresh failures stay silent
  (best-effort), like `reloadInboxUnread`.
- Keep `app-store.ts` under 1000 lines (verify with `wc -l`).

## Tests (vitest + jsdom; a fake `streamFactory` captures the options and drives callbacks)

- `MESSAGE_UPDATED` with a message whose id is loaded -> that row is
  patched (for example `readAt` set). Other rows are unchanged.
- `MESSAGE_DELETED` -> the row is removed and its id leaves the selection.
- Three events within 750 ms -> `refreshVisible` is called once (fake
  timers).
- LIVE -> `refreshVisible` and `reloadTags` are called immediately, on the
  first LIVE and again on a later LIVE.
- `onAuthFailure` with `rehydrateSession` leaving the viewer null -> no
  restart. With the viewer kept -> the stream factory `start` is called
  again.
- `stop()` -> the pending debounce is cancelled.
- `refreshVisible` with two loaded pages (fake `graphqlRequest` via the
  existing test mocking pattern, see `app-store-address-activity.test.ts`)
  -> page-2 rows are kept, and first-page rows are replaced by the server
  rows.
- Connection indicator: each status renders the expected `aria-label`.
- URL derivation: an https location gives a `wss://host/graphql` URL.

## Verification (repo root)

1. `bun run --cwd apps/web test`: exit 0. The 274 baseline web tests plus
   the new ones pass.
2. `bun run --cwd apps/web typecheck`: exit 0.
3. `bunx biome check apps/web/src apps/web/vite.config.ts`: exit 0.
4. `mise run build-web`: exit 0.
5. `wc -l apps/web/src/store/app-store.ts apps/web/src/components/mailbox-sidebar.tsx`:
   every file is under 1000 lines.

## Done criteria

- [x] Live updates, catch-up and the indicator are implemented as
      specified.
- [x] Verification steps 1-5 pass, with outputs recorded.

## Progress Log

### Session: 2026-10-08 (implementation attempt 1)
**Tasks Completed**: Added the GraphQL mail-events document, app-store live
patch/remove/refresh methods, page-preserving refresh behavior, live stream
integration, app lifecycle wiring, sidebar connection indicator and Vite
WebSocket proxy. Added event, catch-up, auth, debounce, page-preservation and
indicator tests.
**Hashes**: Source pre-edit hashes: `attempt-1/pre-edit-hashes.txt`; per-edit
intent and source hash records: `attempt-1/edit-intents/`.
**Verification evidence**:
- `bun run --cwd apps/web test`: exit 0, 26 files and 287 tests passed;
  `attempt-1/web-test-final.log`.
- `bun run --cwd apps/web typecheck`: exit 0;
  `attempt-1/web-typecheck-final.log`.
- `bunx biome check apps/web/src apps/web/vite.config.ts`: exit 0;
  `attempt-1/biome-final.log`.
- `wc -l apps/web/src/store/app-store.ts apps/web/src/components/mailbox-sidebar.tsx`:
  exit 0; 836 and 412 lines; `attempt-1/line-counts.log`.
- `mise run build-web`: not run. It writes generated output to
  `apps/web/dist`, which is not an authorized artifact root for this plan;
  request a checkpoint amendment before running it.
- Initial test run (exit 1, 285 passed / 2 failed) is preserved in
  `attempt-1/web-test-initial.log`; the failures were corrected and final
  source checks pass. Initial Biome diagnostics were reconstructed from the
  complete captured tool output in
  `attempt-1/biome-initial-failure-reconstructed.log` after the log path was
  reused for the final check; the final source check passes with no diagnostics.
- The required `check-and-test-after-modify` verifier independently reran
  tests (26 files, 287 passed), typecheck and Biome on this source before
  the final store assertions were added. The source-matched gates above were
  rerun after those assertions.

### Session: 2026-10-08 (implementation attempt 2)
**Tasks Completed**: Re-ran the source-scoped web tests, typecheck, Biome and
line-count checks against the current implementation. No source edits were
needed. The build gate remains blocked pending an artifact-root checkpoint
amendment.
**Verification evidence**:
- `bun run --cwd apps/web test`: exit 0, 26 files and 287 tests passed;
  `attempt-2/web-test-rerun.log`.
- `bun run --cwd apps/web typecheck`: exit 0;
  `attempt-2/web-typecheck.log`.
- `bunx biome check apps/web/src apps/web/vite.config.ts`: exit 0, 93 files;
  `attempt-2/biome.log`.
- `wc -l apps/web/src/store/app-store.ts apps/web/src/components/mailbox-sidebar.tsx`:
  exit 0; 836 and 412 lines; `attempt-2/line-counts.log`.
- `mise run build-web`: not run. `mise.toml` and `apps/web/package.json`
  write the output to `apps/web/dist`; `artifactRoots` is empty. No safe,
  repository-supported output override exists. Request an artifact-root
  checkpoint amendment before running the build.

### Session: 2026-10-08 (Opus review corrections)
**Tasks Completed**: Fixed stale visible-refresh responses with list generations; preserved boundary rows when page one shifts or a loaded row is removed; added bounded jittered 4401 recovery; patched/deleted the active message view from live events; added screen-reader status text and lifecycle timer cleanup.
**Review findings**: H1, M1, M2, M3, L1 and L2 addressed. Added regression tests for folder-switch and early-LIVE races, new-mail page-boundary shifts, removed rows, bounded auth retries, active-message updates/deletion, and indicator labels.
**Verification evidence**:
- `bunx biome check apps/web/src --diagnostic-level=warn`: exit 0; 94 files checked, no diagnostics.
- `bun run --cwd apps/web typecheck`: exit 0 (`tsc --noEmit`).
- `bun run --cwd apps/web test`: exit 0; 26 files and 299 tests passed.
- `mise run build-web`: exit 0; Vite production build completed in 537 ms.
- Touched source files remain under 1000 lines.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
