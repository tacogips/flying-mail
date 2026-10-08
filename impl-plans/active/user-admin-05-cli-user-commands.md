# User Admin 05: `flying-mail user` command group

**Status**: Ready
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
- impl-plans/active/user-admin-05-cli-user-commands.md (progress log only)

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

- [ ] TASK-001 and TASK-002 and the tests are complete.
- [ ] `grep -n '"user"' apps/cli/src/main.ts` shows the registration.
- [ ] Verification steps 1-5 pass, with exit codes and log paths recorded.

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

(empty)
