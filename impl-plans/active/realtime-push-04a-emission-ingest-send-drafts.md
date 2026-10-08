# Realtime Push 04a: Event Emission in Ingest, Send and Drafts

**Status**: Ready
**Plan ID**: realtime-push-04a-emission-ingest-send-drafts
**Wave**: 2 (phase 23)
**Depends On**: realtime-push-01-contracts-and-persistence
**Design Reference**: design-docs/specs/design-realtime-push.md section 4.2 (writer table), 8.4, decision D6
**Created**: 2026-10-08

## Intent and context

The ingest, send and draft use cases must append mail events after their
last state write and then notify, through plan 01's
`recordMailEvents(deps, inputs)` and `collectMailEventAddresses(deps,
messages)` in `packages/application/src/usecases/mail-events.ts`. That
helper already handles address collection, append, notify-after-append and
error swallowing. This plan only decides **where** and **with which
type** to call it.

## Non-goals

- Do not change `recordMailEvents`. Do not touch `messages.ts`,
  `tagging.ts` or `rules.ts` (plan 04b), or any port or repository.
- Do not change any use case's return value, thrown errors or write order.
- No events for REJECTED ingest, for no-op duplicates, or on failure paths
  that throw.

## writePaths

- packages/application/src/usecases/ingest.ts
- packages/application/src/usecases/send.ts
- packages/application/src/usecases/drafts.ts
- packages/application/src/usecases/delete-draft.ts
- packages/application/src/usecases/mail-events-emission-mail.test.ts (new)
- impl-plans/active/realtime-push-04a-emission-ingest-send-drafts.md (progress log only)

sharedPaths: none.

## Emission points (each one call, after the last awaited write)

| Use case | Where | Call |
|----------|-------|------|
| `createReceiveMessageUseCase` (`ingest.ts:503`) | Just before `return { kind: "STORED", message }` (about line 708) | `recordMailEvents(deps, [{ type: MessageReceived, message }])` |
| Same, DUPLICATE branches (about lines 566 and 700) | Before calling `addEnvelopeRecipient` | Read `listRecipients([existing.id])` and check whether an `ENVELOPE` row with `resolved.address` already exists. Only when it did **not** exist, emit `MessageReceived` for `existing` **after** `addEnvelopeRecipient` resolves |
| `createSendMessageUseCase` (`send.ts:368`) | After `deliver()` (send.ts:337-366) has persisted SENT or FAILED | `MessageSent` with the persisted message (the same object the use case returns) |
| `createRetrySendUseCase` (`send.ts:484`) | After `deliver` | `MessageUpdated` |
| `createSaveDraftUseCase` (`drafts.ts:121`) | After the create path (`insertWithRelations`, about line 270) and after the update path (after the last `saveAttachment` loop) | `DraftSaved` |
| `createSendDraftUseCase` (`drafts.ts:295`) | After `deliver` | `MessageSent` |
| `createDeleteDraftUseCase` (`delete-draft.ts:10`) | Before `deleteDraftIfDraft`, call `collectMailEventAddresses(deps, [draft])`. After the delete returns true, call `recordMailEvents` with that pre-collected `addresses` | `DraftDeleted` |

`sendTemplatedMessage` delegates to `sendMessage`. Do not emit twice; check
`mail-template-send.ts:185` only to confirm the delegation.

External fetch ingests through `receiveMessage`, so it is covered without
editing `external-fetch.ts`.

## Pitfalls

- **Await `recordMailEvents`** so tests are deterministic. It never throws,
  so it cannot change the outcome.
- **Do not emit inside a path that later throws.** If `deliver()` throws
  for an unexpected error, emit nothing. If it records FAILED and returns
  normally, emit `MessageSent`.
- **Deleted drafts:** collect the addresses **before** the delete, because
  recipients cascade away with the row.
- **Envelope rows:** the duplicate-branch check must look at
  `kind === ENVELOPE` rows. A TO header row for the same address does not
  count as already delivered.
- **File size:** `ingest.ts` is 728 lines and must stay under 1000. Keep the
  duplicate check in a small local helper.
- **Logging:** no new `console.*` calls with addresses.

## Tests (`mail-events-emission-mail.test.ts`, using `createFakeDependencies` and plan 01's fake log and notifier)

Imitate the ingest fixtures in the existing ingest tests. Find them with
`grep -l "createReceiveMessageUseCase" packages/application/src`.

- **Ingest**
  - New inbound -> one `MESSAGE_RECEIVED` record whose addresses include
    from and the envelope recipient, lower-cased; notify count 1.
  - REJECTED (unknown recipient) -> no record.
  - Same raw delivered again to the same address -> DUPLICATE, no new
    record.
  - Same raw delivered to a second managed address -> exactly one new
    `MESSAGE_RECEIVED` for the existing id, and its addresses include the
    new address.
- **Send**
  - `sendMessage` succeeds -> one `MESSAGE_SENT`.
  - The provider returns a failure that is persisted as FAILED -> one
    `MESSAGE_SENT`.
  - `retrySend` -> one `MESSAGE_UPDATED`.
- **Drafts**
  - `saveDraft` create, then update -> two `DRAFT_SAVED` events with the
    same message id.
  - `sendDraft` -> `MESSAGE_SENT`.
  - `deleteDraft` -> `DRAFT_DELETED` whose addresses equal the draft's
    addresses before deletion.
  - `deleteDraft` on a non-draft -> NOT_FOUND as today, and no record.
- **Failure handling:** `failNextAppend` on `sendMessage` -> the result is
  unchanged (message returned), notify count 0.

## Drift protocol

- Before each edit, re-read the target and record its sha256 before and
  after.
- Plan 04b edits other files in the same package concurrently. Never touch
  them.

## Verification (repo root)

1. `bunx vitest run packages/application`: exit 0. Every pre-existing
   application test must still pass.
   - Plan 04b edits `messages.ts`, `tagging.ts` and `rules.ts` concurrently.
   - If a failure is located only in those files or in their new test
     file, re-run after 04b reports done.
   - Record both runs.
2. `bun run --cwd packages/application typecheck`: exit 0.
3. `bunx biome check packages/application/src/usecases`: exit 0.
4. `wc -l packages/application/src/usecases/ingest.ts packages/application/src/usecases/send.ts packages/application/src/usecases/drafts.ts`:
   every file is under 1000 lines.

## Done criteria

- [ ] Every row of the emission table is implemented and tested.
- [ ] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
