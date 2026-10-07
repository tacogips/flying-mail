# Webmail 06: Send, Drafts, Forward Attachments, deleteDraft (application layer)

**Status**: Ready
**planId**: webmail-06-send-drafts-forward
**Wave**: 2 (depends on webmail-01-data-layer, webmail-02-outbound-delivery)
**Design Reference**: design-docs/specs/design-webmail-completion.md sections 4, 6, 8 (assembler, Message-ID reconciliation, sender rules, error mapping), decisions D1-D4, D6, D9, D10, D13
**Created**: 2026-10-07

## Intent and context

This plan implements the server behavior behind compose, drafts and
forward. It fixes the audited defects:

1. Attachment ids can be bound from any message (an IDOR that moves the
   attachment).
2. Draft updates only add attachments, never move `domain_id`, and ignore
   linkage.
3. `sendDraft` loses `rfc_message_id` (fixed at storage level by
   webmail-01) and delivers no attachments.
4. `retrySend` drops attachments.
5. Delivery failures store `error.name` instead of an address-free reason.
6. `resolveThreadContext` does not check read access on the parent.
7. `listSendableAddresses` falls back to `*@domain` for every USER.
8. A DISABLED provisioned address can be used as `from`.

It also adds forwarding of original attachments, a race-safe draft
lifecycle, and `deleteDraft`.

Contracts used, from wave 1:
- webmail-01: `MessageRepository.saveIfDraft`, `deleteDraftIfDraft`,
  `countAttachmentsByBlobKeys`; `copyAttachmentForForward`;
  `Message.replyTo`/`forwardedFromMessageId`; `DraftContentPatch` linkage
  fields; `deleteAttachmentsAndUnreferencedBlobs`.
- webmail-02: `OutboundMail.messageId/replyTo/inReplyTo/references`,
  `OutboundAttachment.contentId`, `MailSender.send` returning
  `MailSendReceipt`, `readDeliveryReason`, `MailDeliveryReason`.

## Non-goals

- No GraphQL or REST changes (webmail-12).
- No ingest changes (webmail-08).
- No purge or sweep changes (webmail-07).
- No compose prefill (webmail-09).
- No custom-header persistence.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`/`sharedPaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- `send.ts` is 609 lines: put new logic in the new files below so that
  `send.ts` and `drafts.ts` each stay under 800.

## Write ownership

**writePaths**
- `packages/application/src/usecases/attachment-binding.ts`
- `packages/application/src/usecases/attachment-binding.test.ts`
- `packages/application/src/usecases/outbound-assembly.ts`
- `packages/application/src/usecases/outbound-assembly.test.ts`
- `packages/application/src/usecases/send.ts`
- `packages/application/src/usecases/send.test.ts` (only assertions on changed behavior)
- `packages/application/src/usecases/send-webmail.test.ts`
- `packages/application/src/usecases/drafts.ts`
- `packages/application/src/usecases/drafts.test.ts` (only assertions on changed behavior)
- `packages/application/src/usecases/drafts-webmail.test.ts`
- `packages/application/src/usecases/delete-draft.ts`
- `packages/application/src/usecases/delete-draft.test.ts`
- `impl-plans/active/webmail-06-send-drafts-forward.md` (checkboxes and Progress Log only)

**sharedPaths**
- `packages/application/src/usecases.ts`: add only the `deleteDraft` entry
  to `UseCases` and its wiring. webmail-12 edits the same file later (it
  depends on this plan).

Read-only imports (do not edit): `./messages` (`loadReadableMessage`,
owned by webmail-07 in the same wave), `./attachment-blobs` (webmail-01),
`../ports/mail-sender` (webmail-02).

## File-level changes

### packages/application/src/usecases/attachment-binding.ts (new)

```ts
export async function resolveOwnAttachments(deps, attachmentIds: readonly AttachmentId[] | undefined, draftId: MessageId | null): Promise<readonly Attachment[]>;
export async function resolveForwardSources(deps, viewer: Viewer, forwardedFromMessageId: MessageId | undefined, forwardAttachmentIds: readonly AttachmentId[] | undefined): Promise<{ readonly source: Message | null; readonly attachments: readonly Attachment[] }>;
export function assertOutboundAttachmentLimits(all: readonly Pick<Attachment, "size">[]): void; // 32 files, MAX_OUTBOUND_TOTAL_BYTES -> BadUserInputError("...", "attachmentIds")
```

