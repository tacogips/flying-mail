# Webmail 01: Data Layer (migration 0013, Message fields, repository contract)

**Status**: Ready
**planId**: webmail-01-data-layer
**Wave**: 1 (no dependencies)
**Design Reference**: design-docs/specs/design-webmail-completion.md sections 2, 4 (shared-blob rule), 6 (conditional draft ops), 9 (inbound dedup scope)
**Created**: 2026-10-07

## Intent and context

The webmail features need storage-level support:
- Reply-To and forward linkage on messages.
- A per-domain inbound dedup index.
- Conditional (race-safe) draft writes.
- An atomic ENVELOPE-recipient insert.
- A blob reference count used before any blob delete.

This plan pins the domain and repository contract that the wave-2 plans
(webmail-06, -07, -08, -09) build on, and implements it in the domain
entity, the D1/libsql adapter, and the in-memory fake.

The repo is a Bun + TypeScript monorepo with maximum TS strictness and
Biome. Migrations are plain `.sql` files that are auto-loaded from
`apps/api/migrations` (`apps/api/src/server.ts:loadMigrationFiles`,
`packages/adapter/src/repositories/test-support.ts`), so no registry needs
editing.

## Non-goals

- No use case behavior changes: send, drafts, ingest and purge belong to
  webmail-06/07/08.
- No GraphQL or web changes.
- Never edit migrations 0001-0012.
- Do not change the filter or permission SQL in
  `message-repository-queries.ts`.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. The working tree holds about 251 uncommitted rename changes, and
  you must never revert diffs you did not make.
- No deploy, no remote wrangler, no remote D1.
- Before each edit, re-read the file. Record `shasum -a 256 <file>` before
  and after in this plan's Progress Log.
- If the pre-edit hash differs from your last recorded hash, another worker
  touched the file: re-read and merge, and never overwrite blindly.
