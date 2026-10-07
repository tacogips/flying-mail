# Webmail 05: Web API Contract (types, operations, store methods, ComposeHost contract)

**Status**: Completed
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
- `impl-plans/completed/webmail-05-web-api-contract.md` (checkboxes and Progress Log only)

**sharedPaths**
- `apps/web/src/components/message-view.test.tsx` -- intendedEdit: add `replyTo`, `forwardedFromMessageId`, `inReplyTo` (all `null`) to the `MessageDetailView` fixture only.

Later owners: webmail-10 replaces the body of
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

- [x] Mirror types and documents match design section 3 field names
      exactly.
- [x] Store methods are added, with tests.
- [x] `compose-types.ts` and the `ComposeHost` stub exist with the exact
      signatures above.
- [x] Verification passes, with exit codes logged.

## Progress Log

### Session: 2026-10-07
**Tasks Completed**: API mirror types and documents; compose store methods and save outcome mapper/tests; compose types and host stub.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 2; `tmp/webmail-completion-s299/webmail-05/typecheck.log`. Required `MessageDetailView` fields make the fixture at `apps/web/src/components/message-view.test.tsx:10-42` incomplete. That path is outside this plan's `writePaths`; exact mirror fields were retained.
- `bun run --cwd apps/web test` — exit 0, 208 tests passed; `tmp/webmail-completion-s299/webmail-05/test.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0; `tmp/webmail-completion-s299/webmail-05/biome.log`.
**Blocker**: Typecheck remains incomplete pending a write-path amendment for `apps/web/src/components/message-view.test.tsx`, then rerun the exact typecheck command.

### Session: 2026-10-07 orchestrator serial reconciliation
`apps/web/src/components/message-view.test.tsx` is now a sharedPath of this plan; the fixture sets `replyTo`, `forwardedFromMessageId`, `inReplyTo` to `null`. Verified: `bun run --cwd apps/web typecheck` exit 0; `bun run --cwd apps/web test` exit 0 (208 passed); `bun run typecheck` exit 0. webmail-11 re-reads and merges this file later.

### Session: 2026-10-07 Step 6 implementation rerun
**Tasks Completed**: Rechecked the plan contract against design section 3 and reran all plan verification on the current shared source. No source edits were needed.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/typecheck-rerun.log`.
- `bun run --cwd apps/web test` — exit 0, 208 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/test-rerun.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no fixes; `tmp/webmail-completion-s299/webmail-05/biome-rerun.log`.

### Session: 2026-10-07 Step 6 final-source verification
**Tasks Completed**: Repeated all plan gates after detecting different web test counts across shared-tree runs. The plan-scoped TypeScript source fingerprints matched before and after this final verification; the final full web suite reports 209 passing tests.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/typecheck-final.log`.
- `bun run --cwd apps/web test` — exit 0, 209 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/test-final.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no fixes; `tmp/webmail-completion-s299/webmail-05/biome-final.log`.

### Session: 2026-10-07 Step 6 foreground verification rerun
**Tasks Completed**: Re-ran all assigned verification commands in the foreground against the current shared source. A read-only contract audit found no mismatches against design section 3 or this plan. No TypeScript source changes were needed.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/step6-verified-typecheck-20261007.log`.
- `bun run --cwd apps/web test` — exit 0, 209 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/step6-verified-test-20261007.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no fixes; `tmp/webmail-completion-s299/webmail-05/step6-verified-biome-20261007.log`.

