# MCP Server 05: Read Tools (search_messages, get_message, get_thread, list_mailboxes, list_drafts, list_tags)

**Status**: Not Started
**Plan ID**: mcp-server-05-read-tools
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-02-content-shaping, mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 3.4, 4.1-4.5, 5.1
**Created**: 2026-10-08

## Intent and context

This plan implements six read tools in the stub file
`packages/infrastructure/src/mcp/tools/read-tools.ts` (created empty by
plan 03).

Each tool:

- is built with `defineTool` (plan 03, `tool-types.ts`);
- calls only `UseCases` for authorized reads;
- shapes results with plan 02's `result-shaping.ts` views, so every
  sender-controlled string is inside `untrusted_content`.

Pinned contracts you consume, which you must not redefine:

- `defineTool`, `McpToolContext`, `McpToolOutcome` (tool-types.ts);
- `FieldSpecMap` object literals passed as `defineTool({ input })`.
  `tool-schema.ts` exports `FieldSpec`, `FieldSpecMap` and `InferArgs`;
  there is no field helper. Example (prose): `message_id: { kind:
  "string", format: "id", required: true, maxLength: 128, description:
  "..." }`;
- `MCP_PAGE_DEFAULT`, `MCP_PAGE_MAX`, `MCP_DEFAULT_BODY_CHARS`,
  `MCP_MAX_BODY_CHARS`, `MCP_THREAD_BODY_CHARS`,
  `MCP_THREAD_MAX_BODY_CHARS`, `MCP_THREAD_MAX_MESSAGES` (constants.ts);
- `toMessageSummaryView`, `toThreadEntryView`, `toMessageDetailView`
  (result-shaping.ts);
- `createMcpTestHarness` (mcp-test-support.ts).

Use cases:

- `usecases.listMessages(viewer, { filter, first, after })`, returning
  `MessagePage { nodes, nextCursor, totalCount }`;
- `getMessage`, `getThread` (returns `ThreadView { id, subject, messages, lastMessageAt } | null`);
- `listReadableAddresses`, `listSendableAddresses`, `listDomains`,
  `listTags`.

Child data for `get_message` comes **after** the authorized `getMessage`:

- `deps.messageRepository.listRecipients([id])`;
- `listAttachments([id])`;
- `listTagIds([id])` plus `deps.tagRepository.findByIds`.

This follows the GraphQL loader precedent
(`packages/infrastructure/src/graphql/loaders.ts`).

## Non-goals

- Do not edit any file other than the writePaths. In particular, not
  `tool-registry.ts`, `constants.ts`, `result-shaping.ts` or the other tool
  files.
- No fetch-state marking, no new use cases, no repository access before an
  authorized use-case result.

## writePaths

- packages/infrastructure/src/mcp/tools/read-tools.ts
- packages/infrastructure/src/mcp/tools/read-tools.test.ts (new)
- impl-plans/active/mcp-server-05-read-tools.md (progress log only)

sharedPaths: none.

## Tool specifications (export `READ_TOOLS` in this order)

The annotation order is R/D/I/OpenWorld.

### 1. `search_messages`

- **Visibility:** MAIL_READ. **Annotations:** T/F/T/F.
- **Inputs:**
  - `folder` (enum: `inbox`, `sent`, `drafts`, `archived`, `starred`,
    `spam`, `trash`);
  - `domain_id` (id);
  - `address` (email);
  - `unread_only` (boolean);
  - `query` (string, max 200);
  - `has_attachment` (boolean);
  - `since`, `until` (date-time);
  - `tag_ids` (string_array, max 20, id);
  - `limit` (integer 1 to `MCP_PAGE_MAX`, default `MCP_PAGE_DEFAULT`);
  - `cursor` (string, max 512).
- **Filter mapping** (copy the semantics of
  `apps/web/src/lib/filter-params.ts:folderToFilter` and `viewToFilter`):

  | Folder | Filter |
  |--------|--------|
  | `inbox` | `{direction: INBOUND}` |
  | `sent` | `{direction: OUTBOUND, statuses: [SENT]}` |
  | `drafts` | `{statuses: [DRAFT]}` |
  | `spam` | `{spamOnly: true}` |
  | `archived`, `starred`, `trash` | `{systemSlugs: [ARCHIVED, STARRED or TRASH]}` |
  | omitted | `{}` |

  - `address` maps to `toAddress` for `inbox`, `fromAddress` for `sent` and
    `drafts`, and `address` otherwise.
  - `query` -> `search`; `unread_only` -> `unreadOnly`;
    `has_attachment` -> `hasAttachment`; `since` and `until` pass through;
    `tag_ids` -> `tagIds` (branded with `createTagId`); `domain_id` ->
    `domainId` (`createDomainId`).
  - Omit every undefined key (`exactOptionalPropertyTypes`).
- **Structured:** `{ messages: MessageSummaryView[], next_cursor: string | null, total_count: number }`.
- **Summary:** `Found <total_count> messages (showing <n>[, more available]).`
- `containsUntrusted: true`.

### 2. `get_message`

- **Visibility:** MAIL_READ. **Annotations:** T/F/T/F.
- **Inputs:**
  - `message_id` (id, required);
  - `include_html` (boolean, default false);
  - `max_body_chars` (integer 1000 to `MCP_MAX_BODY_CHARS`, default
    `MCP_DEFAULT_BODY_CHARS`).