- Edit only `writePaths`/`sharedPaths`. Any other required change is logged
  as a blocker, not made.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md` (serial
  reconciliation owns them).
- A touched TS file must stay under 1000 lines. Put new tests in new files
  when the existing test file is over 800 lines.

## Write ownership

**writePaths**
- `apps/api/migrations/0013_webmail_completion.sql`
- `packages/domain/src/entities/message.ts`
- `packages/domain/src/entities/message.test.ts`
- `packages/domain/src/entities/attachment.ts`
- `packages/domain/src/entities/attachment.test.ts`
- `packages/application/src/ports/message-repository.ts`
- `packages/application/src/test-support/message-repository-fake.ts`
- `packages/application/src/usecases/attachment-blobs.ts`
- `packages/application/src/usecases/attachment-blobs.test.ts`
- `packages/adapter/src/repositories/message-repository.ts`
- `packages/adapter/src/repositories/message-repository-webmail.ts`
- `packages/adapter/src/repositories/message-repository-webmail.test.ts`
- `packages/adapter/src/migrations/webmail-completion-migration.test.ts`
- `impl-plans/active/webmail-01-data-layer.md` (checkboxes and Progress Log only)

**sharedPaths**: none.

## File-level changes

### apps/api/migrations/0013_webmail_completion.sql (new)

Statements, in order:
1. `ALTER TABLE messages ADD COLUMN reply_to TEXT`
2. `ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT` (no FK).
3. `DROP INDEX IF EXISTS idx_messages_rfc_id`
4. `CREATE UNIQUE INDEX idx_messages_rfc_id_direction_domain ON messages(rfc_message_id, direction, domain_id) WHERE rfc_message_id IS NOT NULL`
5. `CREATE INDEX idx_attachments_blob_key ON attachments(blob_key)`

Pitfall: the runner splits on `;` with no comment awareness
(`packages/adapter/src/migrations/runner.ts`). Comments must not contain a
semicolon. Imitate the comment style of `0009_mail_addresses.sql`.

### packages/domain/src/entities/message.ts (+ message.test.ts)

- `Message` gains `readonly replyTo: EmailAddress | null` and
  `readonly forwardedFromMessageId: MessageId | null`.
- `CommonMessageInput` gains optional `replyTo?: EmailAddress | null` and
  `forwardedFromMessageId?: MessageId | null`. `baseMessage` defaults both
  to `null`.
- `DraftContentPatch` gains optional fields: `replyTo`, `domainId`,
  `threadId`, `inReplyTo`, `references`, `forwardedFromMessageId`.
  `updateDraftMessage` applies them with the same "undefined = keep"
  semantics it already uses for `textBody`.
- Tests:
  - A created message defaults both new fields to `null`.
  - The patch keeps them when undefined and replaces them when given.

### packages/domain/src/entities/attachment.ts (+ attachment.test.ts)

Add:

`copyAttachmentForForward(source: Attachment, input: { id: AttachmentId; messageId: MessageId; createdAt: string }): Attachment`

- The copy keeps `blobKey`, `fileName`, `contentType`, `size` and `kind`.
- It sets `inline: false` and `contentId: null`.
- Test: source inline with a contentId -> copy has the same blobKey,
  inline false, contentId null and the new id/messageId.

### packages/application/src/ports/message-repository.ts

Add these exact signatures to `MessageRepository`:

```ts
findInboundByRfcMessageId(rfcMessageId: string, domainId: DomainId): Promise<Message | null>;
addEnvelopeRecipient(messageId: MessageId, address: EmailAddress): Promise<void>;
saveIfDraft(message: Message): Promise<boolean>;
deleteDraftIfDraft(id: MessageId): Promise<boolean>;
countAttachmentsByBlobKeys(blobKeys: readonly string[]): Promise<ReadonlyMap<string, number>>;
```

Also export
`class DuplicateMessageError extends Error { name = "DuplicateMessageError" }`
from this port file. `insertWithRelations` throws it when the
`(rfc_message_id, direction, domain_id)` unique index rejects the insert.

Semantics:
- `findByRfcMessageId` (existing) keeps returning any row. Make it
  deterministic with `ORDER BY created_at ASC LIMIT 1`.
- `findInboundByRfcMessageId` matches only
  `direction='INBOUND' AND domain_id=? AND rfc_message_id=?`.
- `addEnvelopeRecipient` is a single atomic idempotent statement:
  `INSERT INTO message_recipients (message_id, kind, address, name, position) SELECT ?, 'ENVELOPE', ?, NULL, COALESCE(MAX(position), -1) + 1 FROM message_recipients WHERE message_id = ? AND kind = 'ENVELOPE' AND NOT EXISTS (...same message/kind/address...)`.
  Calling it twice with the same address leaves one row.
- `saveIfDraft` is `UPDATE messages SET <every mutable column incl. status, delivery_status, rfc_message_id, raw_key, raw_size, domain_id, thread_id, in_reply_to, references_json, reply_to, forwarded_from_message_id> WHERE id = ? AND status = 'DRAFT'`.
  It returns `rowsAffected > 0`. It is used both for draft edits and for
  the DRAFT->SENT claim.
- `deleteDraftIfDraft` is a conditional
  `DELETE FROM messages WHERE id = ? AND status = 'DRAFT'`, returning
  whether a row was deleted. When it deletes, also remove dependent rows
  the same way the existing `delete(ids)` does (recipients, tags, spam,
  events, fetch states). Do not delete attachment blobs: the caller does
  that.
- `countAttachmentsByBlobKeys` returns the count of remaining
  `attachments` rows per key. Keys with 0 rows map to 0.

### packages/adapter/src/repositories/message-repository.ts and message-repository-webmail.ts (new)

- Put the new SQL constants and statement builders in
  `message-repository-webmail.ts`, so `message-repository.ts` (703 lines)
  stays small. Wire them into the repository object returned by the
  existing factory.
- Map the `reply_to` and `forwarded_from_message_id` columns in
  `MessageRow`, the row->entity mapper and `messageParams`. Imitate the
  existing `in_reply_to` handling; `reply_to` parses through
  `createEmailAddress` when not null.
- Extend `UPSERT_MESSAGE_SQL`'s `ON CONFLICT DO UPDATE SET` with
  `domain_id`, `rfc_message_id`, `in_reply_to`, `references_json`,
  `reply_to` and `forwarded_from_message_id`. This fixes the
  `rfc_message_id` loss on `sendDraft`.
- `insertWithRelations`: catch the driver error whose message contains
  `UNIQUE constraint failed` and names `messages.rfc_message_id`, and
  rethrow `DuplicateMessageError`. Rethrow anything else unchanged.

### packages/application/src/test-support/message-repository-fake.ts

Implement every new method with identical semantics:
- Enforce the `(rfcMessageId, direction, domainId)` uniqueness in
  `insertWithRelations`, throwing `DuplicateMessageError`.
- Make the conditional draft ops honor `status === DRAFT`.

### packages/application/src/usecases/attachment-blobs.ts (new, + attachment-blobs.test.ts)

```ts
export async function deleteAttachmentsAndUnreferencedBlobs(deps: Pick<AppDependencies, "messageRepository" | "blobs">, attachments: readonly Attachment[]): Promise<void>;
export async function deleteUnreferencedBlobs(deps: Pick<AppDependencies, "messageRepository" | "blobs">, blobKeys: readonly string[]): Promise<void>;
```

- The first deletes rows (`deleteAttachments`), then calls the second with
  the unique keys.
- The second counts references and deletes only keys with 0 references.
  Each blob delete failure is swallowed (`.catch(() => undefined)`, as in
  `messages.ts:hardDeleteMessages`), so the outcome is an orphan, never a
  thrown error.

## Tests (new files)

- `packages/adapter/src/migrations/webmail-completion-migration.test.ts`
  (imitate `external-mail-migration.test.ts`):
  - After applying all migrations, the two columns exist.
  - Two INBOUND rows with the same rfc id on different domains -> both
    insert.
  - Same rfc id, same domain, same direction -> the second insert fails.
  - An OUTBOUND and an INBOUND row with the same rfc id and domain -> both
    insert.
- `packages/adapter/src/repositories/message-repository-webmail.test.ts`
  (imitate `message-repository-extra-statements.test.ts`):
  - `findInboundByRfcMessageId` ignores OUTBOUND rows and other domains.
  - `addEnvelopeRecipient` twice -> one row, position appended after
    existing ENVELOPE rows.
  - `saveIfDraft` on a DRAFT -> true and the row is updated; on a SENT row
    -> false and the row is unchanged.
  - A claim (DRAFT->SENT) followed by a second claim -> false.
  - `deleteDraftIfDraft` on a non-draft -> false.
  - `countAttachmentsByBlobKeys` with two rows sharing a key -> 2, and 0
    for an unknown key.
  - Insert duplicate (rfc, INBOUND, domain) -> rejects with
    `DuplicateMessageError`.
  - Save after setting `rfcMessageId` -> persisted (regression for the
    upsert set).
- `packages/application/src/usecases/attachment-blobs.test.ts`:
  - Shared key with 1 remaining reference -> blob kept.
  - Last reference -> blob deleted.
  - A blob delete that throws -> resolves without error.

## Invariants

- Existing tests stay green. `findByRfcMessageId` callers keep working.
- Outbound rows keep a single from-domain `domain_id`.

## Verification (run from repo root, record exit codes in Progress Log)

- `bunx vitest run packages/domain packages/adapter/src/migrations packages/adapter/src/repositories packages/application/src/usecases/attachment-blobs.test.ts`
  -> exit 0, all pass.
- `bun run typecheck` -> exit 0.
  - If unrelated wave-1 plans have broken it, record which files and stop
    rather than editing them.
- `bunx biome check apps/api/migrations packages/domain/src/entities packages/application/src/ports/message-repository.ts packages/application/src/test-support/message-repository-fake.ts packages/application/src/usecases/attachment-blobs.ts packages/application/src/usecases/attachment-blobs.test.ts packages/adapter/src/repositories --diagnostic-level=warn`
  -> no diagnostics.
- `wc -l packages/adapter/src/repositories/message-repository.ts packages/application/src/test-support/message-repository-fake.ts`
  -> each under 1000.

## Completion criteria

- [ ] Migration 0013 is added and applies cleanly in tests.
- [ ] Message/Attachment domain changes and tests are done.
- [ ] Port methods and `DuplicateMessageError` are added; adapter and fake
      are implemented.
- [ ] `attachment-blobs.ts` helpers and tests are done.
- [ ] All verification commands pass, with exit codes logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
**Notes**: Record file hashes before/after each edit here.
