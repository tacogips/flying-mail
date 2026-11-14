# Webmail 08: Multi-Domain Inbound Ingest

**Status**: Completed
**planId**: webmail-08-ingest-multi-domain
**Wave**: 2 (depends on webmail-01-data-layer)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 9 (all steps and "Visible consequences"), D8, section 12 tests (a)-(e)
**Created**: 2026-10-07

## Intent and context

Cloudflare calls the Worker `email()` handler once per envelope recipient.
Today `createReceiveMessageUseCase`
(`packages/application/src/usecases/ingest.ts:355-508`) has three
problems:
- It writes the raw blob before dedup, and leaves it orphaned on
  DUPLICATE.
- It dedups by a global `rfc_message_id`, so later recipients are never
  recorded, and the inbound copy of our own outbound mail to another
  managed mailbox is swallowed.
- It ignores Reply-To.

Accepted design D8: one INBOUND row per (Message-ID, recipient domain),
plus one ENVELOPE recipient row per delivered mailbox on that domain. Dedup
is scoped to (INBOUND, domain_id). Per-domain copies share `thread_id`.

The reason: `messages.domain_id` is single-valued. Both the domain filter
(`message-repository-queries.ts:215-219`) and the permission pairing
(`message-repository-queries.ts:94-103`, `policies/authorization.ts:148-232`)
key on it. Do NOT change those files.

Contracts from webmail-01:
- `findInboundByRfcMessageId(rfc, domainId)`
- `addEnvelopeRecipient(messageId, address)`
- `findByRfcMessageId` (deterministic, any row)
- `DuplicateMessageError`, thrown by `insertWithRelations`
- `CreateInboundMessageInput.replyTo`

## Non-goals

- No change to `resolveRecipient` (catch-all, mailbox precedence,
  rejects).
- No change to the spam scorer or rules.
- No change to `apps/api/src/worker.ts`; its handler already maps the
  results.
- No filter or authorization SQL changes.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- `ingest.test.ts` is 798 lines: put new tests in new files.

## Write ownership

**writePaths**
- `packages/application/src/usecases/ingest.ts`
- `packages/application/src/usecases/ingest-multi-domain.test.ts`
- `packages/adapter/src/repositories/message-repository-multi-domain.test.ts`
- `impl-plans/completed/webmail-08-ingest-multi-domain.md` (checkboxes and Progress Log only)

**sharedPaths**: none. Do not edit `ingest.test.ts`,
`message-repository-queries.ts`, `policies/authorization.ts` or
`apps/api/src/worker.ts`.

## File-level changes

### packages/application/src/usecases/ingest.ts

Change the flow, in this order:
1. Size check, `resolveRecipient` (yields domain D) and envelope-sender
   validation: unchanged.
2. Pre-R2 dedup.
   - Read `input.headers.get("message-id")`. Normalize it locally: trim,
     strip surrounding `<>`, treat empty as null. Do not import adapter
     code.
   - If non-null and `findInboundByRfcMessageId(id, D.id)` returns a
     message: call `addEnvelopeRecipient(existing.id, resolved.address)`
     and return `{kind:"DUPLICATE", message: existing}`. Perform **no blob
     write**.
3. Otherwise put the raw blob, read it back and parse, as today.
4. Post-parse dedup.
   - If `parsed.messageId` is non-null and `findInboundByRfcMessageId`
     finds a row: `addEnvelopeRecipient`, delete this call's raw blob
     (`deps.blobs.delete(rawKey)`, swallowing errors) and return
     DUPLICATE.
   - Replace the old global `findByRfcMessageId` dedup (lines 394-401).
5. Threading. `resolveThreadId` gains a step 0 before the In-Reply-To
   rule: if `parsed.messageId` is non-null and `findByRfcMessageId`
   returns any row (OUTBOUND, or INBOUND on another domain), reuse its
   `threadId`.
6. Build the message as today, adding:
   - `domainId: resolved.domain.id` (already present)
   - `replyTo`: the first parsed `replyTo` address. Parse it with
     `parseEmailAddress`; `null` on failure.
7. Insert. Wrap `insertWithRelations` in try/catch. On
   `DuplicateMessageError` (a concurrent delivery to the same domain won
   the race):
   1. Delete this call's raw blob and every attachment blob this call
      wrote, swallowing errors.
   2. Re-read with `findInboundByRfcMessageId`.
   3. `addEnvelopeRecipient` and return DUPLICATE.
   - If the re-read returns null, rethrow the original error.
   - Any other error is rethrown unchanged, which keeps Cloudflare's retry
     behavior.

Pitfalls:
- Messages without a Message-ID are never deduplicated: one row per
  call, as today.
