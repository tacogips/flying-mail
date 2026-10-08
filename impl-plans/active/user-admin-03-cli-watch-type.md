# User Admin 03: `flying-mail watch --type` and realtime-client scope type

**Status**: Ready
**Plan ID**: user-admin-03-cli-watch-type
**Wave**: 1 (phase 27)
**Depends On**: none (the server half is plan 02; this plan is verified with fakes)
**Design Reference**: design-docs/specs/design-realtime-push.md section 10.4 (`--type`, cursor persistence); design-docs/specs/command.md "watch"; design-docs/specs/design-user-admin-capability.md section 3
**Created**: 2026-10-08

## Intent and context

`flying-mail watch --type received,sent` subscribes with
`scope.types = ["MESSAGE_RECEIVED","MESSAGE_SENT"]`. It persists its cursor
under a key that includes the type filter. Without `--type`, the behavior
and the cursor key are byte-identical to today.

Current code:

- `apps/cli/src/commands/watch.ts:runWatch`. Scope is built at lines
  ~127-135, and `cursorKey(...)` is called at line ~135.
- `apps/cli/src/watch-cursors.ts:cursorKey` and `WatchCursorKeyInput`.
- `packages/realtime-client/src/protocol.ts:MailEventStreamOptions.scope`
  is `{ domainId?, address? } | null`.
- `packages/realtime-client/src/stream.ts:130` forwards `options.scope`
  as-is in the subscribe variables.
- `apps/cli/src/args.ts:flagList` returns repeated values with empty
  values dropped. `hasFlag` detects that a flag is present.

## Non-goals

- Do not edit `apps/cli/src/main.ts`. Plan 05 owns it and adds the
  `--type` HELP line.
- Do not edit `commands/index.ts`, `args.ts` or `client.ts`.
- `apps/cli` does not depend on `@flying-mail/domain`. Do not add that
  dependency or touch `apps/cli/package.json` or `bun.lock`.
- No server changes (plan 02) and no web changes.

## writePaths

- packages/realtime-client/src/protocol.ts
- packages/realtime-client/src/stream.test.ts
- apps/cli/src/commands/watch.ts
- apps/cli/src/watch-cursors.ts
- apps/cli/src/watch.test.ts
- impl-plans/active/user-admin-03-cli-watch-type.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: realtime-client type

- `protocol.ts`: the scope type gains
  `readonly types?: readonly string[];`.
- `stream.ts` needs no change. If a forwarding change turns out to be
  required, stop and record it; `stream.ts` is not in writePaths.

### TASK-002: Type parsing (`watch.ts`)

- Add a local constant in enum declaration order:
  `MESSAGE_RECEIVED, MESSAGE_SENT, MESSAGE_UPDATED, MESSAGE_DELETED, DRAFT_SAVED, DRAFT_DELETED`.
- Add a local short-name map:
  - `received` -> `MESSAGE_RECEIVED`
  - `sent` -> `MESSAGE_SENT`
  - `updated` -> `MESSAGE_UPDATED`
  - `deleted` -> `MESSAGE_DELETED`
  - `draft-saved` -> `DRAFT_SAVED`
  - `draft-deleted` -> `DRAFT_DELETED`
- New exported pure function
  `parseWatchTypes(args: ParsedArgs): readonly string[] | null`:
  - If the `type` flag is absent, return `null`.
  - Otherwise take `args.flags.get("type")` (raw values), split each on
    `,`, trim, and drop empties.
  - If nothing remains (for example `--type=` or `--type ,`), throw
    `CliError(..., ExitCode.UsageError)`.
  - Match case-insensitively against the short names and against the full
    enum names (upper-cased).
  - `live` or `LIVE` -> UsageError with the message
    "LIVE is always delivered and cannot be filtered".
  - An unknown value -> UsageError that lists the accepted short names.
  - Deduplicate, then sort into the declaration order above.
- In `runWatch`, call `parseWatchTypes` **before** `resolveDomainId`, so
  that usage errors exit 2 without any network call.
- When the result is not `null`, add `types` to `scope`. When it is `null`,
  leave `types` out entirely; do not send `types: null`.

### TASK-003: Cursor key (`watch-cursors.ts`)

- `WatchCursorKeyInput` gains `readonly types?: readonly string[] | null`.
- `cursorKey`:
  - If `types` is absent, `null` or empty: return the existing string
    exactly as today.
  - Otherwise append `` `|types=${types.join(",")}` ``. The caller has
    already sorted the list.
- `runWatch` passes `types` to `cursorKey`.

## Pitfalls

- Backward compatibility: an existing `watch-cursors.json` entry, written
  without `--type`, must still be found. Assert this with a literal
  expected key string in the tests, not a recomputed one.
- The order of the `--type` values must not affect the key:
  `--type sent,received` and `--type received --type sent` produce the
  same key.
- `--json` and other flags are unchanged. The API key must never appear in
  the cursor key (`maskApiKey` already handles this; do not alter it).

## Tests (input or situation -> expected outcome)

`watch.test.ts`:

- `--type received,sent` -> the stream factory receives
  `scope.types === ["MESSAGE_RECEIVED","MESSAGE_SENT"]`.
- `--type SENT --type message_received` -> the same sorted list.
- `--type draft-saved` -> `["DRAFT_SAVED"]`.
- `--type live` -> exit 2, and no stream or GraphQL call is made.
- `--type bogus` -> exit 2. The message lists the accepted names.
- `--type=` -> exit 2.
- No `--type` -> the scope has no `types` key, and `cursorKey` equals the
  literal legacy string `` `${endpoint}|${prefix}|*|*` ``.
- With `--type sent` -> the key ends with `|types=MESSAGE_SENT`. A cursor
  stored under the legacy key is **not** used as `initialCursor`.
- `--type sent,received` and `--type received,sent` -> identical keys.

`stream.test.ts`:

- Options `scope: { types: ["MESSAGE_SENT"] }` -> the subscribe message
  variables contain `scope.types` unchanged.

## Verification (repo root; logs under `/tmp/user-admin-03-*.log`)

1. `bunx vitest run apps/cli packages/realtime-client` exits 0, and the
   existing CLI and realtime-client tests still pass.
2. `bun run --cwd apps/cli typecheck` and
   `bun run --cwd packages/realtime-client typecheck` both exit 0.
3. `bunx biome check apps/cli/src packages/realtime-client/src` exits 0.
4. `wc -l apps/cli/src/commands/watch.ts apps/cli/src/watch-cursors.ts`:
   both are under 1000 lines.
5. `git diff --quiet -- apps/cli/src/main.ts apps/cli/package.json bun.lock`
   exits 0. Run this before plan 05 joins, or limit it to
   `apps/cli/package.json bun.lock` after plan 05 joins.

## Done criteria

- [ ] TASK-001 to TASK-003 and the tests are complete.
- [ ] Verification steps 1-5 pass, with exit codes and log paths recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.
- If a check fails only in a file owned by another plan that runs in the
  same wave, that is a cross-plan transient. Record the file, the owner and
  the log, wait for the owner to report done, then re-run. Do not edit that
  file.

## Progress Log

(empty)