**`resolveOwnAttachments`** (D3)
- Each id must exist with either `messageId === null` (staged) or
  `messageId === draftId`.
- Otherwise throw `NotFoundError("Attachment", id)`. This includes ids
  bound to any other message.

**`resolveForwardSources`** (D2)
- A non-empty `forwardAttachmentIds` without `forwardedFromMessageId`
  throws `BadUserInputError(..., "forwardedFromMessageId")`.
- The source is loaded with `loadReadableMessage(deps, viewer, id)` from
  `./messages`. `null` -> `NotFoundError("Message", id)`.
- A source with status DRAFT -> `BadUserInputError(..., "forwardedFromMessageId")`.
- Every attachment must have `messageId === source.id`, else
  `NotFoundError("Attachment", id)`.

**Replaces.** This replaces the existing `loadOutboundAttachments`
(send.ts:147-177), which only checked existence. Remove it, or make it
delegate here. Its callers are `send.ts` and `drafts.ts` only.

### packages/application/src/usecases/outbound-assembly.ts (new)

```ts
export async function assembleOutbound(deps, message: Message, options?: { readonly customHeaders?: ReadonlyMap<string, string> }): Promise<{ readonly mail: OutboundMail; readonly raw: string }>;
```

**Loading.** Load the stored recipients (`listRecipients`) and attachments
(`listAttachments`), then the bytes (`readAttachmentBytes` from `./send`).

**MIME build.** Build the raw message with `deps.mimeBuilder.build`:
- Pass to and cc, and **never pass bcc**.
- `replyTo` when set, `messageId = message.rfcMessageId`.
- `inReplyTo` and `references` from the message.
- Attachments with `contentId` and `inline`.

**Returned `OutboundMail`.**
- to, cc and bcc from the recipient kinds.
- replyTo, subject, `text ?? ""`, html.
- `messageId`, `inReplyTo`, `references`. `messageId` feeds only the MIME
  `.eml` and the SMTP relay; the webmail-02 adapters never send it as a
  header (the binding rejects it, design section 8).
- `customHeaders` as `headers`.
- Attachments including `contentId`.
- `raw`.

**Shared by all three sends.** `sendMessage`, `sendDraft` and `retrySend`
all use this, so they deliver identical content.

### packages/application/src/usecases/send.ts

**`SendMessageInput`.** Gains optional `replyTo?: string`,
`forwardedFromMessageId?: MessageId` and
`forwardAttachmentIds?: readonly AttachmentId[]`. `replyTo` is parsed with
`createEmailAddress(value, "replyTo")`.

**Sender rule (D13).** After the domain lookup, if `mailAddressRepository`
has a row for `from` with status DISABLED, throw
`BadUserInputError(..., "from")`. Find the exact lookup method name in
`packages/application/src/ports/mail-address-repository.ts`.

**`resolveThreadContext(deps, viewer, inReplyToMessageId)`.**
- Add the `viewer` parameter.
- Load the parent through `loadReadableMessage`. Unreadable -> NotFound.
- Update every caller (drafts.ts, send.ts).

**`sendMessage` flow.** The invariant is that the row is written before
the provider call.
1. Validate the input.
2. Resolve own attachments and forward sources, then check the combined
   limits.
3. Create the QUEUED outbound message with:
   - `rfcMessageId = ${id}@${domain.name}`
   - `rawKey = buildRawMessageBlobKey(id)`
   - `replyTo` and `forwardedFromMessageId`
4. `insertWithRelations` with the own attachments bound
   (`attachToMessage`) plus forward copies
   (`copyAttachmentForForward` with fresh ids from `deps.random.uuid()`).
5. `assembleOutbound(customHeaders)`.
6. `blobs.put(rawKey, raw)`.
7. `deliver`.

**`deliver(deps, message, mail)`.**
- `deliverMail` returns `MailSendReceipt`. The SMTP relay path returns
  `{providerMessageId:null}`.
- On error, the stored reason is:
  - `"RELAY_ERROR"` when the failure came from the external SMTP relay
    branch;
  - otherwise `readDeliveryReason(error)`.
  - Never store `error.name` or `error.message`.
