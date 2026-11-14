# CLI Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/command.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
`apps/cli`: the `mailcal` command-line tool. Argument parsing, config
resolution, a GraphQL client, the subcommands from `command.md`, and
`client serve` -- a static file server for the built web client that proxies
API traffic to a remote deployment.

### Scope
**Included**: `apps/cli/src/**`.
**Excluded**: the web bundle itself.

---

## Modules

### 1. Argument parsing and config

#### apps/cli/src/args.ts

**Status**: NOT_STARTED

```typescript
interface ParsedArgs {
  readonly command: readonly string[];          // e.g. ["client", "serve"]
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly positionals: readonly string[];
}
function parseArgs(argv: readonly string[]): ParsedArgs;
function flagString(args: ParsedArgs, name: string): string | undefined;
function flagNumber(args: ParsedArgs, name: string): number | undefined;
function flagBoolean(args: ParsedArgs, name: string): boolean;
function flagList(args: ParsedArgs, name: string): readonly string[];
```

Hand-rolled: `--flag=value`, `--flag value`, repeated flags accumulating,
`--` ending flag parsing. No dependency for something this small.

#### apps/cli/src/config.ts

**Status**: NOT_STARTED

```typescript
interface CliConfig {
  readonly endpoint: string | null;
  readonly apiKey: string | null;
}
function resolveConfig(args: ParsedArgs, env: Record<string, string | undefined>):
  Promise<CliConfig>;
function configFilePath(env: Record<string, string | undefined>): string;
function readConfigFile(path: string): Promise<Partial<CliConfig>>;
function writeConfigFile(path: string, config: Partial<CliConfig>): Promise<void>;
/** "ybm_a1b2c3d4e5f6_***" -- never the full secret. */
function maskApiKey(key: string): string;
```

Precedence: flags, then environment, then the config file. The file is written
with mode `0600`; `config show` prints the masked key only.

#### apps/cli/src/exit-codes.ts

**Status**: NOT_STARTED

```typescript
enum ExitCode {
  Success = 0, GeneralError = 1, UsageError = 2, AuthError = 3,
  ForbiddenError = 4, NotFoundError = 5, NetworkError = 6,
}
function exitCodeForGraphQLError(code: string): ExitCode;
```

**Checklist**:
- [ ] Three modules
- [ ] Unit tests: every flag form, precedence order, key masking, code mapping

---

### 2. GraphQL client and output

#### apps/cli/src/client.ts

**Status**: NOT_STARTED

```typescript
interface CliGraphQLClient {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}
/** Throws CliError carrying the mapped ExitCode on any GraphQL/network error. */
function createCliClient(config: CliConfig): CliGraphQLClient;
class CliError extends Error { constructor(message: string, readonly exitCode: ExitCode); }
```

#### apps/cli/src/output.ts

**Status**: NOT_STARTED

```typescript
function printTable(headers: readonly string[],
                    rows: readonly (readonly string[])[]): void;
function printJson(value: unknown): void;
/** Honors NO_COLOR. */
function colorize(text: string, color: "red" | "green" | "dim"): string;
```

**Checklist**:
- [ ] Both modules
- [ ] Unit tests: column alignment, NO_COLOR suppression, error mapping

---

### 3. Subcommands

#### apps/cli/src/commands/{domain,key,mail,config}.ts

**Status**: NOT_STARTED

```typescript
interface CommandContext {
  readonly args: ParsedArgs;
  readonly config: CliConfig;
  readonly client: CliGraphQLClient;
  readonly json: boolean;
}
type CommandHandler = (ctx: CommandContext) => Promise<ExitCode>;

const domainCommands: ReadonlyMap<string, CommandHandler>;  // list, add, verify
const keyCommands: ReadonlyMap<string, CommandHandler>;     // list, create, revoke
const mailCommands: ReadonlyMap<string, CommandHandler>;    // list, show, send, fetch
const configCommands: ReadonlyMap<string, CommandHandler>;  // show, set

/** Parses `CAPABILITY[:domain[:pattern]]` into a scope input. */
function parseScopeSpec(spec: string):
  { capability: string; domainName: string | null; addressPattern: string };
/** Parses "30d" / "12h" / "45m" into an absolute ISO timestamp. */
function parseDuration(value: string, now: Date): string;
```

`mail fetch` polls `messages(filter: { fetchStatus: NOT_FETCHED })`, prints
them, and with `--ack` calls `markMessagesFetched`; `--watch` loops on
`--interval`. `mail send` uploads each `--attach` file through
`POST /api/attachments` before issuing the mutation.