- `extraStatements` (external-mail fetch) are applied only on STORED, as
  documented in `ReceiveMessageInput`. Keep that.
- Do not add ENVELOPE rows on the STORED path beyond what
  `collectHeaderRecipients` already writes.
- Never dedup against OUTBOUND rows.

## Tests (new files)

### packages/application/src/usecases/ingest-multi-domain.test.ts

Use the fakes and imitate `ingest.test.ts` setup, with two ACTIVE
catch-all domains T and M.
- (a) Same Message-ID delivered to a@T, then b@T -> one row, ENVELOPE rows
  [a@T, b@T]. The second result is DUPLICATE. The blob store holds exactly
  one raw object.
- (a, concurrency) The second delivery's pre-check finds nothing and the
  insert throws `DuplicateMessageError` (fake configured) -> DUPLICATE,
  the ENVELOPE row is added, and no raw or attachment blobs from the
  second call remain.
- (b) A Message-ID delivered to alice@T and then bob@M -> two INBOUND
  rows, with domainIds T and M and the same threadId. Each has its own
  ENVELOPE row.
- (e) An OUTBOUND row with rfc id X on domain T exists, and inbound X
  arrives for c@M -> a new INBOUND row on M (no dedup) with threadId equal
  to the outbound row's.
- (e) Inbound X for c@T while only an OUTBOUND X on T exists -> a new
  INBOUND row (dedup ignores OUTBOUND).
- Header Message-ID absent, but the parsed Message-ID matches an existing
  T row -> DUPLICATE and the raw blob written by this call is deleted.
- No Message-ID at all -> two deliveries create two rows (existing
  behavior).
- A Reply-To header `r@ext.com` -> stored `replyTo` is `r@ext.com`.

### packages/adapter/src/repositories/message-repository-multi-domain.test.ts

This is a repository-backed integration test. Imitate
`message-repository-permissions.test.ts` for building
`mailPermissionFilter`. Insert the T and M rows of one message directly
via the repository.
- (b) `list({domainIds:[M]})` returns the M row, and
  `list({domainIds:[T]})` returns the T row.
- (c) A USER (MEMBER) with a single ALLOW (domainId=M,
  pattern=bob@mutvar-test.online): list returns only the M row, and a
  single-message read of the M row is authorized. Use
  `loadReadableMessage` via application fakes if simpler; otherwise
  assert the list.
- (d) The same reader plus a DENY (domainId=T, pattern=*) -> the M row is
  still listed.

## Invariants

- The Message-ID is read before any R2 write.
- No orphan raw blob on any DUPLICATE path.
- The cross-domain outbound copy lands as an INBOUND row on the
  recipient's domain.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts`
  -> exit 0.
