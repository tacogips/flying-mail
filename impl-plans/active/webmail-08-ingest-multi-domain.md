# Webmail 08: Multi-Domain Inbound Ingest

**Status**: Ready
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
- `impl-plans/active/webmail-08-ingest-multi-domain.md` (checkboxes and Progress Log only)

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

- [ ] The ingest flow matches steps 1-7.
- [ ] Tests (a)-(e) and the Reply-To test pass.
- [ ] The existing `ingest.test.ts` and `external-fetch.test.ts` pass.
- [ ] Verification is logged with exit codes, including the
      server-workspace typecheck (exit 0).

## Progress Log

### Session: (not started)
**Tasks Completed**: None

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