- On success, if `receipt.providerMessageId`, normalized with surrounding
  `<>` stripped and trimmed, is non-empty and differs from
  `message.rfcMessageId`, set `rfcMessageId` to it on the sent message
  before `save`.
- On the binding path the provider always assigns the Message-ID (we never
  send ours as a header; live check in
  `design-docs/user-qa/pending-webmail-completion.md` items 1-2), so the
  provider id is expected to always differ and always replaces ours. Our
  generated id stays only in the stored `.eml`. The SMTP relay path
  returns `null` and keeps ours.

**`retrySend`.** Build its delivery with `assembleOutbound` (no custom
headers).

**`createListSendableAddressesUseCase` fallback (D13).** Replace
`fallbackPatterns` for USER viewers:
- An ADMIN gets `*@domain` unless a DENY rule matches the domain with
  pattern `*` or `*@domain`.
- A MEMBER gets only its ALLOW rule patterns for that domain
  (`rule.domainId === null || rule.domainId === domain.id`), rendered as
  stored, without a matching DENY.
- A VIEWER gets none.
- API-key behavior is unchanged.
- Read `packages/application/src/policies/authorization.ts` for the
  rule shapes and reuse its matchers.
- Never combine one rule's domain with another rule's pattern.

### packages/application/src/usecases/drafts.ts

**`SaveDraftInput`.** Gains `replyTo?`, `forwardedFromMessageId?` and
`forwardAttachmentIds?`.

**Create.**
- As today, plus `replyTo`, `forwardedFromMessageId` (validated via
  `resolveForwardSources`) and forward copies.
- The thread context comes from the read-checked `resolveThreadContext`.

**Update** (draftId present):
1. `loadOwnDraft`.
2. Re-derive the domain from `from`. An unmanaged domain throws
   BadUserInput.
3. Run `updateDraftMessage` with a full content replacement: subject,
   from, replyTo, text, html, plus `domainId`.
4. Linkage is sticky (design section 6). Only re-resolve the thread when
   `inReplyToMessageId` is provided. Only replace `forwardedFromMessageId`
   when provided.
5. `saveIfDraft(updated)`. `false` -> `ConflictError("Draft was already sent or deleted")`.
6. `replaceRecipients`.

**Attachment replacement set** (D4), on update and in this order:
1. Compute `keep = resolveOwnAttachments(input.attachmentIds, draftId)`.
2. Delete the draft's current attachments not in `keep` with
   `deleteAttachmentsAndUnreferencedBlobs`.
3. Bind the staged ones in `keep` (`saveAttachment(attachToMessage(...))`).
4. Create forward copies, skipping any whose `blobKey` the draft already
   has (idempotent autosave).

**`sendDraft`.**
1. `loadOwnDraft` and the domain check, as today. Keep the "no To" and
   "no body" checks.
2. Build `submitted = {...submitDraft(draft, now), rfcMessageId: ${id}@${domain.name}, rawKey}`.
3. `saveIfDraft(submitted)`. `false` -> `ConflictError`. This is the
   claim; it must happen before any blob write or provider call.
4. `assembleOutbound(submitted)` -> `blobs.put(rawKey, raw)` -> update
   `rawSize` -> `deliver`.

### packages/application/src/usecases/delete-draft.ts (new)

`createDeleteDraftUseCase(deps): (viewer: Viewer, id: MessageId) => Promise<boolean>`:
1. `loadOwnDraft`. Export it from `drafts.ts` for this; the current
   behavior is NotFound for a non-draft and requires draft authority.
2. List the draft's attachments.
3. `deleteDraftIfDraft(id)`. `false` -> `NotFoundError("Draft", id)`.
4. `deleteAttachmentsAndUnreferencedBlobs(attachments)`.
5. Return true.

Wrap it in `withAsyncDomainErrorTranslation`, as the other use cases do.

### packages/application/src/usecases.ts

- Add `deleteDraft: (viewer: Viewer, id: MessageId) => Promise<boolean>` to
  the `UseCases` interface, next to `saveDraft`/`sendDraft` (around line
  234).
- Wire `createDeleteDraftUseCase(deps)` next to them (around line 571).
- Touch nothing else in this file. webmail-12 later adds compose use cases
  in a separate edit.

## Tests