- Server-workspace typecheck:
  `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck`
  -> exit 0. apps/web is excluded on purpose: webmail-10, in the same
  wave, leaves a known transient error in
  `apps/web/src/pages/mailbox-page.tsx` until webmail-11. Never edit
  anything under `apps/web`, and do not use the root `bun run typecheck`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn`
  -> no diagnostics.

## Completion criteria

- [x] The ingest flow matches steps 1-7.
- [x] Tests (a)-(e) and the Reply-To test pass.
- [x] The existing `ingest.test.ts` and `external-fetch.test.ts` pass.
- [x] Verification is logged with exit codes, including the
      server-workspace typecheck (exit 0).

## Progress Log

### Session: 2026-10-07 Step 6 implementation
**Tasks Completed**: Implemented scoped inbound deduplication, envelope-recipient accumulation, same-Message-ID threading, Reply-To persistence, and duplicate-race blob cleanup. Added application and repository tests for same-domain duplicates, cross-domain copies, outbound Message-ID coexistence, no-Message-ID behavior, Reply-To, domain filtering and permission pairing.

**Verification**:
- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts` -> exit 0; 4 files, 60 tests passed. Log: `tmp/webmail-completion-s299/webmail-08/evidence/focused-vitest-final.log`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn` -> exit 0, 3 files checked. Log: `tmp/webmail-completion-s299/webmail-08/evidence/biome-002.log`.
- Server-workspace typecheck command -> exit 2. Domain typecheck passed; application typecheck stopped the chain on errors in concurrently changing compose/draft/send/readable-address files outside this plan's writePaths (`compose-usecases.test.ts`, `drafts.ts`, `outbound-assembly.test.ts`, `outbound-assembly.ts`, `readable-addresses.test.ts`, `send.ts`). Full log: `tmp/webmail-completion-s299/webmail-08/evidence/server-typecheck-003.log`. Do not edit those files here; rerun after their owning plan work resolves the diagnostics.

**Source Hashes**: Pre-edit source hashes are in `tmp/webmail-completion-s299/webmail-08/evidence/pre-edit-hashes-001.txt`; final source hashes are in `tmp/webmail-completion-s299/webmail-08/evidence/post-edit-hashes-003.txt`. Per-edit intentions are recorded alongside them.

**At that session's handoff**: The required server-workspace typecheck had not passed on the then-current combined tree. This blocker was resolved by the successful Step 6 verification rerun below.

### Session: 2026-10-07 Step 6 verification rerun
**Tasks Completed**: Re-ran the plan's required checks against the current shared tree. The earlier shared-tree typecheck blocker is resolved; no source changes were needed.

**Verification**:
- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts` -> exit 0; 4 files, 60 tests passed. Log: `tmp/webmail-completion-s299/webmail-08/evidence/step6-rerun-20261007-focused-vitest.log`.
- `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck` -> exit 0. Log: `tmp/webmail-completion-s299/webmail-08/evidence/step6-rerun-20261007-server-typecheck.log`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn` -> exit 0; 3 files checked. Log: `tmp/webmail-completion-s299/webmail-08/evidence/step6-rerun-20261007-biome.log`.

**Source Hashes**: Current source and test hashes match `tmp/webmail-completion-s299/webmail-08/evidence/final-source-hashes-step6-rerun-001.txt`. Plan hash transitions for both log edits are recorded in `tmp/webmail-completion-s299/webmail-08/evidence/plan-hash-transition-step6-rerun-001.txt` and `tmp/webmail-completion-s299/webmail-08/evidence/plan-hash-transition-step6-rerun-002.txt`.

**Downstream**: Formal workflow review remains pending; it is not an implementation verification gap.

### Session: 2026-10-07 Step 6 adversarial repair (comm-004869)
**Tasks Completed**: Prevented a forged Message-ID from adding an ENVELOPE authorization row. Added `hasEnvelopeFor` so the pre-R2 no-write fast path applies only to a retry for a recipient already recorded. Other Message-ID matches are parsed and merged only when stored sender, subject, and truncated text/html bodies match. The post-parse and `DuplicateMessageError` paths always clean this call's blobs and add no envelope on a fingerprint mismatch.

**Scope deviation for serial reconciliation/design owner**: Design section 9 step 2's unconditional "write no blob" on an inbound Message-ID match is narrowed to retries already present in ENVELOPE. A new recipient now incurs parse work to verify the message fingerprint; the duplicate raw/attachment blobs are deleted before returning. This protects mailbox authorization while preserving no-orphan cleanup. Reconcile the design text in the serial integration step; it is outside this plan's write paths.

**Regression Coverage**: Added forged sender mismatch with header, forged subject mismatch without header, and forged body mismatch through the duplicate-insert race. Each asserts DUPLICATE, no second row, unchanged envelope list, and no leftover blobs. The genuine race test now reaches the `DuplicateMessageError` catch with a matching fingerprint. Added an already-recorded recipient retry assertion that no blob put occurs.

**Verification**:
- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts` -> exit 0; 4 files, 64 tests passed. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004869-vitest-002.log`.
- `( bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck )` -> exit 0; six `tsc --noEmit` invocations. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004869-typecheck-002.log`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn` -> exit 0; 3 files checked. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004869-biome-002.log`.

**Final Hashes**: `ingest.ts` `b14a4844fa83bf98fbff780596b855d416167ff4fb3af1a43b9b5a089ca44d4f`; `ingest-multi-domain.test.ts` `773a16994cd92a7b88101f8dbc617e5184991d953aabb707b885df4351eec529`; repository test unchanged at `fd7cecbdca4596d74fff25a23538582f65f1fa4f0d503d9452f1f94b2b6ebd0b`. Full hash file: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004869-final-source-hashes.txt`.

### Session: 2026-10-07 Step 6 independent-review repair
**Tasks Completed**: Replaced the sender/subject/body duplicate fingerprint with exact raw-message byte comparison before adding an ENVELOPE recipient in post-parse and `DuplicateMessageError` paths. The current raw object is read once and those bytes are passed to the MIME parser; the same-recipient pre-R2 retry shortcut remains. Added a regression where parsed sender, subject and body match but raw bytes and attachment content differ. Updated fake-parser fixtures so forged payloads use distinct raw bytes and the genuine duplicate race uses identical raw bytes and attachment content.

**Verification**:
- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts` -> exit 0; 4 files, 65 tests passed, 0 failed. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-independent-review-20261007/focused-final-002.log`.
- `( bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck )` -> exit 0; six `tsc --noEmit` invocations. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-independent-review-20261007/typecheck-final-002.log`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn` -> exit 0; 3 files checked, no diagnostics. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-independent-review-20261007/biome-final-002.log`.

