# MCP Server 08: Mail Management Tools (read state, tags, trash, spam)

**Status**: Not Started
**Plan ID**: mcp-server-08-manage-tools
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-01-application-usecases, mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 4.2, 4.4 (rows 15-16, 18-22), 4.6; design-docs/user-qa/pending-mcp-server.md M4, M6
**Created**: 2026-10-08

## Intent and context

This plan fills the stub file
`packages/infrastructure/src/mcp/tools/manage-tools.ts` with seven
MAIL_MANAGE tools:

- `mark_read`, `mark_unread`;
- `tag_messages`, `untag_messages`;
- `move_to_trash`;
- `mark_spam`, `mark_not_spam`.

The use cases enforce MAIL_MANAGE per message address and silently skip
unreadable ids, as GraphQL does. `move_to_trash` must use
`usecases.trashMessages` (plan 01), which **never purges**. It must not use
`deleteMessages`.

Use cases:

- `markRead(viewer, ids, read) -> Message[]`;
- `tagMessages` and `untagMessages(viewer, messageIds, tagIds) -> Message[]`.
  An unknown tag id is NOT_FOUND.
- `trashMessages(viewer, ids) -> number`;
- `markSpam` and `markNotSpam(viewer, ids) -> Message[]`.

Contracts consumed (plan 03): `defineTool`, `InferArgs`, `MCP_MAX_IDS` and
`createMcpTestHarness`. Tool inputs are `FieldSpecMap` object literals
passed as `defineTool({ input })`. `tool-schema.ts` exports `FieldSpec`,
`FieldSpecMap` and `InferArgs`; there is no field helper. Example
(prose): `message_ids: { kind: "string_array", required: true, maxItems:
MCP_MAX_IDS, itemMaxLength: 128, itemFormat: "id", description: "..." }`.

## Non-goals

- No `delete_messages` or permanent-delete tool (M4).
- No tag create, rename or delete tools.
- No edits outside the writePaths.

## writePaths

- packages/infrastructure/src/mcp/tools/manage-tools.ts
- packages/infrastructure/src/mcp/tools/manage-tools.test.ts (new)
- impl-plans/active/mcp-server-08-manage-tools.md (progress log only)

sharedPaths: none.

## Tool specifications (export `MANAGE_TOOLS` in this order; all visible with MAIL_MANAGE)

Annotations are R/D/I/OpenWorld.

| Tool | Inputs | Use case | Annotations | Structured |
|------|--------|----------|-------------|------------|
| `mark_read` | `message_ids` (required, max `MCP_MAX_IDS`, id) | `markRead(ids, true)` | F/F/T/F | `{ updated_ids: string[] }` |
| `mark_unread` | same | `markRead(ids, false)` | F/F/T/F | `{ updated_ids }` |
| `tag_messages` | `message_ids`, `tag_ids` (required, max 20, id) | `tagMessages` | F/F/T/F | `{ updated_ids }` |
| `untag_messages` | same | `untagMessages` | F/F/T/F | `{ updated_ids }` |
| `move_to_trash` | `message_ids` | `trashMessages` | F/T/T/F | `{ trashed_count: number }` |
| `mark_spam` | `message_ids` | `markSpam` | F/F/T/F | `{ updated_ids }` |
| `mark_not_spam` | `message_ids` | `markNotSpam` | F/F/T/F | `{ updated_ids }` |

- `updated_ids` holds the ids of the messages the use case returned. These
  are the authorized subset.
- **Summary:** `Updated <n> of <requested> messages.` For `move_to_trash`:
  `<n> of <requested> messages are in Trash.`
- `containsUntrusted: false`. Ids only.
- An empty `message_ids` array -> BAD_USER_INPUT, field `message_ids`.
  Enforce this with a `minItems`-equivalent check inside `execute`, since
  the field spec has no `minItems`.

## Pitfalls

- Never import or call `deleteMessages`.
- Do not report unauthorized ids as errors. The use cases filter them, and
  the count difference is the only signal. This matches GraphQL and does
  not leak existence.
- Brand ids with `createMessageId` and `createTagId`.
- Keep `manage-tools.ts` under 300 lines.

## Tests (`manage-tools.test.ts`, using `createMcpTestHarness`)

Each test case is `situation -> expected outcome`.

- MAIL_MANAGE key on support: `mark_read` -> `readAt` set on the message
  and `updated_ids` = [id]. `mark_unread` -> `readAt` null.
- `tag_messages` with the STARRED system tag id -> the tag is applied.
  `untag_messages` removes it. An unknown tag id -> NOT_FOUND.
- `move_to_trash` twice on the same message -> both calls return
  `trashed_count` 1, and the message **still exists** in the fake store
  after the second call (no purge).
- `move_to_trash` on an out-of-scope message -> `trashed_count` 0, and the
  message is not tagged.
- `mark_spam` then `mark_not_spam` -> the spam mark is set, then cleared.
- `message_ids: []` -> BAD_USER_INPUT.
- 101 ids -> BAD_USER_INPUT.
- A MAIL_READ-only key: `listTools` excludes all 7 tools, and `mark_read`
  -> `-32602`.
- Annotations: `move_to_trash.destructiveHint` is true, and every other
  tool in this file has false.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/tools/manage-tools.test.ts 2>&1 | tee /tmp/mcp-server-08-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bun run typecheck 2>&1 | tee /tmp/mcp-server-08-typecheck.log`
   - Expected: exit 0. Cross-plan transients are recorded and re-run.
3. `bunx biome check packages/infrastructure/src/mcp/tools/manage-tools.ts packages/infrastructure/src/mcp/tools/manage-tools.test.ts`
   - Expected: exit 0.
4. `grep -n "deleteMessages" packages/infrastructure/src/mcp/tools/manage-tools.ts`
   - Expected: no output (exit 1).

## Done criteria

- [ ] `MANAGE_TOOLS` has exactly the 7 tools, as specified.
- [ ] Verification steps 1-4 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- Put evidence under `tmp/mcp-server-s316/mcp-server-08-manage-tools/<attempt>/`.

## Progress Log

(empty)