Put these in new files: `attachment-binding.test.ts`,
`outbound-assembly.test.ts`, `send-webmail.test.ts`,
`drafts-webmail.test.ts`, `delete-draft.test.ts`. Use the fakes from
`packages/application/src/test-support/fakes.ts` and imitate
`send.test.ts` / `drafts.test.ts`. Update the existing `send.test.ts` /
`drafts.test.ts` only where they assert changed behavior (for example
`deliveryError` equal to an error name). List every such change in the
Progress Log.

- Send with an attachmentId bound to another message -> NOT_FOUND, and the
  original row is unchanged.
- Send with forward ids and a readable source -> new attachment rows with
  the same blobKey, inline false, and the source rows untouched.
- Forward from an unreadable source (viewer lacks MAIL_READ) -> NOT_FOUND.
- Forward of an attachment from a different message -> NOT_FOUND.
- forwardAttachmentIds without a source id -> BAD_USER_INPUT.
- Forwarded total over 5 MiB -> BAD_USER_INPUT before any write.
- Delivered `OutboundMail`:
  - Has bcc in `mail.bcc`, and `raw` has no `Bcc:`.
  - Has `messageId`, `inReplyTo` and `references` for a reply.
  - Inline contentId is preserved.
- Provider throws with reason `SENDER_NOT_VERIFIED` -> message FAILED with
  deliveryError `SENDER_NOT_VERIFIED`.
- SMTP relay throws -> `RELAY_ERROR`.
- Receipt providerMessageId `<p@cf>` differing from ours -> stored
  rfcMessageId `p@cf`.
- `sendMessage` from `taco@tacoserve.online` with a fake sender returning
  providerMessageId `<AE8o@tacoserve.online>` -> the SENT row's stored
  rfcMessageId is `AE8o@tacoserve.online` (no brackets). The same holds for
  `sendDraft`.
- Receipt providerMessageId `null` (SMTP relay) -> stored rfcMessageId stays
  `${id}@${domain.name}`.
- Draft update omitting a previously bound attachment -> row deleted. The
  blob is deleted only when unreferenced.
- Draft update changing `from` to another managed domain -> stored
  `domainId` updated.
- Draft update omitting `inReplyToMessageId` -> thread context kept.
- Repeated save with the same forwardAttachmentIds -> no duplicate copies.
- `saveIfDraft` returning false (draft already sent) -> CONFLICT.
- `sendDraft` twice -> the second is CONFLICT or NOT_FOUND, and the
  provider was called once.
- `sendDraft` delivers the draft's attachments and persists rfcMessageId.
- `retrySend` includes attachments.
- `deleteDraft` on a draft -> true, and the row and unreferenced blobs are
  gone.
- `deleteDraft` on a SENT message -> NOT_FOUND.
- `listSendableAddresses`:
  - A MEMBER with no ALLOW on domain D -> no `*@D` entry.
  - An ADMIN -> `*@D` when D has no mailboxes.
- Send from a DISABLED provisioned address -> BAD_USER_INPUT, field
  `from`.
- Reply with an unreadable `inReplyToMessageId` -> NOT_FOUND.

## Invariants

- The QUEUED row is persisted before the provider call.
- Autosave (`saveDraft`) never calls `mailSender`.
- No address or provider text appears in `deliveryError`.
- API-key scope behavior is unchanged.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/application` -> exit 0.
- Server-workspace typecheck:
  `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck`
  -> exit 0.
  - The infrastructure resolvers call `sendMessage`/`saveDraft` with the
    old input shape. The new fields are optional, so it must still
    compile.
  - apps/web is excluded on purpose. webmail-10 runs in the same wave and
    leaves a known transient type error in
    `apps/web/src/pages/mailbox-page.tsx` until webmail-11 fixes it.
    apps/web mirrors the GraphQL types by hand, so this plan cannot affect
    its typecheck. Never edit anything under `apps/web`. Do not use the
    root `bun run typecheck`.
- `bunx biome check packages/application/src --diagnostic-level=warn` ->
  no diagnostics.
- `wc -l packages/application/src/usecases/send.ts packages/application/src/usecases/drafts.ts`
  -> each under 1000 (target under 800).

## Completion criteria

- [ ] All file-level changes are done.
- [ ] Every listed test exists and passes.
- [ ] `deleteDraft` is wired in `usecases.ts`.
- [ ] Verification passes, with exit codes logged. This includes the
      server-workspace typecheck (exit 0); the root `bun run typecheck` is
      not used.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
