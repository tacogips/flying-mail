# MCP Server 06: Compose and Draft Tools (send, reply, forward, drafts)

**Status**: Not Started
**Plan ID**: mcp-server-06-compose-tools
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-02-content-shaping, mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 4.2, 4.4 (rows 5-7, 9-12 and the reply/forward notes), 4.5
**Created**: 2026-10-08

## Intent and context

This plan implements the outbound tools in the stub file
`packages/infrastructure/src/mcp/tools/compose-tools.ts`:

- `send_message`, `reply_message`, `forward_message`;
- `save_draft`, `update_draft`, `send_draft`, `delete_draft`.

Every authorization (MAIL_SEND on `from`, draft ownership, readable source
for reply and forward) is already enforced by the use cases. This plan adds
no check of its own.

Use cases (`packages/application/src/usecases.ts`):

- `sendMessage(viewer, SendMessageInput)`. Fields: `from`, `to`, `cc`,
  `bcc`, `subject`, `text`, `html`, `inReplyToMessageId`,
  `forwardedFromMessageId`, `forwardAttachmentIds`, `attachmentIds`.
  Returns `Message`.
- `composeFromMessage(viewer, id, "REPLY" | "REPLY_ALL" | "FORWARD")`
  returns `ComposePrefill`:
  `{ from: string|null, to, cc, subject, inReplyToMessageId, forwardedFromMessageId, forwardAttachments: Attachment[], quotedText, quotedHtml: string|null }`.
- `saveDraft(viewer, SaveDraftInput)`. The input has `draftId?`; without it
  a draft is created, with it the draft is replaced.
- `sendDraft(viewer, draftId)`, `deleteDraft(viewer, id)`.

Contracts consumed:

- from plan 03: `defineTool`, `InferArgs` and `createMcpTestHarness`;
- from plan 02: `toMessageSummaryView`.

Tool inputs are `FieldSpecMap` object literals passed as
`defineTool({ input })`. `tool-schema.ts` exports `FieldSpec`,
`FieldSpecMap` and `InferArgs`; there is no field helper. Example (prose):
`to: { kind: "string_array", required: true, maxItems: 50,
itemMaxLength: 320, itemFormat: "email", description: "..." }`.

## Non-goals

- No edits outside the writePaths.
- No new use cases, no templates, no `retrySend`, no custom headers, no
  `replyTo` input.

## writePaths

- packages/infrastructure/src/mcp/tools/compose-tools.ts
- packages/infrastructure/src/mcp/tools/compose-tools.test.ts (new)
- impl-plans/active/mcp-server-06-compose-tools.md (progress log only)

sharedPaths: none.

## Tool specifications (export `COMPOSE_TOOLS` in this order)

Annotations are R/D/I/OpenWorld. Every tool here is visible with
MAIL_SEND.

### Shared input limits

- address lists: string_array, max 50, email;
- `subject`: max 998;
- `text`, `html`: max 1,048,576;
- `attachment_ids`: string_array, max 32, id.

### 1. `send_message` (F/T/F/T)

- **Inputs:** `from` (required), `to` (required), `cc`, `bcc`, `subject`
  (required), `text`, `html`, `attachment_ids`,
  `in_reply_to_message_id`.
- Map to `SendMessageInput`. Ids are branded with
  `createAttachmentId` / `createMessageId`, and undefined keys are omitted.
- **Structured:** `{ message: MessageSummaryView, delivery_status }`.
- **Summary:** `Sent message <id> from <from> to <n> recipients (delivery: <status>).`
  `from` is a validated address.
- `containsUntrusted: true`, because the view carries the subject.

### 2. `reply_message` (F/T/F/T)

- **Inputs:** `message_id` (required), `text` (required), `reply_all`
  (default false), `from`, `extra_cc`, `attachment_ids`.
- Call `composeFromMessage(viewer, id, reply_all ? "REPLY_ALL" : "REPLY")`.
- `from = args.from ?? prefill.from`. If that is `null`, throw
  `BadUserInputError("No sendable address for this reply; pass from", "from")`.
- Fields:
  - `to = prefill.to`;
  - `cc = [...prefill.cc, ...extra_cc]`;
  - `subject = prefill.subject`;
  - `inReplyToMessageId = prefill.inReplyToMessageId ?? undefined` (omit
    when null);
  - `text = args.text + "\n\n" + prefill.quotedText`;
  - `html`, only when `prefill.quotedHtml !== null`:
    `"<p>" + escapeHtml(args.text).replaceAll("\n", "<br>") + "</p>" + prefill.quotedHtml`.
- `escapeHtml` is a local helper that escapes `& < > " '`.

### 3. `forward_message` (F/T/F/T)