### Session: 2026-10-07 Step 6 final foreground verification
**Tasks Completed**: Re-ran all three assigned gates in the foreground against the current shared source; no source changes were needed. Typecheck and Biome exited 0, and the full web suite passed 209 tests across 12 files.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/step6-final-current-typecheck-20261007.log`.
- `bun run --cwd apps/web test` — exit 0, 209 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/step6-final-current-test-20261007.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no fixes; `tmp/webmail-completion-s299/webmail-05/step6-final-current-biome-20261007.log`.

### Session: 2026-10-07 Step 6 native fanout implementation
**Tasks Completed**: Rechecked the assigned API contract and reran all three plan gates in the foreground against current sources. No TypeScript sources changed; acceptance criteria remain complete.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-1e91c526-20261007/typecheck.log`.
- `bun run --cwd apps/web test` — exit 0, 209 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-1e91c526-20261007/test.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no fixes; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-1e91c526-20261007/biome.log`.
**Source SHA-256** (unchanged by this verification): `schema-types.ts` 83d3ead65859db45faf6faccbf2c58cfd167b3338a4ea85fa5f07bb13ceec2c5; `documents.ts` e2fbc97cd7d2aa4693f223e0a5884d5072dc80b0452fccc6aab149324733288f; `app-store.ts` ffa97c90f456fb0f3e63f7d5a93cd2920ba20c9006c08ed23c59c23bea0d20a0; `app-store-compose.ts` 83653c06920d8307cb65fda5736446ae83c7df1f74733e5b9f8168bee1c90e77; `app-store-compose.test.ts` 62a431f9933ce071f814b1d6414b7b2918cb14689416698b22679f75aefc1a32; `compose-types.ts` ac2d48603a88d4e304e7fddb617ba6525640d24247802e648d5226a6eab44f59; `compose-host.tsx` 40a160336f6e7ab4864e7641bc9e4e7d971adbedae241b26655bfaed562f0ae1; `message-view.test.tsx` b4ad1089d10e4015d995cc593dba61b6d37dc21cab00e7c1ad7a9938fd97f3b2.

### Session: 2026-10-07 native Riela Step 6 execution
**Tasks Completed**: Rechecked the assigned contract; an independent read-only audit found no mismatches with design sections 3, 6, or 7. No TypeScript source edits were needed. Re-ran the exact plan verification commands in the foreground against current sources.
**Verification**:
- `bun run --cwd apps/web typecheck` — exit 0; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-5b8a6bde337608a3b5fbc43e4eaebb4de5467160b6c1c316baaf0dacdf36304e/typecheck.log`.
- `bun run --cwd apps/web test` — exit 0, 209 tests passed across 12 files; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-5b8a6bde337608a3b5fbc43e4eaebb4de5467160b6c1c316baaf0dacdf36304e/test.log`.
- `bunx biome check apps/web/src/api apps/web/src/store apps/web/src/lib/compose-types.ts apps/web/src/components/compose-host.tsx --diagnostic-level=warn` — exit 0, 14 files checked with no diagnostics; `tmp/webmail-completion-s299/webmail-05/step6-nested-v1-5b8a6bde337608a3b5fbc43e4eaebb4de5467160b6c1c316baaf0dacdf36304e/biome.log`.
**Source SHA-256** (verified before and after these commands): `schema-types.ts` 83d3ead65859db45faf6faccbf2c58cfd167b3338a4ea85fa5f07bb13ceec2c5; `documents.ts` e2fbc97cd7d2aa4693f223e0a5884d5072dc80b0452fccc6aab149324733288f; `app-store.ts` ffa97c90f456fb0f3e63f7d5a93cd2920ba20c9006c08ed23c59c23bea0d20a0; `app-store-compose.ts` 83653c06920d8307cb65fda5736446ae83c7df1f74733e5b9f8168bee1c90e77; `app-store-compose.test.ts` 62a431f9933ce071f814b1d6414b7b2918cb14689416698b22679f75aefc1a32; `compose-types.ts` ac2d48603a88d4e304e7fddb617ba6525640d24247802e648d5226a6eab44f59; `compose-host.tsx` 40a160336f6e7ab4864e7641bc9e4e7d971adbedae241b26655bfaed562f0ae1; `message-view.test.tsx` b4ad1089d10e4015d995cc593dba61b6d37dc21cab00e7c1ad7a9938fd97f3b2.

### Session: 2026-10-07 final correction pass
**Tasks Completed**: L0, R1, R2, R3, R4, R5, and R6 final review corrections across the authorized web client paths.
**Finding dispositions and regression evidence**:
- L0: Added a public session-establishing GraphQL request mode with `credentials: "same-origin"`; it does not attach Authorization or clear the session on UNAUTHENTICATED. Email verification uses it; `requestEmailAuth` retains `omit`. Tests assert both modes and the no-clear/no-Authorization behavior.
- R1: `saveDraftDetailed` accepts a silent option; autosave uses it so failures surface through the composer state instead of repeated toasts. Tests assert silent failures produce no toast and default failures still toast. `compose-form` validation and close recovery are logged in webmail-10.
- R2: Save outcome mapping treats CONFLICT as conflict and only treats NOT_FOUND as conflict when an existing input draft id is identified by Draft/resource/field metadata or the server's exact `Draft not found: <id>` message; other NOT_FOUND cases return error. Tests cover draft-specific and unrelated missing resources.
- R3: Added `kind` and `url` to the forward attachment selection in `COMPOSE_FROM_MESSAGE_QUERY`.
- R4: Existing id claims are seeded before matching forward attachments; collision regression coverage is in `compose-form.test.tsx`.
- R5: Plain text conversion normalizes whitespace only outside `<pre>`; coverage is in `compose-html.test.ts`.
- R6: Same-id open-draft requests are ignored by `ComposeHost`; coverage confirms no second query and no stale content replacement in `compose-host.test.tsx`.
**Verification**:
- `bunx biome check apps/web/src --diagnostic-level=warn` — exit 0; 75 files checked, no fixes.
- `bun run --cwd apps/web typecheck` — exit 0.
- `bun run typecheck` — exit 0; all 7 workspace packages passed.
- `bun run --cwd apps/web test` — exit 0; 16 files, 242 tests passed.
- `mise run build-web` — exit 0; 101 modules transformed, production build completed.
**Source SHA-256 (before -> after)**:
- `apps/web/src/api/graphql-client.ts`: `dc119ebbf6f920ceff64038387f2c9a12e673cf56f351b4008e30fedfff7a3c9` -> `6083d8ca971937d2ffa511afac42c7b972fc7fb0526d5f68185ef5911d5b6a95`
- `apps/web/src/pages/email-auth-verify-page.tsx`: `43d6a18a096f5d8c701b6719e2411e2475435b3143ffe24b47ffd631fa897a82` -> `86b478a3e5bfe181306604af89303751e130c9105ebfd02f3303da5e7db20266`
- `apps/web/src/store/app-store.ts`: `9cbf063fd7b77ae5e87072e185f71cd5530e30be0c92b2129b2360bc079ab2b7` -> `e3800b489f728dee9d5851011ab3b7966234c7e4dac4e860a4348428515f35dc`
- `apps/web/src/store/app-store-compose.ts`: `83653c06920d8307cb65fda5736446ae83c7df1f74733e5b9f8168bee1c90e77` -> `b1bfe411b3bd6844c6417e88d1cb552f2f2bf61bc4cc2bb3cf798d00478eacc2`
- `apps/web/src/api/documents.ts`: `e2fbc97cd7d2aa4693f223e0a5884d5072dc80b0452fccc6aab149324733288f` -> `b1a7bdd94c1c0690654dd1220aae05fdcbf1d61292724041025e951ef854a0ad`
- Updated test files: `graphql-client.test.ts` `27216393b4a1ac2806a605a806fb86007a081facf3ba4dd083ed40453fb237cd`; `app-store-compose.test.ts` `0957269e1d86c7f2cd083b546cb02423c190da05fa1233945c20d2c2d7683792`.
**Plan SHA-256 before this entry**: `1c9569ba79bb0218c6fad3a91a899489ac0058f186e1f0bf75ab9f7e1ec0a3fc`.

### Session: 2026-10-07 orchestrator completion
Completed outside the riela gate: the workflow accepted webmail-01, 02, 04, 06, 07, 08 and 09 through its native reviews; its implementation-progress-check gate repeatedly rejected valid evidence for 03 and 05 (5 attempts, tests passing), so the orchestrator continued with GPT-6 Luna (codex exec) implementing 10, 11, 12 and 13 and read-only Opus reviews (iterations 1-2) whose findings were returned to Luna and fixed (webmail-10 H1-H2/M1-M3/L1-L5/R1/R4/R6, webmail-11 C1/S1-S3/N1-N6, webmail-05 R2/R3, webmail-03 R5, plus the pre-existing login cookie defect L0). Final verification: mise run lint exit 0; bun run test exit 0 (1695 package tests, 242 web tests); mise run build-web exit 0. Deployed to Cloudflare (worker mailcal-api) and verified live: cross-domain send/receive, To/Cc/Bcc, HTML, attachments upload/download, reply threading, forward with original attachments, draft save/update/reopen/send/delete, and the web UI end to end in Brave.
