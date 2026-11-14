# Realtime Push 04b: Event Emission in Message Mutations and Rules

**Status**: Completed
**Plan ID**: realtime-push-04b-emission-message-mutations
**Wave**: 2 (phase 23)
**Depends On**: realtime-push-01-contracts-and-persistence
**Design Reference**: design-docs/specs/design-realtime-push.md section 4.2 (writer table and the "deliberately no events" list), decision D6
**Created**: 2026-10-08

## Intent and context

Read/unread, tagging (including the TRASH, ARCHIVED and STARRED system
tags), the spam verdict, deletion and classification rules must emit
`MESSAGE_UPDATED` or `MESSAGE_DELETED`. They do so through plan 01's
`recordMailEvents` and `collectMailEventAddresses`, in
`packages/application/src/usecases/mail-events.ts`.

## Non-goals

- Do not touch `ingest.ts`, `send.ts`, `drafts.ts` or `delete-draft.ts`
  (plan 04a), or any port, repository or fake.
- No events from `markMessagesFetched` or `markMessagesNotFetched`
  (`fetch-state.ts`), or from `createTag`, `renameTag` or `deleteTag`.
  This is accepted design scope.
- No change to return values, errors or write order.

## writePaths

- packages/application/src/usecases/messages.ts
- packages/application/src/usecases/tagging.ts
- packages/application/src/usecases/rules.ts
- packages/application/src/usecases/mail-events-emission-mutations.test.ts (new)
- impl-plans/completed/realtime-push-04b-emission-message-mutations.md (progress log only)

sharedPaths: none.

## Emission points

| Use case | Where | Type |
|----------|-------|------|
| `createMarkReadUseCase` (`messages.ts:347`) | After `setRead` (about line 366), for the messages actually updated | `MessageUpdated` per message |
| `createDeleteMessagesUseCase` (`messages.ts:382`), trash path | After `addTags([trash])` | `MessageUpdated` per message |
| Same, purge path: `hardDeleteMessages` (`messages.ts:428-462`) | Call `collectMailEventAddresses(deps, messages)` **before** `messageRepository.delete`. After the delete resolves, emit with those addresses | `MessageDeleted` per message |
| `applyTags` (`tagging.ts:28-55`), used by `tagMessages` and `untagMessages` | After `addTags` / `removeTags` | `MessageUpdated` per message |
| `markSpam` / `markNotSpam` (`tagging.ts:85`, `tagging.ts:113`) | After `setSpamMarks` / `clearSpamMarks` | `MessageUpdated` per message |
| `createApplyClassificationRuleUseCase` (`rules.ts:153`) | Per page of affected messages, after that page's writes | `MessageUpdated` per affected message |

Pass the `Message` objects the use case already loaded (for example from
`loadReadableMessages`). Do not re-query unless the use case holds only ids.

## Pitfalls

- **One `recordMailEvents` call per use-case invocation** (or per rule
  page), carrying all messages. Never one call per message: that means one
  D1 batch per message.
- **Purged messages:** addresses must be captured before the delete.
  Recipients are `ON DELETE CASCADE`.
- **Mixed trash and purge:** in `deleteMessages`, a message already in
  Trash is purged while the others are trashed (messages.ts:410-425). Each
  message gets exactly one event, whose type matches what happened to it.
- **Unmatched ids:** ids filtered out by authorization (`NOT_FOUND`
  semantics) must not produce events.
- **File size:** `messages.ts` is 463 lines. Keep each addition small.

## Tests (`mail-events-emission-mutations.test.ts`, fakes)

- `markRead([a, b], true)` -> two `MESSAGE_UPDATED` records, in one append
  (fake log append count 1), notify 1.
- `deleteMessages([x])` where x is not trashed -> `MESSAGE_UPDATED`.
  Repeat on the now-trashed x -> `MESSAGE_DELETED` with the original
  addresses.
- A mixed batch -> one UPDATED (newly trashed) plus one DELETED (purged).
- `tagMessages` with the STARRED system tag -> UPDATED.
- `untagMessages` -> UPDATED.
- `markSpam` and `markNotSpam` -> UPDATED each.
- `applyClassificationRule` that matches two messages -> two UPDATED
  events.
- `markMessagesFetched` -> no record. This is a regression guard.
- An id the viewer cannot read -> no event for it.
- `failNextAppend` -> the use case result is unchanged and notify is 0.

## Drift protocol

- Record the sha256 of each file before and after editing it.
- Plan 04a edits sibling files concurrently. Never touch them.

## Verification (repo root)

1. `bunx vitest run packages/application`: exit 0.
   - Plan 04a edits `ingest.ts`, `send.ts`, `drafts.ts` and
     `delete-draft.ts` concurrently.
   - If a failure is located only in those files or in their new test
     file, re-run after 04a reports done.
   - Record both runs.
2. `bun run --cwd packages/application typecheck`: exit 0.
3. `bunx biome check packages/application/src/usecases`: exit 0.
4. `wc -l packages/application/src/usecases/messages.ts packages/application/src/usecases/tagging.ts packages/application/src/usecases/rules.ts`:
   every file is under 1000 lines.

## Done criteria

- [x] All emission points are implemented, and the no-event cases are
      verified.
- [x] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: 2026-10-08
**Tasks Completed**: All emission points and assigned regression coverage.
**Hashes**: Before-edit source hashes are recorded in `tmp/realtime-push-s306/realtime-push-04b-emission-message-mutations/attempt-1/pre-edit-sha256.txt`; final source hashes are in `post-edit-source-sha256.txt`.
**Verification evidence**:
- Final post-modification run: `bunx vitest run packages/application` exit 0, 45 files and 590 tests passed (`attempt-3/verification-vitest-final.log`). Covers batched markRead, trash/purge/mixed delete, pre-delete addresses, tagging, spam, rules, unauthorized ids, fetch-state no-op, and append failure.
- Final `bun run --cwd packages/application typecheck`: exit 0 (`attempt-3/verification-typecheck-final.log`).
- Final required `bunx biome check packages/application/src/usecases`: exit 0, 85 files checked (`attempt-3/verification-biome-required-final.log`). Plan-owned files only also pass (`attempt-3/verification-biome-owned-final.log`).
- Final `wc -l packages/application/src/usecases/messages.ts packages/application/src/usecases/tagging.ts packages/application/src/usecases/rules.ts`: exit 0; 507, 154 and 255 lines (`attempt-3/verification-line-counts-final.log`).
- Initial attempt-1 mixed-delete test exposed separate event batches and was fixed by combining events after state writes. Attempt-1 directory-wide Biome reported transient formatting in concurrent plan 04a files; the attempt-3 rerun on the current shared tree passes. Historical logs remain under attempt-1.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
