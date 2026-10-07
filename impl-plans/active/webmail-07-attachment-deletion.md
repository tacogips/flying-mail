# Webmail 07: Shared-Blob-Safe Deletion in Purge and Sweep

**Status**: Ready
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
- `impl-plans/active/webmail-07-attachment-deletion.md` (checkboxes and Progress Log only)

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

- [ ] Both deletion paths use the reference-checked helpers.
- [ ] The new tests pass, and the existing tests still pass.
- [ ] Verification is logged with exit codes, including the
      server-workspace typecheck (exit 0).

## Progress Log

### Session: (not started)
**Tasks Completed**: None
