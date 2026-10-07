# Webmail 11: Unified Inbox Scopes, Sidebar, Attachment Tiles, Compose Wiring

**Status**: Ready
**planId**: webmail-11-web-mailbox-ui
**Wave**: 3 (depends on webmail-05-web-api-contract, webmail-10-web-compose-ui)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 7 (Received mail, Unified inbox and sidebar, Admin), section 6 (Drafts folder)
**Created**: 2026-10-07

## Intent and context

Today the sidebar
(`apps/web/src/components/mailbox-sidebar.tsx:176-193`) lists domains as
static text, and there is no mailbox list. `MailboxView`
(`apps/web/src/lib/filter-params.ts`) is a flat union. The mailbox page
holds the compose and reply logic.

The design calls for folder x scope:
- The domain and mailbox are scopes.
- Inbox, Starred, Sent, Drafts, Archived, Spam, Trash, tags and search
  are folders.
- Attachment tiles hide inline images that are referenced by `cid:`.
- The mailbox page renders `ComposeHost` (webmail-05 props) instead of
  the old composer logic.

## Non-goals

- No compose internals (webmail-10).
- No server changes.
- No admin page changes. `/settings/domains` and `/settings/users`
  already cover create, TXT, verify, mailboxes and permissions.
- Do not edit `compose-form.tsx` or `compose-host.tsx`.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`/`sharedPaths`.
  - `apps/web/src/store/app-store.ts` is shared with the already-finished
    webmail-05. Edit only the `MailboxView`/`setView`/`viewToFilter`
    usage, and re-read it fresh first.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `apps/web/src/lib/filter-params.ts`
- `apps/web/src/lib/filter-params-scope.test.ts`
- `apps/web/src/components/mailbox-sidebar.tsx`
- `apps/web/src/components/mailbox-sidebar.css`
- `apps/web/src/pages/mailbox-page.tsx`
- `apps/web/src/components/message-view.tsx`
- `apps/web/src/components/message-view.test.tsx`
- `apps/web/src/lib/quote-reply.ts` (delete)
- `apps/web/src/lib/address-format.ts` (remove `buildReplyRecipients` only)
- `apps/web/src/lib/helpers.test.ts`
- `apps/web/src/lib/mail-html.ts` (export `normalizeContentId` only, if not exported)
- `apps/web/src/lib/mail-html.test.ts` (additions only)
- `impl-plans/active/webmail-11-web-mailbox-ui.md` (checkboxes and Progress Log only)

**sharedPaths**
- `apps/web/src/store/app-store.ts`: `MailboxView` initial value,
  `setView` and `viewToFilter` call sites only.

**Why this plan runs after webmail-10.** `mailbox-page.tsx` currently
imports `ComposeDraft` and `ComposeForm` from
`components/compose-form.tsx`, which webmail-10 rewrites. This plan
removes that import and renders `ComposeHost` instead. When this plan
finishes, `bun run --cwd apps/web typecheck` and `mise run build-web` must
exit 0 with no exceptions. Do not edit `compose-form.tsx` or
`compose-host.tsx`. If they block the build, log a blocker for webmail-10.

## File-level changes

### apps/web/src/lib/filter-params.ts

```ts
export type MailboxFolder =
  | { readonly kind: "INBOX" } | { readonly kind: "STARRED" } | { readonly kind: "SENT" } | { readonly kind: "DRAFTS" }
  | { readonly kind: "ARCHIVED" } | { readonly kind: "SPAM" } | { readonly kind: "TRASH" }
  | { readonly kind: "TAG"; readonly tagId: string; readonly name: string } | { readonly kind: "SEARCH"; readonly query: string };
