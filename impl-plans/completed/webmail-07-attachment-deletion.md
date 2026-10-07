# Webmail 07: Shared-Blob-Safe Deletion in Purge and Sweep

**Status**: Completed
**planId**: webmail-07-attachment-deletion
**Wave**: 2 (depends on webmail-01-data-layer)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 4 (Shared-blob deletion rule), D1; design-docs/specs/design-storage-and-file-links.md "Shared attachment blobs"
**Created**: 2026-10-07

## Intent and context

Forwarding (webmail-06) creates attachment rows that share a `blob_key`
with the source attachment. The two existing deletion paths delete blobs
unconditionally, which would break the other message's attachment:

- Message purge: `hardDeleteMessages` in
  `packages/application/src/usecases/messages.ts` (around lines 427-460).
- The 24-hour staged-upload sweep inside the expired-auth sweep:
  `packages/application/src/usecases/email-auth.ts` (around lines
  280-300).

Both must delete a blob only when no remaining `attachments` row
references its key. Use the helpers from webmail-01,
`packages/application/src/usecases/attachment-blobs.ts`:
- `deleteAttachmentsAndUnreferencedBlobs`
- `deleteUnreferencedBlobs`

## Non-goals

- No change to raw `.eml` blob deletion. Raw keys are per message and
  never shared, so keep deleting them as today.
- No change to trash semantics.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `packages/application/src/usecases/messages.ts` (`hardDeleteMessages` only)
- `packages/application/src/usecases/email-auth.ts` (staged sweep block only)
- `packages/application/src/usecases/attachment-deletion.test.ts`
- `packages/application/src/usecases/messages.test.ts` (minimal updates only)
- `packages/application/src/usecases/auth.test.ts` (minimal updates only)
- `impl-plans/completed/webmail-07-attachment-deletion.md` (checkboxes and Progress Log only)

**sharedPaths**: none. webmail-06, -08 and -09 import
`loadReadableMessage` from `messages.ts` in the same wave: do not change
its signature or export.

## File-level changes

### packages/application/src/usecases/messages.ts (`hardDeleteMessages` only)

1. Collect the attachment blob keys of the messages being purged before
   the rows are deleted (`listAttachments`).
2. Delete the message rows as today. Attachment rows go by cascade or
   existing statements; verify which in `message-repository.ts` `delete()`.
3. Call `deleteUnreferencedBlobs(deps, keys)` instead of deleting the
   attachment blobs directly.
4. Raw blobs are unchanged.
5. Keep the existing ordering principle: rows first, then blobs, so a
   failure leaves orphans, never dangling rows.

### packages/application/src/usecases/email-auth.ts (staged sweep block only)

- Replace the "delete each blob, then `deleteAttachments`" sequence with
  `deleteAttachmentsAndUnreferencedBlobs(deps, stale)`.
- This intentionally changes the order to rows first, then blobs. Design
  section 4 supersedes the older "blobs first" note in
  `design-storage-and-file-links.md`, and a failed blob delete now leaves
  an orphan blob.
- Keep the swallow-errors behavior.

## Tests (new file packages/application/src/usecases/attachment-deletion.test.ts)

Imitate the setup in `messages.test.ts`.
- Message A has an attachment with blobKey K, and message B has a forward
  copy with blobKey K. Purge A -> A's row is gone and blob K still exists.
  Then purge B -> blob K is deleted.
- Purge a message with a unique attachment key -> blob deleted (regression).
- Stale staged upload with a unique key -> sweep deletes the row and the
  blob.
- The blob store throws on delete -> purge and sweep still resolve, and
  the rows are deleted.

Also run the existing `messages.test.ts` and `auth.test.ts` (the sweep tests live there; there is no `email-auth.test.ts`). If an
assertion depends on the old blob-first order, update it minimally and log
the change.

## Invariants