- **Inputs:** `message_id` (required), `to` (required), `cc`, `text`
  (default empty), `from`, `include_attachments` (default true),
  `attachment_ids`.
- `composeFromMessage(viewer, id, "FORWARD")`.
- `from` is resolved the same way as for replies.
- Fields:
  - `subject = prefill.subject`;
  - `forwardedFromMessageId = prefill.forwardedFromMessageId`;
  - `forwardAttachmentIds = include_attachments ? prefill.forwardAttachments.map(a => a.id) : []`;
  - text and HTML combined as for replies.

### 4. `save_draft` (F/F/F/F)

- **Inputs:** `from` (required), `to`, `cc`, `bcc`, `subject`, `text`,
  `html`, `attachment_ids`, `in_reply_to_message_id`.
- `saveDraft` without `draftId`.
- **Structured:** `{ draft: MessageSummaryView }`.
- **Summary:** `Saved draft <id>.`

### 5. `update_draft` (F/T/T/F)

- **Inputs:** `draft_id` (required) plus the `save_draft` fields.
- `saveDraft` with `draftId`. This is a full replacement, the same as
  GraphQL `saveDraft`.

### 6. `send_draft` (F/T/F/T)

- **Input:** `draft_id` (required).
- **Structured:** `{ message, delivery_status }`.

### 7. `delete_draft` (F/T/T/F)

- **Input:** `draft_id` (required).
- **Structured:** `{ deleted: true, draft_id }`.
- `containsUntrusted: false`.

## Pitfalls

- Never send the raw `prefill.quotedHtml` without the escaped user text. And
  never let `args.text` reach `html` unescaped. Only `send_message.html` is
  caller HTML, as in GraphQL.
- Do not catch use-case errors. Let them propagate to the protocol's
  `toolErrorResult`.
- A `null` prefill reference becomes an omitted key, never `undefined`
  (`exactOptionalPropertyTypes`).
- Forwarding a draft is refused by `composeFromMessage`
  (BAD_USER_INPUT). Do not pre-check it.
- Keep `compose-tools.ts` under 500 lines.

## Tests (`compose-tools.test.ts`, using `createMcpTestHarness`)

Fixture: a key with MAIL_SEND and MAIL_READ on `support@example.com` only.
Mail goes through the fake `recordingMailSender`. Each test case is
`situation -> expected outcome`.

- `send_message` from support to `a@x.test` -> success; one recorded
  outbound message; `delivery_status` present.
- `send_message` from `billing@example.com` -> `isError` FORBIDDEN.
- `send_message` with no `to` -> BAD_USER_INPUT, field `to`.
- `send_message` with 51 recipients in `to` -> BAD_USER_INPUT.
- `reply_message` to an inbound support message -> the recorded send has:
  - the `In-Reply-To` linkage (`inReplyToMessageId` equal to the source);
  - a text body that starts with the user text and contains the quoted
    original;
  - a subject that begins with the reply prefix from the prefill.
- `reply_message` where the source HTML has `<b>` and the user text is
  `<script>` -> the sent `html` contains `&lt;script&gt;`.
- `reply_message` to a billing-only message (not readable) -> NOT_FOUND.
- `forward_message` with a source that has 1 attachment -> the send carries
  `forwardAttachmentIds` of length 1.
- `forward_message include_attachments:false` -> length 0.
- Draft lifecycle:
  - `save_draft` gives an id;
  - `update_draft` changes the subject;
  - `send_draft` sends it;
  - `delete_draft` on another new draft returns `deleted: true`;
  - a second `delete_draft` -> NOT_FOUND.
- MAIL_READ-only key: `listTools` excludes all 7 tools; calling
  `send_message` -> `-32602`.
- No outcome summary contains the subject text: for a fixture subject
  `SECRET-SUBJECT`, `content[0].text` does not include it.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/tools/compose-tools.test.ts 2>&1 | tee /tmp/mcp-server-06-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bun run typecheck 2>&1 | tee /tmp/mcp-server-06-typecheck.log`
   - Expected: exit 0. Cross-plan transients are recorded and re-run.
3. `bunx biome check packages/infrastructure/src/mcp/tools/compose-tools.ts packages/infrastructure/src/mcp/tools/compose-tools.test.ts`
   - Expected: exit 0.
4. `wc -l packages/infrastructure/src/mcp/tools/compose-tools.ts`
   - Expected: under 500.

## Done criteria

- [ ] `COMPOSE_TOOLS` exports exactly the 7 tools, with the specified
      annotations.
- [ ] Verification steps 1-4 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- Contract defects go to plans 02 and 03 as repair requests.
- Put evidence under `tmp/mcp-server-s316/mcp-server-06-compose-tools/<attempt>/`.

## Progress Log

(empty)
