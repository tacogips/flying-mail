# User Admin 03: `flying-mail watch --type` and realtime-client scope type

**Status**: Completed
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
- impl-plans/completed/user-admin-03-cli-watch-type.md (progress log only)

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

- [x] TASK-001 to TASK-003 and the tests are complete.
- [x] Verification steps 1-5 pass, with exit codes and log paths recorded.

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

### Session: 2026-10-08 Step 6 implementation

**Tasks Completed**: TASK-001, TASK-002, TASK-003, and assigned regression tests.

**Notes**:
- Added readonly `scope.types`, case-insensitive short/full event type parsing, declaration-order deduplication, early usage validation, and a filtered cursor key suffix while preserving the no-filter key.
- Added stream forwarding and CLI behavior tests. Focused tests passed: `bunx vitest run apps/cli/src/watch.test.ts packages/realtime-client/src/stream.test.ts` (exit 0, 33 passed; `/tmp/user-admin-03-focused-tests.log`).
- CLI and realtime-client typechecks passed (exit 0; `/tmp/user-admin-03-cli-typecheck.log`, `/tmp/user-admin-03-realtime-typecheck.log`). Scoped Biome passed (exit 0; `/tmp/user-admin-03-biome.log`). Line counts are 315 and 88 (exit 0; `/tmp/user-admin-03-line-count.log`). The package/lock boundary check passed (exit 0; `/tmp/user-admin-03-untouched.log`).
- Initial aggregate `bunx vitest run apps/cli packages/realtime-client` had 150 passing and 2 failing tests, both in concurrently owned `apps/cli/src/user.test.ts` (plan 05); see `/tmp/user-admin-03-check-agent-vitest.log`. After that owner completed, the aggregate rerun passed 152/152 (exit 0; `/tmp/user-admin-03-aggregate-rerun.log`). No edits were made to the other plan's files.
- Initial scoped Biome check found formatting in this plan's `watch.ts` and `watch-cursors.ts`; formatted only those files and the final scoped Biome check passed. Format edit hashes are recorded in `tmp/user-admin-s310/user-admin-03-cli-watch-type/attempt-1/format-{before,after}.sha256`.
- Final assigned gate outcomes: both package typechecks, scoped Biome, line-count, and untouched package/lock checks exited 0 with logs at `/tmp/user-admin-03-cli-typecheck.log`, `/tmp/user-admin-03-realtime-typecheck.log`, `/tmp/user-admin-03-biome.log`, `/tmp/user-admin-03-line-count.log`, and `/tmp/user-admin-03-untouched.log`.

### Session: 2026-10-08 Step 6 verification rerun

**Tasks Completed**: Re-ran assigned behavioral and source checks on the current shared tree after the initial branch process exited with provider status 137.

**Notes**:
- `bunx vitest run apps/cli packages/realtime-client` exited 0: 7 files and 154 tests passed (`/tmp/user-admin-03-step6-vitest.log`).
- `bun run --cwd apps/cli typecheck` and `bun run --cwd packages/realtime-client typecheck` exited 0 (`/tmp/user-admin-03-step6-cli-typecheck.log`, `/tmp/user-admin-03-step6-realtime-typecheck.log`). `bunx biome check apps/cli/src packages/realtime-client/src` exited 0 with 24 files checked and no fixes (`/tmp/user-admin-03-step6-biome.log`).
- `wc -l apps/cli/src/commands/watch.ts apps/cli/src/watch-cursors.ts` exited 0 with 315 and 88 lines (`/tmp/user-admin-03-step6-line-count.log`). `git diff --quiet -- apps/cli/package.json bun.lock` exited 0 (`/tmp/user-admin-03-step6-package-lock-boundary.log`).
- The broader `git diff --quiet -- apps/cli/src/main.ts apps/cli/package.json bun.lock` returned 1 because plan 05 owns and changed `apps/cli/src/main.ts`; this is expected after plan 05 joined, and the plan's verification instructions explicitly narrow the check to package and lock files. `packages/realtime-client/src/stream.ts` remains unchanged (exit 0).
- Re-run evidence is recorded under `tmp/user-admin-s310/user-admin-03-cli-watch-type/attempt-1/step6-*`; source checks passed without edits to implementation files.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
