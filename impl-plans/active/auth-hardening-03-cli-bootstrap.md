# Auth Hardening 03: CLI `admin bootstrap` and mise `bootstrap-admin`

**Status**: Ready
**Plan ID**: auth-hardening-03-cli-bootstrap
**Wave**: 1 (phase 17)
**Depends On**: none (implements against the pinned GraphQL `bootstrapAdmin(email, name, token)` contract)
**Design Reference**: design-docs/specs/design-security-model.md section 3.5; design-docs/specs/command.md `admin bootstrap`
**Created**: 2026-10-07

## Intent and context

An operator creates the first admin on a freshly deployed (or wiped)
instance with:

```
kinko exec -- env FLYING_MAIL_ENDPOINT=https://mail.tacoserve.online mise run bootstrap-admin <email> <name>
```

The token comes only from `FLYING_MAIL_BOOTSTRAP_TOKEN`. The full API key
secret is written to a 0600 file and never printed. The CLI subcommand does
the work, and the mise task wraps it.

## Non-goals

- No other CLI changes.
- No server-side changes.
- No live calls in tests; fetch is mocked.

## writePaths

- apps/cli/src/commands/admin-bootstrap.ts (new)
- apps/cli/src/admin-bootstrap.test.ts (new)
- apps/cli/src/main.ts
- mise.toml
- impl-plans/active/auth-hardening-03-cli-bootstrap.md (progress log only)

sharedPaths: none.

## File-level changes

### `commands/admin-bootstrap.ts`

- `export const adminCommands: ReadonlyMap<string, CommandHandler> = new Map([["bootstrap", bootstrapAdminCommand]])`.
  Imitate `apps/cli/src/commands/index.ts:keyCommands`.
- Handler steps, in this order:
  1. Read `--email`, `--name` and `--secret-file` via `flagString`. If
     email or name is missing, throw a `CliError` with `ExitCode.UsageError`
     (2).
  2. Read `ctx.env["FLYING_MAIL_BOOTSTRAP_TOKEN"]`, trimmed. If it is
     missing or empty, exit with the usage code and the message
     "FLYING_MAIL_BOOTSTRAP_TOKEN is not set (run under kinko exec)". Make
     no network call.
  3. The secret file path defaults to `.private/bootstrap-admin-api-key`
     (resolved against `process.cwd()`). If it already exists, exit 1 with
     a message. Run `mkdir -p` on its parent. Both checks happen **before**
     the network call.
  4. Build a client with
     `createCliClient({ endpoint: ctx.config.endpoint, apiKey: null })`.
     **Never** send a configured API key.
  5. Send a mutation with **variables**:
     `mutation($email: String!, $name: String!, $token: String!) { bootstrapAdmin(email: $email, name: $name, token: $token) { secret apiKey { keyPrefix } user { id email name role } } }`.
  6. Write the secret with `writeFile(path, secret + "\n", { mode: 0o600, flag: "wx" })`.
  7. Print the user id, email, name, role, `keyPrefix` and the secret file
     path. Use `printJson` when `--json` is set, otherwise
     `printTable`/plain lines in the style of the key commands.
  8. Return `ExitCode.Success`.
- Error mapping is unchanged: the client already maps GraphQL codes
  (FORBIDDEN -> 4; others -> 1).

### `main.ts`

- Register `["admin", adminCommands]` in `COMMAND_GROUPS` (about line 88).
- Add to HELP: `admin bootstrap  Create the first admin (token from $FLYING_MAIL_BOOTSTRAP_TOKEN)`.
- Add an "admin bootstrap flags" block listing `--email`, `--name` and
  `--secret-file`.

### `mise.toml`

Add after `cf-deploy`:

```
[tasks.bootstrap-admin]
description = "Create the first admin on an empty deployment (run under kinko exec; needs FLYING_MAIL_BOOTSTRAP_TOKEN and FLYING_MAIL_ENDPOINT)"
usage = '''
arg "<email>"
arg "<name>"
'''
run = 'bun run --cwd apps/cli start -- admin bootstrap --email "$usage_email" --name "$usage_name" --secret-file "{{config_root}}/.private/bootstrap-admin-api-key"'
```

Imitate the `usage`/`$usage_*` style of `[tasks.mail-dest-add]`.

## Pitfalls

- The token must never be accepted as a flag. Do not add `--token`.
- The secret must never reach stdout, stderr, or an error message, even
  when the file write fails after a successful bootstrap. In that case,
  print an error that says bootstrap succeeded but the key could not be
  stored, and exit 1. Bootstrap cannot be repeated, so the path check in
  step 3 exists to prevent this.
- Do not inline the token into the GraphQL document string. Always pass it
  as a variable.
- `--cwd apps/cli` changes the working directory, which is why the mise task
  passes an absolute `{{config_root}}` path.

## Tests (`input -> expected`)

Mock `fetch` and use a tmp dir. Imitate `apps/cli/src/cli.test.ts`.

- Token env missing -> exit 2, and fetch is not called.
- Email missing -> exit 2.
- The secret file already exists -> exit 1, and fetch is not called.
- Success:
  - The request body's `variables.token` equals the env value.
  - The query string does not contain the token.
  - There is no `authorization` header, even with `FLYING_MAIL_API_KEY` set.
  - The file contains the secret, and its mode is `& 0o777 === 0o600`.
  - Captured stdout contains the `keyPrefix` and does not contain the
    secret.
- `--json` -> parsed output has no `secret` field.
- The server returns FORBIDDEN -> exit 4, and no file is written.
- The server returns CONFLICT -> exit 1, and no file is written.

## Drift protocol

- Before every edit, re-read the target file and record its sha256 before
  and after the edit.
- `mise.toml` is otherwise untouched by this feature. Edit only the new
  task block.

## Verification (from the repository root)

1. `bunx vitest run apps/cli` must exit 0.
2. `bun run --cwd apps/cli typecheck` must exit 0.
3. `biome check apps/cli/src --diagnostic-level=warn` must exit 0.
4. `mise tasks ls` must list `bootstrap-admin`.
5. `env -u FLYING_MAIL_BOOTSTRAP_TOKEN mise run bootstrap-admin a@example.com A`
   must exit non-zero with the "not set" message and make no network call.

## Done criteria

- [ ] `flying-mail admin bootstrap` and `mise run bootstrap-admin` exist as
      specified.
- [ ] All tests listed above pass.
- [ ] Verification steps 1-5 pass, with evidence recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
