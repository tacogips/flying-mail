# Webmail 05: Web API Contract (types, operations, store methods, ComposeHost contract)

**Status**: Ready
**planId**: webmail-05-web-api-contract
**Wave**: 1 (no dependencies; mirrors the accepted SDL in design section 3)
**Design Reference**: design-docs/specs/design-webmail-completion.md sections 3, 6 (Reopen), 7
**Created**: 2026-10-07

## Intent and context

Two wave-2 web plans run in parallel: compose UI (webmail-10) and
mailbox/sidebar UI (webmail-11). Both need a fixed client contract. This
plan pins it:

- The hand-written GraphQL mirror types. `apps/web/src/api/schema-types.ts`
  is NOT generated (see its header). The server SDL lands in webmail-12
  exactly as specified in design section 3.
- The operation documents (`apps/web/src/api/documents.ts`).
- The store methods (`apps/web/src/store/app-store.ts`).
- The compose types.
- A `ComposeHost` component stub with final props.

The mailbox page renders the stub. webmail-10 replaces its body.

## Non-goals

- No compose UI behavior.
- No sidebar or filter changes. Leave the `MailboxView` shape alone, since
  webmail-11 owns it.
- No server changes.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- Files stay under 1000 lines. `app-store.ts` is 656 lines: keep the
  additions small, or put helpers in a new `store/app-store-compose.ts`
  imported by `app-store.ts`.

## Write ownership

**writePaths**
- `apps/web/src/api/schema-types.ts`
- `apps/web/src/api/documents.ts`
- `apps/web/src/store/app-store.ts`
- `apps/web/src/store/app-store-compose.ts`
- `apps/web/src/store/app-store-compose.test.ts`
- `apps/web/src/lib/compose-types.ts`
- `apps/web/src/components/compose-host.tsx`
- `impl-plans/active/webmail-05-web-api-contract.md` (checkboxes and Progress Log only)

**sharedPaths**: none. Later owners: webmail-10 replaces the body of
`compose-host.tsx`; webmail-11 edits the `MailboxView` usage in
`app-store.ts`; webmail-12 re-verifies `schema-types.ts`. All three depend
on this plan, so the edits are serialized.

## File-level changes

### apps/web/src/api/schema-types.ts

Add or extend, mirroring design section 3 exactly:
- `type ComposeMode = "REPLY" | "REPLY_ALL" | "FORWARD"`.
- `interface ComposePrefillView`:
  - `from: string | null`, `to: readonly string[]`,
    `cc: readonly string[]`, `subject: string`
  - `inReplyToMessageId: string | null`,
    `forwardedFromMessageId: string | null`
  - `forwardAttachments: readonly AttachmentView[]`
  - `quotedText: string`, `quotedHtml: string | null`
- `interface MailLimitsView`: `maxAttachmentBytes`,
  `maxOutboundTotalBytes`, `maxAttachmentsPerMessage`,
  `maxRecipientsPerMessage` (all `number`).
- `ViewerView` gains `readableAddresses: readonly string[]`.
- `MessageDetailView` gains `replyTo: string | null`,
  `forwardedFromMessageId: string | null`, `inReplyTo: string | null`.
  Check `MessageView` first and do not duplicate existing fields.
- `SendMessageVariables` gains optional `replyTo?: string`,
  `forwardedFromMessageId?: string`,
  `forwardAttachmentIds?: readonly string[]`. It already has `bcc?` and
  `html?`; verify.
- Make sure `AttachmentView` exposes `inline`, `contentId`, `size` and
  `contentType`.

### apps/web/src/api/documents.ts

- `VIEWER_QUERY` selects `readableAddresses`.
- `MESSAGE_DETAIL_FIELDS` selects `replyTo forwardedFromMessageId inReplyTo`
  and attachments with `id fileName contentType size inline contentId url`.
- New `COMPOSE_FROM_MESSAGE_QUERY`:
  `query ComposeFromMessage($messageId: ID!, $mode: ComposeMode!) { composeFromMessage(messageId: $messageId, mode: $mode) { from to cc subject inReplyToMessageId forwardedFromMessageId quotedText quotedHtml forwardAttachments { id fileName contentType size inline contentId } } }`
- New `MAIL_LIMITS_QUERY`:
  `query MailLimits { mailLimits { maxAttachmentBytes maxOutboundTotalBytes maxAttachmentsPerMessage maxRecipientsPerMessage } }`
- New `DELETE_DRAFT_MUTATION`:
  `mutation DeleteDraft($id: ID!) { deleteDraft(id: $id) }`
