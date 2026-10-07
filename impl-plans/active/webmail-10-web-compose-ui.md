# Webmail 10: Web Compose UI (editor, attachments, autosave, ComposeHost)

**Status**: Ready
**planId**: webmail-10-web-compose-ui
**Wave**: 2 (depends on webmail-03-web-compose-libs, webmail-05-web-api-contract)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 7 (Compose; Reply/forward/reopen), section 6 (Reopen, autosave never delivers), D6, D7, D13
**Created**: 2026-10-07

## Intent and context

The current composer (`apps/web/src/components/compose-form.tsx`, 345
lines) has:
- From, To, Cc and Subject fields, a plain textarea, and chip-only
  uploads.
- No Bcc, HTML editing, removal, progress, autosave or forward
  attachments.

Reply, forward and reopen prefill live in
`apps/web/src/pages/mailbox-page.tsx` today. They move into `ComposeHost`
(the props were pinned by webmail-05), which uses the server
`composeFromMessage` query.

webmail-11 changes `mailbox-page.tsx` to render
`<ComposeHost request=... />`. Do not edit `mailbox-page.tsx`.

Contracts used:
- webmail-05: `apps/web/src/lib/compose-types.ts`; store methods `send`,
  `sendDraft`, `saveDraftDetailed`, `deleteDraft`, `composeFromMessage`,
  `mailLimits`, `viewer().sendableAddresses`; `MESSAGE_QUERY` with draft
  fields.
- webmail-03: `sanitizeComposeHtml`, `htmlToPlainText`,
  `plainTextToHtml`, `isAllowedLinkUrl`, `createDraftSaver`,
  `uploadAttachmentWithProgress`, `mapWithConcurrency`.

## Non-goals

- No received-mail rendering changes.
- No sidebar changes.
- No server changes.
- No rich-text npm dependency.
- No Reply-To field in the UI.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- Each component file stays under 600 lines. Imitate the existing Solid
  patterns (signals, `<Show>`, `<For>`) in `compose-form.tsx` and the
  CSS-per-component convention (`compose-form.css`).

## Write ownership

**writePaths**
- `apps/web/src/components/compose-editor.tsx`
- `apps/web/src/components/compose-editor.test.tsx`
- `apps/web/src/components/compose-attachments.tsx`
- `apps/web/src/components/compose-form.tsx`
- `apps/web/src/components/compose-form.test.tsx`
- `apps/web/src/components/compose-form.css`
- `impl-plans/active/webmail-10-web-compose-ui.md` (checkboxes and Progress Log only)

**sharedPaths**
- `apps/web/src/components/compose-host.tsx`: replace the webmail-05 stub
  body and keep its exported `ComposeHost` name and `ComposeHostProps`.

**Expected transient typecheck error.** `apps/web/src/pages/mailbox-page.tsx`
still imports the old `ComposeDraft` type and the old `ComposeForm` props.
webmail-11 runs after this plan and removes that usage. Do not edit
`mailbox-page.tsx`. When you verify, `bun run --cwd apps/web typecheck`
may report errors in `src/pages/mailbox-page.tsx` only. Record them in the
Progress Log. Any error in another file is a failure of this plan. For the
same reason, run `mise run build-web` but treat a failure caused only by
`mailbox-page.tsx` as expected, and log it.

## File-level changes

### apps/web/src/components/compose-editor.tsx (new)

**Props**
```ts
{ initialHtml: string | null; initialText: string; onChange: (value: { mode: "html" | "plain"; html: string | null; text: string }) => void; execCommand?: (command: string, value?: string) => boolean }
```

**Editor surface.** A `contenteditable` div with
`role="textbox" aria-multiline="true"`. Initial HTML goes through
`sanitizeComposeHtml` before assignment.

**Toolbar.** Buttons with aria-labels, dispatched through the injectable
`execCommand`, which defaults to `document.execCommand`:

| Action | Command |
|---|---|
| Bold | `bold` |
| Italic | `italic` |
| Underline | `underline` |
| Bulleted list | `insertUnorderedList` |
| Numbered list | `insertOrderedList` |
| Link | `createLink` |
| Blockquote | `formatBlock` with `blockquote` |
| Clear formatting | `removeFormat`, then `unlink` |