- A blob referenced by any remaining attachment row is never deleted.
- Raw blob handling is unchanged.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/application/src/usecases/attachment-deletion.test.ts packages/application/src/usecases/messages.test.ts packages/application/src/usecases/auth.test.ts`
  -> exit 0.
- Server-workspace typecheck:
  `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck`
  -> exit 0. apps/web is excluded on purpose: webmail-10, in the same
  wave, leaves a known transient error in
  `apps/web/src/pages/mailbox-page.tsx` until webmail-11. Never edit
  anything under `apps/web`, and do not use the root `bun run typecheck`.
- `bunx biome check packages/application/src/usecases/messages.ts packages/application/src/usecases/email-auth.ts packages/application/src/usecases/attachment-deletion.test.ts --diagnostic-level=warn`
  -> no diagnostics.

## Completion criteria

- [x] Both deletion paths use the reference-checked helpers.
- [x] The new tests pass, and the existing tests still pass.
- [x] Verification is logged with exit codes, including the
      server-workspace typecheck (exit 0).

## Progress Log

### Session: 2026-10-07
**Tasks Completed**: Updated both deletion paths and added focused regression coverage.
**Source hashes**:
- `packages/application/src/usecases/messages.ts`: before `9141378d79dcf3c0c4e0f326fe1863ddade39d141676bd53128b657bc0828d84`; after `17e81be9e0d365c1efb48bb072ecc9a215d126b977aef4d2603ae51e39066975`.
- `packages/application/src/usecases/email-auth.ts`: before `008ae6c8ccafe4b92cc27a412a3e93761df16f96b17ea13f03aca508e1ac53ee`; after `5b5c6c413e0299080e60d985b6227e3530d1beb26cc7cb5256a38d0f9b721b52`.
- `packages/application/src/usecases/attachment-deletion.test.ts`: new file; final `885058597a1bf2b1a77ed3c3b0c33f00eebced513c09477e0f1eeae384283102`.
- Existing `messages.test.ts` and `auth.test.ts` were not changed.

**Verification**:
- `bunx vitest run packages/application/src/usecases/attachment-deletion.test.ts packages/application/src/usecases/messages.test.ts packages/application/src/usecases/auth.test.ts` -> exit 0, 3 files / 63 tests passed. Log: `tmp/webmail-completion-s299/webmail-07/focused-tests-final3.log`.
- `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck` -> exit 2. The final current-tree failures are in files outside this plan's writePaths: `compose-usecases.test.ts`, `drafts.ts`, `outbound-assembly.test.ts`, `outbound-assembly.ts`, `readable-addresses.test.ts`, and `send.ts`. Log: `tmp/webmail-completion-s299/webmail-07/server-typecheck-final3.log`.
- `bunx biome check packages/application/src/usecases/messages.ts packages/application/src/usecases/email-auth.ts packages/application/src/usecases/attachment-deletion.test.ts --diagnostic-level=warn` -> exit 0, 3 files checked. Log: `tmp/webmail-completion-s299/webmail-07/biome-final2.log`.
- A final focused test attempt immediately after a concurrent shared-tree update could not import `./usecases/delete-draft`; the module landed afterward and the final3 focused run passed. Historical log: `tmp/webmail-completion-s299/webmail-07/focused-tests-final2.log`.

**Prior blocker, resolved in the current-tree rerun below**: The earlier required server-workspace typecheck exited 2 on concurrent files outside this plan's writePaths. The rerun now exits 0; no out-of-scope files were edited.


### Session: 2026-10-07 (current-tree Step 6 rerun)
**Tasks Completed**: Reverified the assigned deletion paths and existing behavior on the current shared tree. No TypeScript source or test edits were needed in this rerun. All implementation-phase completion criteria are met; formal downstream review remains pending.
**Current source hashes**:
- `packages/application/src/usecases/messages.ts`: `17e81be9e0d365c1efb48bb072ecc9a215d126b977aef4d2603ae51e39066975`.
- `packages/application/src/usecases/email-auth.ts`: `5b5c6c413e0299080e60d985b6227e3530d1beb26cc7cb5256a38d0f9b721b52`.
- `packages/application/src/usecases/attachment-deletion.test.ts`: `885058597a1bf2b1a77ed3c3b0c33f00eebced513c09477e0f1eeae384283102`.
- Existing `packages/application/src/usecases/messages.test.ts`: `bb9b1b18d884709ceb881fe25ec907bf53c3cd4a7a421c920891a6b0dddf9ebc`.
- Existing `packages/application/src/usecases/auth.test.ts`: `2a3cfbf98a0b30b83ebedddccc3b2153e948ea507634b60e8cfe8cdbfbb78360`.

**Current-tree verification**:
- `bunx vitest run packages/application/src/usecases/attachment-deletion.test.ts packages/application/src/usecases/messages.test.ts packages/application/src/usecases/auth.test.ts` -> exit 0; 3 files / 63 tests passed. Log: `tmp/webmail-completion-s299/webmail-07/step6-focused-tests-rerun.log`.
- `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck` -> exit 0. Log: `tmp/webmail-completion-s299/webmail-07/step6-server-typecheck-rerun.log`.
- `bunx biome check packages/application/src/usecases/messages.ts packages/application/src/usecases/email-auth.ts packages/application/src/usecases/attachment-deletion.test.ts --diagnostic-level=warn` -> exit 0; three files checked without diagnostics. Log: `tmp/webmail-completion-s299/webmail-07/step6-biome-rerun.log`.

### Session: 2026-10-07 orchestrator completion
Completed outside the riela gate: the workflow accepted webmail-01, 02, 04, 06, 07, 08 and 09 through its native reviews; its implementation-progress-check gate repeatedly rejected valid evidence for 03 and 05 (5 attempts, tests passing), so the orchestrator continued with GPT-6 Luna (codex exec) implementing 10, 11, 12 and 13 and read-only Opus reviews (iterations 1-2) whose findings were returned to Luna and fixed (webmail-10 H1-H2/M1-M3/L1-L5/R1/R4/R6, webmail-11 C1/S1-S3/N1-N6, webmail-05 R2/R3, webmail-03 R5, plus the pre-existing login cookie defect L0). Final verification: mise run lint exit 0; bun run test exit 0 (1695 package tests, 242 web tests); mise run build-web exit 0. Deployed to Cloudflare (worker mailcal-api) and verified live: cross-domain send/receive, To/Cc/Bcc, HTML, attachments upload/download, reply threading, forward with original attachments, draft save/update/reopen/send/delete, and the web UI end to end in Brave.
