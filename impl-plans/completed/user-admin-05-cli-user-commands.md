# User Admin 05: `flying-mail user` command group

**Status**: Completed
**Plan ID**: user-admin-05-cli-user-commands
**Wave**: 1 (phase 27)
**Depends On**: none (it uses only existing GraphQL operations; tested with a fake client)
**Design Reference**: design-docs/specs/design-user-admin-capability.md section 2.8; design-docs/specs/command.md "user" and "Exit Codes"
**Created**: 2026-10-08

## Intent and context

Add CLI user administration over the existing GraphQL user operations. A
`USER_ADMIN` API key (plans 01 and 07) makes these operations reachable
from the CLI. The group does not include `create` or `invite`.

Current code to imitate:

- `apps/cli/src/commands/index.ts:keyCommands` and `domainCommands`:
  handler maps of `CommandHandler = (ctx: CommandContext) => Promise<ExitCode>`.
  They call `ctx.client.request<T>(document, variables)`, then
  `printJson` when `ctx.json` is set, otherwise `printTable`.
- `apps/cli/src/main.ts:COMMAND_GROUPS` (line 104) and the `HELP` string
  (lines ~20-102).
- `apps/cli/src/client.ts`: on a GraphQL error, the client throws
  `CliError(firstError.message, exitCodeForGraphQLError(code))`. This
  gives FORBIDDEN exit 4, NOT_FOUND exit 5, and other errors (such as
  CONFLICT) exit 1.
- `apps/cli/src/args.ts:parseArgs`: every leading non-flag token goes into
  `command`. So `user show a@b.c` gives
  `command = ["user","show","a@b.c"]` and `positionals = []`.

## Non-goals

- Do not edit `commands/index.ts` (715 lines), `args.ts`, `client.ts` or
  `exit-codes.ts`.
- Do not fix the `positionals[0]` behavior of existing commands.
- Do not import from `commands/watch.ts`. Plan 03 edits it concurrently.
- No `user create` or `user invite`.

## writePaths

- apps/cli/src/commands/user.ts (new)
- apps/cli/src/user.test.ts (new)
- apps/cli/src/main.ts
- apps/cli/src/cli.test.ts (only if an existing HELP or dispatch assertion must change; otherwise untouched)
- impl-plans/completed/user-admin-05-cli-user-commands.md (progress log only)

sharedPaths: none.

sharedPathNotes:

- `apps/cli/src/main.ts`: this plan is the only owner in this feature. It
  registers `["user", userCommands]` in `COMMAND_GROUPS`, adds the `user`
  lines to HELP, and adds a watch flag HELP line on behalf of plan 03:
  `--type <list>  received|sent|updated|deleted|draft-saved|draft-deleted (comma-separated or repeatable)`.

## File-level changes

### TASK-001: `commands/user.ts`

- Export `userCommands: ReadonlyMap<string, CommandHandler>` with these
  keys: `list`, `show`, `set-role`, `activate`, `deactivate`, `rule`,
  `template-rule`.
- Import the `CommandContext` and `CommandHandler` types from `./index`.
- Export a helper:
  `operands(args: ParsedArgs, skip: number): readonly string[]`, which
  returns `[...args.command.slice(skip), ...args.positionals]`.
  - Use skip 2 for `list`, `show`, `set-role`, `activate` and
    `deactivate`.
  - `rule` and `template-rule` read their action from `operands(args, 2)[0]`
    (`add` or `remove`), then their operands from `operands(args, 3)`.
  - A missing or unknown action -> UsageError (exit 2) with a usage line.
- `resolveUser(ctx, ref)`:
  - Query `{ users { id email name role active invitationStatus } }`.
  - Match by exact `id` first, then by email case-insensitively.
  - No match -> `CliError("User not found: <ref>", ExitCode.NotFoundError)`.
- `resolveDomain(ctx, ref)`, a local helper:
  - Query `{ domains { id name } }` and match by id, then by name.
  - No match -> exit 5 with "Domain not found: <ref>".
- **FORBIDDEN hint.** Wrap every handler. Catch a `CliError` whose
  `exitCode === ExitCode.ForbiddenError` and re-throw a `CliError` with the
  same exit code and the message `${original}\n${USER_ADMIN_HINT}`. Export
  `USER_ADMIN_HINT` with exactly this text: "User administration needs an
  API key with USER_ADMIN, created by an admin who is still an active
  ADMIN. Creating and inviting users is only available in the web UI."