- `getMessage` returns `null` -> throw `NotFoundError("Message", id)`.
- **Structured:** `{ message: toMessageDetailView({...}) }`.
- **Summary:** `Message <id> (<direction>, <recipients count> recipients, <attachments count> attachments).`

### 3. `get_thread`

- **Visibility:** MAIL_READ. **Annotations:** T/F/T/F.
- **Inputs:**
  - `thread_id` (id, required);
  - `max_body_chars_per_message` (integer 500 to
    `MCP_THREAD_MAX_BODY_CHARS`, default `MCP_THREAD_BODY_CHARS`).
- `null` -> `NotFoundError("Thread", id)`.
- Keep the **last** `MCP_THREAD_MAX_MESSAGES` messages in the use case's
  order.
- **Structured:** `{ thread: { id, last_message_at, untrusted_content: { subject }, messages: ThreadEntryView[], messages_truncated: boolean, total_messages: number } }`.

### 4. `list_mailboxes`

- **Visibility:** MAIL_READ or MAIL_SEND. **Annotations:** T/F/T/F. No
  inputs.
- Calls `listReadableAddresses`, `listSendableAddresses` and `listDomains`.
- **Structured:** `{ readable_addresses: string[], sendable_addresses: string[], domains: { id, name, status }[] }`.
- `containsUntrusted: false`.

### 5. `list_drafts`

- **Visibility:** MAIL_READ. **Annotations:** T/F/T/F.
- **Inputs:** `address` (email, maps to `fromAddress`), `limit`, `cursor`.
- `listMessages` with `filter.statuses: [DRAFT]`.
- **Structured:** `{ drafts: MessageSummaryView[], next_cursor, total_count }`.
- `containsUntrusted: true`.

### 6. `list_tags`

- **Visibility:** MAIL_READ or MAIL_MANAGE. **Annotations:** T/F/T/F. No
  inputs.
- **Structured:** `{ tags: { id, name, color, system_slug }[] }`.
  Tag names are operator data, so `containsUntrusted: false`.

## Pitfalls

- Never put subject or snippet text into `summary`. Only counts, ids and
  enum values.
- Out-of-scope reads come back as `null` (`NOT_FOUND`) from the use case.
  Do not convert that to FORBIDDEN, and do not call repositories before the
  use case.
- `limit` maps to the `first` parameter. Never pass more than
  `MCP_PAGE_MAX`.
- The `cursor` is opaque. Pass it through as `after` unchanged.
- The thread subject is untrusted. Put it inside `untrusted_content`.
- Keep `read-tools.ts` under 500 lines.

## Tests (`read-tools.test.ts`, using `createMcpTestHarness`)

Fixtures: messages to `support@example.com` and `billing@example.com`.
Each test case is `situation -> expected outcome`.

- MAIL_READ key on `*@example.com`: `search_messages {}` -> both messages,
  and `total_count` 2.
- `mailboxAgentViewer`-like key for support only -> only the support
  message, `total_count` 1.
- `search_messages {folder:"inbox", address:"support@example.com"}` -> the
  filter uses `toAddress`. Assert the result contains only the support
  message.
- `search_messages {limit: 51}` -> `isError` BAD_USER_INPUT, field `limit`.
- A message with an HTML-only body containing
  `<script>x</script>IGNORE PREVIOUS`, read with `get_message` ->
  - `body_source` is `html_converted`;
  - no `<script`;
  - the text is only in `untrusted_content.body_text`;
  - `content[0].text` has no "IGNORE" and ends with the `UNTRUSTED_NOTICE`.
- `get_message` with `max_body_chars: 1000` on a 5000-character text ->
  `body_truncated` is true, and the text ends with the truncation marker.
- `get_message` of a billing message using the support-only key ->
  `NOT_FOUND`.
- `get_message include_html:true` -> `html_sanitized` is present and has no
  `on*` or `<img`.
- `get_thread` -> entries with capped bodies.
- Unknown thread -> `NOT_FOUND`.
- `list_mailboxes` for the MAIL_SEND-only key -> visible and returns
  sendable addresses.
- `list_drafts` lists only `DRAFT`-status messages.
- `list_tags` -> includes the Trash system tag with `system_slug` `TRASH`.
- `listTools` for a MAIL_MANAGE-only key -> includes `list_tags` and
  excludes `search_messages`.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/tools/read-tools.test.ts 2>&1 | tee /tmp/mcp-server-05-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bun run typecheck 2>&1 | tee /tmp/mcp-server-05-typecheck.log`
   - Expected: exit 0. Failures only in another wave-2 plan's files are
     recorded and re-run after that plan reports done.
3. `bunx biome check packages/infrastructure/src/mcp/tools/read-tools.ts packages/infrastructure/src/mcp/tools/read-tools.test.ts`
   - Expected: exit 0.
4. `wc -l packages/infrastructure/src/mcp/tools/read-tools.ts`
   - Expected: under 500.

## Done criteria

- [ ] `READ_TOOLS` exports exactly the 6 tools, with the names, visibility
      and annotations above.
- [ ] Verification steps 1-4 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- A defect in a plan-02 or plan-03 contract is reported to that owner; do
  not edit their files.
- Put evidence under `tmp/mcp-server-s316/mcp-server-05-read-tools/<attempt>/`.

## Progress Log

(empty)