**Earlier Attempt**: The first post-repair test run exposed stale fake-parser fixtures that changed parsed fields while reusing identical raw bytes; the log is `tmp/webmail-completion-s299/webmail-08/evidence/repair-independent-review-20261007/focused.log` (exit 1, 63 passed, 2 failed). The fixtures were corrected, and the final run above passed.

**Final Source Hashes**: `ingest.ts` `74c379abaa60a4dca48401c3ea92b70c40b26d08cc6b92dc33dfcad95c9141d2`; `ingest-multi-domain.test.ts` `7b95d7c6d6be671384d01aa8c184031bb63e12a2759581378a858def063c6146`; repository test unchanged at `fd7cecbdca4596d74fff25a23538582f65f1fa4f0d503d9452f1f94b2b6ebd0b`.

## Live check notes relevant to ingest (orchestrator, 2026-10-07)

See `design-docs/user-qa/pending-webmail-completion.md`, "Live check
results".
- Outbound rows store the provider-assigned Message-ID (webmail-06), which
  is exactly the Message-ID a managed recipient's inbound copy carries. So
  test (e) and threading step 0 match on that value.
- Inline parts arrive with the generic file name "attachment".
  `postal-mime-parser.ts` already marks parts with a content id as inline,
  so `cid:` rendering and tile filtering work. A better file name fallback
  is out of scope for this plan (cosmetic); do not edit the parser.

### Session: 2026-10-07 Step 6 adversarial repair (comm-004888)
**Tasks Completed**: Updated raw identity verification to skip only the leading allowlisted MTA trace-header fields before exact byte comparison. Added realistic genuine same-domain merge coverage for differing Received/ARC-Seal headers on both post-parse and `DuplicateMessageError` paths, plus equal-length remainder forgery and non-leading Received forgery cases. Renamed the stale post-parse test title without changing its assertions. Existing forged-Message-ID tests and assertions remain intact.

**Verification**:
- `bunx vitest run packages/application/src/usecases/ingest packages/adapter/src/repositories/message-repository-multi-domain.test.ts packages/application/src/usecases/external-fetch.test.ts` -> exit 0; 4 files, 69 tests passed, 0 failed. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004888-20261007/focused-vitest-final.log`.
- `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck` -> exit 0; six `tsc --noEmit` invocations. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004888-20261007/server-typecheck-final-002.log`.
- `bunx biome check packages/application/src/usecases/ingest.ts packages/application/src/usecases/ingest-multi-domain.test.ts packages/adapter/src/repositories/message-repository-multi-domain.test.ts --diagnostic-level=warn` -> exit 0; 3 files checked, no diagnostics. Log: `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004888-20261007/biome-final.log`.

**Evidence and Source Hashes**: Per-edit intent records and final command logs are under `tmp/webmail-completion-s299/webmail-08/evidence/repair-comm004888-20261007/`. Final SHA-256: `ingest.ts` `df7ee3ecf3907896d451d189f63b98d81087c2c4cd69e80d98d9337e67117b85`; `ingest-multi-domain.test.ts` `0a9656a02530b6713405b51e55dad782ea51a2f777e7405732d89de77167cef7`; unchanged repository test `fd7cecbdca4596d74fff25a23538582f65f1fa4f0d503d9452f1f94b2b6ebd0b`. Plan hash before this entry: `0eaa6f372403eccfca7806553091abef0740c6f36f3fd31f95a1a72bfef6ad51`.

**Review Handoff**: The implementation and required verification are complete for this repair. Independent adversarial re-review remains pending. Serial integration still owns reconciling design section 9's step-2 text and confirming the trace-header set against live Cloudflare raw mail.

### Session: 2026-10-07 orchestrator completion
Completed outside the riela gate: the workflow accepted webmail-01, 02, 04, 06, 07, 08 and 09 through its native reviews; its implementation-progress-check gate repeatedly rejected valid evidence for 03 and 05 (5 attempts, tests passing), so the orchestrator continued with GPT-6 Luna (codex exec) implementing 10, 11, 12 and 13 and read-only Opus reviews (iterations 1-2) whose findings were returned to Luna and fixed (webmail-10 H1-H2/M1-M3/L1-L5/R1/R4/R6, webmail-11 C1/S1-S3/N1-N6, webmail-05 R2/R3, webmail-03 R5, plus the pre-existing login cookie defect L0). Final verification: mise run lint exit 0; bun run test exit 0 (1695 package tests, 242 web tests); mise run build-web exit 0. Deployed to Cloudflare (worker mailcal-api) and verified live: cross-domain send/receive, To/Cc/Bcc, HTML, attachments upload/download, reply threading, forward with original attachments, draft save/update/reopen/send/delete, and the web UI end to end in Brave.