- Commands. All validation happens before any network call; invalid or
  missing values exit 2 with a usage line.
  - `list`: table `ID EMAIL NAME ROLE ACTIVE INVITATION`, where ACTIVE is
    `yes` or `no`. `--json` prints the array.
  - `show <user>`: resolve the user, then query `user(id)` with
    `permissions { id effect addressPattern domain { id name } createdByUserId createdAt }`
    and `templatePermissions { id capability effect createdByUserId createdAt }`.
    - Human output is a `key: value` block (id, email, name, role, active,
      invitation), then the mail-rule table `ID EFFECT DOMAIN PATTERN` (a
      null domain shows as `*`), then the template-rule table
      `ID CAPABILITY EFFECT`.
    - `--json` prints the user object.
  - `set-role <user> <role>`: the role is upper-cased and must be one of
    ADMIN, MEMBER, VIEWER. Call
    `setUserRole(id:, role:) { id email role }` and print
    `Role of <email> is now <ROLE>.`
  - `activate <user>` / `deactivate <user>`: call
    `setUserActive(id:, active:)` and print `<email> is now active.` or
    `<email> is now inactive.`
  - `rule add <user>`:
    - `--effect` (ALLOW or DENY, upper-cased) and `--pattern` are
      required. `--domain` is optional and resolved; omitted means
      `domainId: null`.
    - Call `addUserMailPermission(userId:, input: { effect, domainId, addressPattern })`
      and print `Added rule <id>.` (`--json` prints the object).
  - `rule remove <user> <rule-id>`:
    - Fetch the user's `permissions { id }`. If the id is not among them,
      exit 5 with "Rule <id> does not belong to <email>".
    - Then call `removeUserMailPermission(id:)` and print
      `Removed rule <id>.`
  - `template-rule add <user>`: `--capability` must be one of
    TEMPLATE_READ, TEMPLATE_CREATE, TEMPLATE_UPDATE or TEMPLATE_DELETE, and
    `--effect` ALLOW or DENY. Call `addUserTemplatePermission` and print
    `Added template rule <id>.`
  - `template-rule remove <user> <rule-id>`: the same ownership check
    against `templatePermissions { id }`, then
    `removeUserTemplatePermission`, then print
    `Removed template rule <id>.`
- Use GraphQL variables for every value. Never interpolate user input into
  the document string.

### TASK-002: `main.ts`

- Import `userCommands` and add `["user", userCommands]` to
  `COMMAND_GROUPS`.
- HELP: add a `user ...` summary under the command list and a `user flags`
  block (`--effect`, `--domain`, `--pattern`, `--capability`). Add the
  `--type` line to the existing `watch flags` block (see sharedPathNotes).

## Pitfalls

- An operand may come before or after flags:
  `user rule add a@b.c --effect ALLOW --pattern '*'` and
  `user rule add --effect ALLOW --pattern '*' a@b.c` must both work.
- `--pattern '*'` is a literal `*`. Do not expand or validate it beyond
  non-empty; the server validates the grammar.
- Do not swallow non-FORBIDDEN errors. The CONFLICT message for the last
  active admin passes through unchanged and exits 1.
- `--json` is a global boolean that is already parsed into `ctx.json`.

## Tests (`user.test.ts`; a fake `CliGraphQLClient` that records `(document, variables)` and returns canned data or throws `CliError`)

- `operands(parseArgs(["user","show","a@b.c"]), 2)` -> `["a@b.c"]`.
  `["user","rule","add","--effect","ALLOW","a@b.c"]` -> action `add`,
  operands `["a@b.c"]`.
- `list` -> table headers in order. With `json: true`, the printed JSON
  parses back to the array.
- `show A@B.C` -> resolves case-insensitively. The second request carries
  `id`. Mail rules with a null domain print `*`.
- `show nobody` -> exit 5.
- `set-role a@b.c member` -> variables `{ id, role: "MEMBER" }`.
  `set-role a@b.c OWNER` -> exit 2, and no request is made.