**Link.** Prompt for a URL (`window.prompt`). Reject it if
`!isAllowedLinkUrl(url)`. Save and restore the Selection range (Selection
API) around the prompt, so the link applies to the original selection.

**Paste.** Intercept `paste`: take `text/html`, run it through
`sanitizeComposeHtml` and insert it via `insertHTML`, falling back to
`text/plain`. Never insert unsanitized clipboard HTML.

**Plain-text toggle**
- HTML to plain: confirm loss of formatting (`window.confirm`), then
  convert with `htmlToPlainText`.
- Plain to HTML: `plainTextToHtml`.
- In plain mode, show a `<textarea>`.

**`onChange` values**
- HTML mode emits `{mode:"html", html: sanitizeComposeHtml(el.innerHTML), text: htmlToPlainText(...)}`.
- Plain mode emits `{mode:"plain", html:null, text}`.

### apps/web/src/components/compose-attachments.tsx (new)

**Props**
```ts
{ chips: readonly ComposeAttachmentChip[]; onRemove: (localKey: string) => void; totalBytes: number; maxTotalBytes: number }
```

**Rendering**
- Each chip shows: file name, size (`formatBytes` from
  `lib/relative-time.ts`), a progress bar while uploading, the error
  text, and a remove button (`aria-label="Remove <name>"`).
- Forward chips are labelled "from original".
- A warning appears when `totalBytes > maxTotalBytes`.

### apps/web/src/components/compose-form.tsx (rewrite)

**Props**
```ts
{ initial: ComposeInitialState; sendableAddresses: readonly string[]; limits: MailLimitsView | null; onSend(content: ComposeSubmit): Promise<"sent" | "failed">; onSave(content: ComposeSubmit): Promise<DraftSaveOutcome & { draftId?: string; attachments?: readonly AttachmentView[] }>; onDiscard(draftId: string | null): Promise<void>; onClose(): void }
```
Define `ComposeSubmit` in this file:
```ts
{ draftId: string | null; from: string; replyTo: string | null; to: readonly string[]; cc: readonly string[]; bcc: readonly string[]; subject: string; html: string | null; text: string; inReplyToMessageId: string | null; forwardedFromMessageId: string | null; attachmentIds: readonly string[]; forwardAttachmentIds: readonly string[] }
```

**Fields**
- From, To, Cc (toggle), Bcc (toggle), Subject, editor and attachments.
- To, Cc and Bcc are split on `,` and `;`. Keep `splitAddresses`.

**From picker** (D13)
- Concrete entries are grouped by domain (`<optgroup>`).
- Entries containing `*` render as "Other address on <domain>". Choosing
  one shows a local-part input. The composed address must match the
  pattern client-side (simple glob: the `*` matches `[^@]*`), otherwise
  Send is disabled with a message.

**Uploads**
- Files run through `mapWithConcurrency(files, 3, ...)` with
  `uploadAttachmentWithProgress`.
- A file is refused before upload when
  `file.size > (limits?.maxAttachmentBytes ?? 5 MiB)`, and a chip shows
  the error.
- A 413 `TOO_LARGE` result sets the chip error using `maxBytes`.

**Submit content**
- `attachmentIds`: chips with `status==="done"` and `id !== null`.
  Forward chips count only once adopted (`id` set).
- `forwardAttachmentIds`: forward chips not yet adopted (`id===null`),
  taken from `sourceAttachmentId`.
- Send is disabled while any chip is uploading, when the total exceeds
  the limit, or when there are no recipients.

**Autosave**
- `createDraftSaver({ debounceMs: 2000, save: onSave, isSame })` is fed
  from every field change.
- When a save returns `draftId` or `attachments`, adopt them. Set the
  draft id. For forward chips, match the returned attachments by
  `fileName`+`size` and set `id`. They then leave `forwardAttachmentIds`.
- A `conflict` outcome stops autosave and shows "This draft was sent or
  deleted elsewhere".

**Actions**
- Send: `await saver.cancel()`, then `onSend(content)`. On `"sent"`,
  `saver.dispose()`.
- Discard (trash icon): after confirmation, `await saver.cancel()`, then
  `onDiscard(draftId)` and `dispose`.
- Close (X): `await saver.flush()` when dirty, then `onClose()`.
- The status label shows Saving / Saved / Not saved / Conflict.