**Checklist**:
- [ ] Four command modules
- [ ] Unit tests: `parseScopeSpec` accept/reject table, `parseDuration`,
      `mail fetch --ack` issuing the acknowledgment after printing

---

### 4. client serve

#### apps/cli/src/commands/client-serve.ts

**Status**: NOT_STARTED

```typescript
interface ClientServeOptions {
  readonly port: number;
  readonly host: string;
  readonly distDir: string;
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly allowRemote: boolean;
  readonly open: boolean;
}
function resolveClientServeOptions(ctx: CommandContext): ClientServeOptions;
function createClientServeApp(options: ClientServeOptions): Hono;
function runClientServe(ctx: CommandContext): Promise<ExitCode>;
/** True for 127.0.0.0/8, ::1 and "localhost". */
function isLoopbackHost(host: string): boolean;
```

The app proxies `/graphql`, `/api/*` and `/files/*` to `options.endpoint`,
forwarding method, headers (minus hop-by-hop ones and the inbound `host`) and
body, and streams the response back. Everything else is served from
`distDir`, falling back to `index.html` for SPA routes.

**Security rule, enforced in `resolveClientServeOptions`**: the API key is
injected as `Authorization: Bearer ...` only when the listener is bound to a
loopback host. A non-loopback `--host` requires `--allow-remote` *and*
disables key injection entirely -- a key-injecting proxy reachable from the
network is an open relay for that key. Attempting a non-loopback host without
`--allow-remote` is a usage error.

The static file server resolves each request path against `distDir` and
rejects any resolved path escaping it, so `..%2f` traversal cannot read
arbitrary files.

**Checklist**:
- [ ] Options resolution, proxy app, runner, loopback check
- [ ] Unit tests: proxy forwards method/body/headers and strips `host`;
      key injected on loopback; key **not** injected with `--allow-remote`;
      non-loopback host without `--allow-remote` is a usage error;
      SPA fallback serves `index.html`; path traversal rejected

#### apps/cli/src/main.ts

**Status**: NOT_STARTED

```typescript
function runCli(argv: readonly string[],
                env: Record<string, string | undefined>): Promise<ExitCode>;
```

Dispatches to the command tables, renders `--help`/`--version`, converts a
`CliError` into its exit code with a one-line stderr message, and is invoked
under an `import.meta.main`-style guard so it can be imported by tests without
running.

**Checklist**:
- [ ] Dispatcher and help text
- [ ] Unit tests: unknown command exits 2, `--help` exits 0, a `CliError`
      propagates its code

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Args | `apps/cli/src/args.ts` | NOT_STARTED | - |
| Config | `apps/cli/src/config.ts` | NOT_STARTED | - |
| Exit codes | `apps/cli/src/exit-codes.ts` | NOT_STARTED | - |
| Client | `apps/cli/src/client.ts` | NOT_STARTED | - |
| Output | `apps/cli/src/output.ts` | NOT_STARTED | - |
| Commands | `apps/cli/src/commands/*.ts` | NOT_STARTED | - |
| client serve | `apps/cli/src/commands/client-serve.ts` | NOT_STARTED | - |
| Entry | `apps/cli/src/main.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Args, config, exit codes, client and output

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `apps/cli/src/{args,config,exit-codes,client,output}.ts`
**Dependencies**: infrastructure-graphql:TASK-004

**Completion Criteria**:
- [ ] Flag parsing in all supported forms
- [ ] Config precedence and key masking
- [ ] GraphQL error to exit code mapping
- [ ] Unit tests as listed

### TASK-002: client serve

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/cli/src/commands/client-serve.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] Proxy for `/graphql`, `/api/*`, `/files/*`
- [ ] Loopback-only key injection, `--allow-remote` gate
- [ ] SPA fallback and path-traversal rejection
- [ ] Unit tests as listed

### TASK-003: Domain, key, mail and config subcommands

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/cli/src/commands/{domain,key,mail,config}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] Every subcommand in `command.md`
- [ ] `parseScopeSpec` and `parseDuration`
- [ ] `mail fetch --ack` and `--watch`
- [ ] Unit tests as listed

### TASK-004: Entry point

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/cli/src/main.ts`
**Dependencies**: TASK-002, TASK-003

**Completion Criteria**:
- [ ] Dispatcher, help, version, exit-code propagation
- [ ] Unit tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `infrastructure-graphql.md`, `app-web-client.md` (for the bundle) | BLOCKED until Phase 4 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: Initial plan

## Related Plans

- **Previous**: `impl-plans/app-web-client.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