- `activate` and `deactivate` -> `active: true` and `active: false`.
- `rule add a@b.c --effect deny --domain example.com --pattern support@example.com`
  -> variables `input = { effect: "DENY", domainId: <resolved id>, addressPattern: "support@example.com" }`.
  Without `--domain`, `domainId: null`. Missing `--pattern` -> exit 2.
- `rule remove a@b.c rule-x` where the user has no `rule-x` -> exit 5, and
  no remove mutation is sent.
- `template-rule add a@b.c --capability template_read --effect allow` ->
  `{ capability: "TEMPLATE_READ", effect: "ALLOW" }`. A bad capability ->
  exit 2.
- The fake client throws `CliError("Forbidden", 4)` -> the handler
  rejects with exit 4, and the message contains `USER_ADMIN_HINT`.
- The fake client throws `CliError("Cannot demote the last active admin...", 1)`
  -> exit 1 with the message unchanged and no hint.
- `runCli(["user","bogus"], env)` -> rejects with a `CliError` whose
  `exitCode` is 2 and whose message's "Available:" list includes `rule`.
  `runCli` throws, and `main` converts the error to the exit code.

## Verification (repo root; logs under `/tmp/user-admin-05-*.log`)

1. `bunx vitest run apps/cli` exits 0, and all existing CLI tests pass.
2. `bun run --cwd apps/cli typecheck` exits 0.
3. `bunx biome check apps/cli/src` exits 0.
4. `wc -l apps/cli/src/commands/user.ts apps/cli/src/main.ts`: both are
   under 1000 lines, and `user.ts` is ideally under 500.
5. `git diff --quiet -- apps/cli/src/commands/index.ts apps/cli/src/args.ts apps/cli/src/client.ts`
   exits 0.

## Done criteria

- [x] TASK-001 and TASK-002 and the tests are complete.
- [x] `grep -n '"user"' apps/cli/src/main.ts` shows the registration.
- [x] Verification steps 1-5 pass, with exit codes and log paths recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.
- If a check fails only in a file owned by another plan that runs in the
  same wave (for example plan 03's `watch.test.ts` during
  `bunx vitest run apps/cli`), that is a cross-plan transient. Record the
  file, the owner and the log, wait for the owner to report done, then
  re-run. Do not edit that file.

## Progress Log

### Session: 2026-10-08

**Tasks Completed**: TASK-001, TASK-002, and CLI command tests.

**Changes**: Added the `user` command map with list, show, set-role,
activate/deactivate, mail-rule add/remove and template-rule add/remove.
Inputs are validated before requests; user and domain lookup uses variables;
rule removal verifies target ownership. FORBIDDEN receives `USER_ADMIN_HINT`;
other errors retain their original message and exit code. Registered the group
and added user and watch `--type` help text. Added focused fake-client tests.

**Verification**:
- `bunx vitest run apps/cli`: exit 0, 130 passed, 0 failed; log
  `/tmp/user-admin-05-tests-final.log`.
- `bun run --cwd apps/cli typecheck`: exit 0; log
  `/tmp/user-admin-05-typecheck-final.log`.
- `bunx biome check apps/cli/src`: exit 0; log
  `/tmp/user-admin-05-biome-final.log`.
- Line counts: `user.ts` 485 and `main.ts` 244; log
  `/tmp/user-admin-05-linecount-final.log`.
- Protected files unchanged: exit 0; log
  `/tmp/user-admin-05-unchanged-final.log`.
- Registration found at `apps/cli/src/main.ts:123`; log
  `/tmp/user-admin-05-registration-final.log`.

**Prior Verification**: Initial test attempts exposed test fixture/context
issues and were corrected. Initial logs are
`/tmp/user-admin-05-cli-initial-vitest.log`,
`/tmp/user-admin-05-cli-initial-typecheck.log`, and
`/tmp/user-admin-05-cli-initial-biome.log`. A later CLI test run passed 129/130
before the shared-spy test issue was corrected; see
`/tmp/user-admin-05-tests-final1.log`.
An intermediate full Biome run found formatting in the concurrently edited
plan 03 watch files; that transient cleared on the final current-tree check,
which passed as recorded above.

### Review repair: TIC-05-001

**Finding**: `rejectUnexpectedFlags` treated documented global `--endpoint`
and `--api-key` options as invalid user-command flags.