**Title** comes from `initial.title`.

### apps/web/src/components/compose-host.tsx (replace the webmail-05 stub, keep the props)

**Loading `ComposeInitialState` per request**
- `NEW`:
  - From = the first concrete sendable address.
  - Empty fields, html `""`. The default is HTML mode with an empty
    editor.
- `REPLY`, `REPLY_ALL`, `FORWARD`:
  - Call `store.composeFromMessage(id, mode)`.
  - html = `quotedHtml ?? plainTextToHtml(quotedText)`, sanitized by the
    editor. text = `quotedText`.
  - Linkage comes from the prefill.
  - FORWARD chips are taken from `forwardAttachments`, with
    `origin:"forward"`, `id:null` and `sourceAttachmentId` set.
  - Title: Reply or Forward.
- `DRAFT`:
  - Run `MESSAGE_QUERY` via `graphqlRequest`. Restore from, replyTo,
    recipients by kind (TO, CC, BCC), subject, htmlBody/textBody, the
    attachments as `origin:"draft"` chips with `id` set, and
    `draftId = message.id`.
  - Title: Reply when `inReplyTo !== null`, Forward when
    `forwardedFromMessageId !== null`, else New message.
  - Re-saves omit the linkage inputs (sticky on the server).

**Wiring**
- `onSave` calls `store.saveDraftDetailed`, including `inReplyToMessageId`
  and `forwardedFromMessageId` only on the first save (no draftId yet).
- `onSend` uses `store.sendDraft` (after a final save) when a draft
  exists, else `store.send` with all fields.
- `onDiscard` calls `store.deleteDraft` when there is a draftId.
- Call `props.onMailboxChanged()` after a send, after the first save that
  created a draft, and after a delete.

### apps/web/src/components/compose-form.css

Add styles for the toolbar, editor, chips, progress and From picker.
Use the existing tokens from `styles/tokens.css`.

## Tests

New `apps/web/src/components/compose-form.test.tsx`; imitate the render
style of `message-view.test.tsx`.
- Bcc toggle shows a field, and its value goes into the submit `bcc`.
- A pattern entry `*@T` shows a local-part input. Local `a` -> submit from
  `a@T`. An invalid input -> Send disabled.
- HTML mode submit -> both html (sanitized) and text are present. After
  toggling to plain -> only text, and html is null.
- An uploading chip disables Send. Removing a done chip removes its id
  from `attachmentIds`.
- An oversize file -> no upload call, and the chip shows an error.
- A forward chip with no id -> sent in `forwardAttachmentIds`. After a
  save response containing a matching attachment -> moved to
  `attachmentIds`.
- Autosave (fake timers): typing triggers one `onSave` after 2000 ms.
  Clicking Send never calls `onSave` after `onSend` started. `onSave` is
  never called with intent to deliver.

New `apps/web/src/components/compose-editor.test.tsx`:
- The toolbar dispatches the expected commands via an injected
  `execCommand` mock.
- A paste with `<img src=https://x onerror=...>` inserts sanitized HTML
  only.
- `javascript:` links are refused.

## Invariants

- Autosave only calls `onSave`.
- Composed HTML always passes `sanitizeComposeHtml` before it is sent or
  saved.
- No unsanitized HTML is ever assigned to `innerHTML`.

## Verification (repo root; log exit codes)

- `bun run --cwd apps/web test -- src/components/compose-form.test.tsx src/components/compose-editor.test.tsx`
  -> exit 0.
- `bun run --cwd apps/web test` -> all tests pass except any test that
  fails only because it imports `src/pages/mailbox-page.tsx` (log it).
- `bun run --cwd apps/web typecheck` -> exit 0, or errors only in
  `src/pages/mailbox-page.tsx` (see "Expected transient typecheck error").
- `bunx biome check apps/web/src/components --diagnostic-level=warn` -> no
  diagnostics.
- `mise run build-web` -> exit 0, or a failure caused only by
  `mailbox-page.tsx` (logged). webmail-11 must make it exit 0.

## Completion criteria

- [ ] Editor, attachments, form and host are implemented as specified.
- [ ] The compose-form and compose-editor tests pass.
- [ ] Typecheck and build pass, or fail only in `mailbox-page.tsx`, and
      that is logged.
- [ ] Verification is logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