- `SAVE_DRAFT_MUTATION` returns the draft's `attachments { id fileName contentType size }`
  so the client can adopt forward-copy ids.

### apps/web/src/store/app-store.ts

- `SaveDraftVariables` gains: `bcc?`, `html?`, `replyTo?`,
  `forwardedFromMessageId?`, `forwardAttachmentIds?`.
- Add store methods to the `AppStore` interface and implementation:
  - `deleteDraft(id: string): Promise<boolean>`
  - `composeFromMessage(messageId: string, mode: ComposeMode): Promise<ComposePrefillView | null>`
  - `mailLimits(): MailLimitsView | null`, a signal loaded once when the
    viewer loads. On failure it stays null and the UI uses the 5 MiB
    defaults.
  - `saveDraftDetailed(input: SaveDraftVariables): Promise<{ readonly kind: "saved"; readonly draft: MessageView } | { readonly kind: "conflict" } | { readonly kind: "error"; readonly message: string }>`.
    A GraphQL error code `CONFLICT` or `NOT_FOUND` maps to `conflict`.
    Use `hasCode` from `lib/mutation-error.ts`.
- Imitate the existing `saveDraft`/`sendDraft` implementations (around
  lines 528-552): `graphqlRequest`, toast on error, `describeErrors`.
- `saveDraftDetailed` must NOT toast "Draft saved", because autosave would
  spam toasts.
- Keep the existing `saveDraft` until webmail-10 stops using it.

### apps/web/src/lib/compose-types.ts (new)

```ts
export type ComposeRequest =
  | { readonly kind: "NEW" }
  | { readonly kind: "REPLY" | "REPLY_ALL" | "FORWARD"; readonly messageId: string }
  | { readonly kind: "DRAFT"; readonly messageId: string };
export type ComposeAttachmentOrigin = "upload" | "forward" | "draft";
export interface ComposeAttachmentChip {
  readonly localKey: string;           // stable key for <For>
  readonly id: string | null;          // server attachment id once known
  readonly fileName: string; readonly size: number; readonly contentType: string;
  readonly origin: ComposeAttachmentOrigin;
  readonly status: "uploading" | "done" | "error";
  readonly progress: number;           // 0..1
  readonly error?: string;
  readonly sourceAttachmentId?: string; // forward: original attachment id (sent as forwardAttachmentIds until adopted)
}
export interface ComposeInitialState {
  readonly title: "New message" | "Reply" | "Forward";
  readonly draftId: string | null;
  readonly from: string; readonly replyTo: string | null;
  readonly to: readonly string[]; readonly cc: readonly string[]; readonly bcc: readonly string[];
  readonly subject: string;
  readonly html: string | null;        // non-null => editor starts in HTML mode
  readonly text: string;
  readonly inReplyToMessageId: string | null;
  readonly forwardedFromMessageId: string | null;
  readonly attachments: readonly ComposeAttachmentChip[];
}
export interface ComposeHostProps {
  readonly request: ComposeRequest | null;   // null = composer closed
  readonly onClose: () => void;
  readonly onMailboxChanged: () => void;     // called after send, save-created draft, delete, so the list reloads
}
```

### apps/web/src/components/compose-host.tsx (new stub)

`export function ComposeHost(props: ComposeHostProps): JSX.Element`
returns `null`. It carries a one-line comment saying webmail-10 implements
it. It must typecheck. Do not wire it into `mailbox-page.tsx`
(webmail-11 does that).

## Tests

Put the `saveDraftDetailed` result mapping in
`apps/web/src/store/app-store-compose.ts` as a pure function (for example
`toSaveDraftOutcome(response)`), call it from `app-store.ts`, and test it in
`apps/web/src/store/app-store-compose.test.ts`. Mock `graphqlRequest` (or
feed the function a response object) the way `graphql-client.test.ts`
mocks fetch:
- A response with errors code CONFLICT -> `{kind:"conflict"}`.
- Success -> `{kind:"saved"}` carrying the draft attachments.
- A network error -> `{kind:"error"}`.

## Invariants

- Existing callers of `saveDraft`, `send` and `sendDraft` keep compiling.
- No existing field selections are removed.

## Verification (repo root; log exit codes)

- `bun run --cwd apps/web typecheck` -> exit 0.
- `bun run --cwd apps/web test` -> exit 0. All existing web tests pass;
  baseline 192 plus the new tests.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn`
  -> no diagnostics.

## Completion criteria

- [ ] Mirror types and documents match design section 3 field names
      exactly.
- [ ] Store methods are added, with tests.
- [ ] `compose-types.ts` and the `ComposeHost` stub exist with the exact
      signatures above.
- [ ] Verification passes, with exit codes logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