export interface MailboxScope { readonly domainId?: string; readonly address?: string }
export interface MailboxView { readonly folder: MailboxFolder; readonly scope: MailboxScope }
```

**`viewToFilter(view, tags)`**
1. Start from the existing per-folder filter (`viewToFilter` at lines
   38-63).
2. Add `domainId` when the scope has one.
3. Map a scope address by folder:
   - INBOX -> `toAddress`
   - SENT and DRAFTS -> `fromAddress`
   - everything else -> `address`
4. Remove the old `ADDRESS` kind. An old URL `?view=ADDRESS&address=x`
   parses to `{folder: INBOX, scope: {address: x}}`.

**URL encoding**
- `viewToSearchParams` and `searchParamsToView` encode `view`, plus
  `domain` and `address` when the scope sets them.
- Keep `viewTitle`, adding the scope label (address, else domain name
  when known).

**Pitfall: the Sent folder.** SENT must keep `statuses: ["SENT"]`, so
drafts stay out of Sent.

### apps/web/src/components/mailbox-sidebar.tsx (+ mailbox-sidebar.css)

- Add an "All mail" entry that clears the scope.
- Domains become buttons that select `scope {domainId}`.
- Under each domain, list the `viewer.readableAddresses` entries whose
  domain part equals `domain.name`, as buttons selecting
  `scope {domainId, address}`.
- Folders and tags keep the current scope when clicked.
- Highlight the active folder and the active scope separately.
- New props: `readableAddresses: readonly string[]` and
  `onSelectScope(scope)`. Folder clicks keep going through `onSelect`.

### apps/web/src/store/app-store.ts (shared; MailboxView usage only)

- The initial view is `{ folder: {kind:"INBOX"}, scope: {} }`.
- Update the `setView` and `viewToFilter` call sites to the new shape.

### apps/web/src/pages/mailbox-page.tsx

**Remove** these, which move to `ComposeHost`:
- `startReply`, `startForward`, `resolveSelfAddress`
- the `ComposeDraft` construction
- `saveDraft` and `sendDraft`
- the draft-to-composer prefill in the open-message handler

**Replace with**
- A `composeRequest` signal of type `ComposeRequest | null`:
  - New message -> `{kind:"NEW"}`
  - Reply / Reply all / Forward buttons -> the matching kind with the
    active message id
  - Opening a DRAFT -> `{kind:"DRAFT", messageId}`
- Render `<ComposeHost request={composeRequest()} onClose={() => setComposeRequest(null)} onMailboxChanged={() => void store.reloadMessages()} />`.
- Pass `readableAddresses` and the scope handlers to the sidebar.

**Keep** the template-send panel and the event panels unchanged.

### apps/web/src/components/message-view.tsx (+ message-view.test.tsx)

**Tile filter.** Render a tile for an attachment when:
- `!inline`; or
- it is inline with `contentId` null; or
- `htmlBody` is null; or
- `htmlBody` does not reference `cid:<contentId>` (case-insensitive).

**Pitfall: brackets.** Normalize the stored contentId by stripping `<>`
before matching. `normalizeContentId` already exists in
`lib/mail-html.ts`; export it if it is not exported. That edit is allowed
in `mail-html.ts`.

**Reply and forward handlers** call the new page callbacks
(`onReply`, `onReplyAll`, `onForward` stay as props).

### Remove client prefill helpers

- Delete `apps/web/src/lib/quote-reply.ts`.
- Remove `buildReplyRecipients` from `apps/web/src/lib/address-format.ts`.
  Keep `formatMailbox`, `formatRecipients` and `shortMailbox`.
- Update `apps/web/src/lib/helpers.test.ts`:
  - Drop the `quote-reply` and `buildReplyRecipients` tests (the server
    tests in webmail-09 replace them).
  - Adapt the filter-params tests to the new shape.

### apps/web/src/lib/mail-html.test.ts (additions only)

Pin the received-mail boundary:
- A remote img is blocked by default (`data-mailcal-blocked-src`
  present, no `src`).
- With `loadRemoteImages` -> `src` restored.
- `cid:` is rewritten to a provided data URI.
- The CSP meta contains `default-src 'none'`.
- `<script>` is removed.

## Tests (new apps/web/src/lib/filter-params-scope.test.ts plus the updates above)

- `{INBOX, {domainId:"d1"}}` -> filter `{direction:"INBOUND", domainId:"d1"}`.
- `{INBOX, {address:"a@T"}}` -> `toAddress "a@T"`.
- `{SENT, {address:"a@T"}}` -> `{direction:"OUTBOUND", statuses:["SENT"], fromAddress:"a@T"}`.
- `{DRAFTS, {}}` -> `statuses ["DRAFT"]`.
- `{TRASH, {domainId:"d1"}}` -> `systemSlugs` TRASH plus domainId.
- URL round trip of a view with folder TAG and a scope -> equal.
- The legacy `?view=ADDRESS&address=x` -> INBOX with scope address x.
- message-view: an inline attachment with contentId "img1" whose
  htmlBody contains `cid:img1` -> no tile. Unreferenced inline -> tile.
  Non-inline -> tile.

## Invariants

- Spam stays hidden except in the Spam folder (the server default is
  kept).
- Drafts never appear in Sent.
- The admin pages are untouched.

## Verification (repo root; log exit codes)

- `bun run --cwd apps/web test` -> exit 0.
- `bun run --cwd apps/web typecheck` -> exit 0 (webmail-10 has landed, so
  no exception applies).
- `bunx biome check apps/web/src --diagnostic-level=warn` -> no
  diagnostics in the files you touched.
- `mise run build-web` -> exit 0.
- `rg -n "quote-reply|buildReplyRecipients" apps/web/src` -> no matches.

## Completion criteria

- [ ] The folder x scope model, sidebar scopes and URL encoding work.
- [ ] The mailbox page renders `ComposeHost` with requests.
- [ ] The tile filter is in place.
- [ ] The client prefill helpers are removed and the tests are updated.
- [ ] Verification is logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