**Correction**: Added the explicit global flag allowlist `json`, `endpoint`,
and `api-key`; all other unknown flags remain usage errors. Added regression
tests for list and mail-rule add with both global flags, including unchanged
mutation variables, and for an unknown flag exiting 2 without a request.

**Source SHA-256**:
- Before: `user.ts` `9da1682d3469716ad9a8dd084d21e3c53ab71001f06f650ea9c21c8c9f6f6ea4`,
  `user.test.ts` `f2dc034b06e960bcb65e56ba5680cb7dfb8c6c3514962aecc0f955e7dddfb31e`.
- After: `user.ts` `ee94f7a9a8dce615624e7535036a7fc1be11ee2e8cd9b95597696a35ea36c4c8`,
  `user.test.ts` `b489c4d3b90b93d8c46b3a5f8c348d9c7ff2866d40892aa3649e8b777366c21f`.

**Verification**:
- `bunx vitest run apps/cli`: exit 0, 132 passed, 0 failed;
  `/tmp/user-admin-05-tests-fix1.log`.
- `bun run --cwd apps/cli typecheck`: exit 0;
  `/tmp/user-admin-05-typecheck-fix1.log`.
- `bunx biome check apps/cli/src/commands/user.ts apps/cli/src/user.test.ts apps/cli/src/main.ts`:
  exit 0; `/tmp/user-admin-05-biome-fix1.log`.
- `bun -e 'import { runCli } from "./src/main.ts"; try { await runCli(["user", "list", "--endpoint", "http://127.0.0.1:9", "--api-key", "k"], { HOME: "/tmp/nonexistent-fm-home" }); } catch (error) { if (error instanceof Error && "exitCode" in error) console.log(error.exitCode, error.message); else throw error; }'`:
  observed exit code 6 (connection error), not usage exit 2;
  `/tmp/user-admin-05-runcli-global-flags-fix1.log`.
- `git diff --quiet -- apps/cli/src/commands/index.ts apps/cli/src/args.ts apps/cli/src/client.ts`:
  exit 0 (protected files unchanged).
- `wc -l apps/cli/src/commands/user.ts apps/cli/src/main.ts`: exit 0,
  485 and 244 lines; `/tmp/user-admin-05-linecount-fix1.log`.
- Protected-file check rerun: exit 0;
  `/tmp/user-admin-05-unchanged-fix1.log`.

### Review repair: ADV-05-001

**Finding**: Display names are not unique and were accepted as user
references, allowing a mutation to select an unintended account.

**Correction**: `resolveUser` now matches exact ID, then case-insensitive
email only. A display-name reference returns exit 5 with the existing
`User not found: <ref>` message. The test now asserts one users query and no
follow-up request. The case-insensitive email test and TIC-05-001 global flag
tests remain in place.

**Source SHA-256**:
- Before: `user.ts` `ee94f7a9a8dce615624e7535036a7fc1be11ee2e8cd9b95597696a35ea36c4c8`,
  `user.test.ts` `b489c4d3b90b93d8c46b3a5f8c348d9c7ff2866d40892aa3649e8b777366c21f`.
- After: `user.ts` `fbb5f411e30e8ccef0fdd2c277e24a97e7caa13aaa192c86264111f142bb3cff`,
  `user.test.ts` `72033d9ecb490dacc07f307c0003b3eedf7bd3b5bb43f60ca2ef415108fd55b`,
  `main.ts` `76302f5605afbf534e8954595e0a2717f54fe0a215d89ca585e3cbd80649e64c`.

**Verification**:
- `bunx vitest run apps/cli`: exit 0, 132 passed, 0 failed;
  `/tmp/user-admin-05-adv-r1-vitest.log`.
- `bun run --cwd apps/cli typecheck`: exit 0;
  `/tmp/user-admin-05-adv-r1-typecheck.log`.
- `bunx biome check apps/cli/src`: exit 0, 16 files checked;
  `/tmp/user-admin-05-adv-r1-biome.log`.
- `wc -l apps/cli/src/commands/user.ts apps/cli/src/main.ts`: exit 0,
  483 and 244 lines; `/tmp/user-admin-05-adv-r1-lines.log`.
- `git diff --quiet -- apps/cli/src/commands/index.ts apps/cli/src/args.ts apps/cli/src/client.ts apps/cli/src/cli.test.ts`:
  exit 0; `/tmp/user-admin-05-adv-r1-protected.log`.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
