# Command Design

The `flying-mail` CLI (`apps/cli`) is a thin operator/developer tool over the same
GraphQL API. It holds no business logic of its own: every subcommand is a
GraphQL call, apart from `client serve`, which serves the browser mail client.

## Subcommands

```
flying-mail
├── admin
│   └── bootstrap        Create the first admin on an empty deployment (token-gated)
├── client
│   └── serve            Serve the browser mail client locally
├── domain
│   ├── list
│   ├── add <name>
│   └── verify <id>
├── key
│   ├── list
│   ├── create <name>
│   └── revoke <id>
├── mail
│   ├── list
│   ├── show <id>
│   ├── send
│   └── fetch            Poll NOT_FETCHED messages and acknowledge them
├── user                 User administration (ADMIN session or USER_ADMIN key)
│   ├── list
│   ├── show <user>
│   ├── set-role <user> <ADMIN|MEMBER|VIEWER>
│   ├── activate <user>
│   ├── deactivate <user>
│   ├── rule add|remove
│   └── template-rule add|remove
├── watch                Stream mail events over WebSocket (subscription)
└── config
    ├── show
    └── set <key> <value>
```

### `flying-mail client serve`

The headline command. Serves the built SolidJS bundle from `apps/web/dist` on
a local port and reverse-proxies `/graphql`, `/api/*` and `/files/*` to the
configured flying-mail endpoint, so a developer or operator gets a full mail client
against a remote deployment without hosting anything.

```bash
flying-mail client serve --endpoint https://mail.example.com --port 5173 --open
```

The proxy injects `Authorization: Bearer <api key>` when one is configured, so
the browser client can run against an endpoint using key auth instead of a
session cookie. That injection happens only for loopback-bound listeners; a
non-loopback `--host` requires `--allow-remote` and disables key injection,
because a key-injecting proxy reachable from the network is an open relay for
that key.

## Flags and Options

### Global

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--endpoint <url>` | string | `$FLYING_MAIL_ENDPOINT` or config file | Base URL of the flying-mail deployment |
| `--api-key <key>` | string | `$FLYING_MAIL_API_KEY` or config file | API key used for requests |
| `--json` | boolean | `false` | Emit machine-readable JSON instead of tables |
| `--quiet` | boolean | `false` | Suppress non-essential output |
| `--help` / `--version` | boolean | `false` | Standard |

### `client serve`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port <n>` | number | `5173` | Listen port |
| `--host <addr>` | string | `127.0.0.1` | Listen address |
| `--open` | boolean | `false` | Open the default browser on start |
| `--allow-remote` | boolean | `false` | Permit a non-loopback `--host`; disables API key injection |
| `--dist <dir>` | string | bundled `apps/web/dist` | Serve an alternate build |

### `admin bootstrap`

Calls `bootstrapAdmin` without an API key. The token is read **only** from
`FLYING_MAIL_BOOTSTRAP_TOKEN`, never from a flag, so it stays out of argv
and shell history. If the token is missing, the command exits 2 before any
network call. It also refuses to run when `--secret-file` already exists,
because a bootstrap cannot be repeated. On success it writes the API key
secret to `--secret-file` (exclusive create, mode 0600) and prints the user
id, email, name, role, key prefix and file path. It never prints the
secret. The `mise run bootstrap-admin <email> <name>` task wraps this
command with `--secret-file <repo>/.private/bootstrap-admin-api-key`. See
`design-security-model.md` section 3.5.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--email <addr>` | string | required | Admin email |
| `--name <name>` | string | required | Admin display name |
| `--secret-file <path>` | string | `.private/bootstrap-admin-api-key` | Where the full API key is written |

### `mail list`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--limit <n>` | number | `20` | Messages to show |
| `--from <addr>` | string | - | Sender filter |
| `--to <addr>` | string | - | Recipient filter, cc **not** included |
| `--recipient <addr>` | string | - | Recipient filter, cc/bcc included |
| `--search <text>` | string | - | Full text over subject, snippet and body |
| `--has-attachment` / `--no-attachment` | boolean | - | Attachment presence |
| `--attachment-kind <k>` | string[] | - | Repeatable or comma-separated kind filter |
| `--tag <name>` | string[] | - | Tag filter by name; unknown names error |
| `--include-spam` | boolean | `false` | Include spam-tagged messages |
| `--unread` | boolean | `false` | Unread only |

### `mail fetch`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--limit <n>` | number | `20` | Messages per poll |
| `--ack` | boolean | `false` | Call `markMessagesFetched` after printing |
| `--watch` | boolean | `false` | Poll continuously |
| `--interval <s>` | number | `30` | Seconds between polls with `--watch` |

### `mail send`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--from <addr>` | string | required | Sender; must be within a `MAIL_SEND` scope |
| `--to <addr>` | string[] | required | Repeatable recipient |
| `--cc` / `--bcc <addr>` | string[] | - | Repeatable |
| `--subject <s>` | string | required | Subject |
| `--text <s>` / `--text-file <p>` | string | - | Plain-text body (`-` reads stdin) |
| `--html-file <p>` | string | - | HTML body |
| `--attach <path>` | string[] | - | Repeatable; uploaded before sending |

### `watch`

This command subscribes to `mailEvents` and keeps reconnecting. The full
design is in `design-realtime-push.md` section 10.4.

- **Authentication.** The API key is sent only in the `connection_init`
  payload.
- **Cursor.** It is saved in `<config dir>/watch-cursors.json` with mode
  0600. Each entry is keyed by endpoint, key prefix and scope. The secret is
  never saved there.
- **Output.** With `--json`, it prints one JSON object per line (NDJSON),
  including `LIVE` and `RESYNC_REQUIRED` control lines.
- **Exit codes.** It exits 0 on SIGINT or SIGTERM, 3 on close `4401`, 4 on
  close `4403`, and 1 on other fatal closes. Network failures are retried
  with backoff, never turned into an exit.

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--domain <name\|id>` | string | - | Only events for this domain |
| `--address <addr>` | string | - | Only events whose authorized addresses include this address |
| `--type <list>` | string[] | - | Repeatable or comma-separated: `received`, `sent`, `updated`, `deleted`, `draft-saved`, `draft-deleted`, or the full enum names. Sent as `scope.types`. The cursor key gains a `|types=...` suffix only when this flag is set |
| `--json` | boolean | `false` | NDJSON output (global flag) |

### `user`

This group is implemented in `apps/cli/src/commands/user.ts`. The full
design is in `design-user-admin-capability.md` section 2.8.

- **Credential.** It needs an API key with `USER_ADMIN` whose creator is
  still an active ADMIN.
- **`<user>`.** It is a user id or an email, matched case-insensitively.
- **Operands.** They may come before or after flags.
- **Errors.** `FORBIDDEN` exits 4 and adds a hint about `USER_ADMIN` and
  creator liveness. An unknown user, or a rule that does not belong to the
  user, exits 5. The last-active-admin `CONFLICT` exits 1.
- **Not provided.** There is no `user create` or `user invite`. Those stay
  web-only.

| Subcommand | Flags |
|------------|-------|
| `list` | `--json` |
| `show <user>` | `--json` |
| `set-role <user> <ADMIN\|MEMBER\|VIEWER>` | - |
| `activate <user>` / `deactivate <user>` | - |
| `rule add <user>` | `--effect ALLOW\|DENY` (required), `--domain <name\|id>` (optional; omitted = every domain), `--pattern <pattern>` (required; `*` = every address) |
| `rule remove <user> <rule-id>` | - |
| `template-rule add <user>` | `--capability TEMPLATE_READ\|TEMPLATE_CREATE\|TEMPLATE_UPDATE\|TEMPLATE_DELETE` (required), `--effect ALLOW\|DENY` (required) |
| `template-rule remove <user> <rule-id>` | - |

### `key create`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--scope <spec>` | string[] | required | Repeatable `CAPABILITY[:domain[:pattern]]`, e.g. `MAIL_READ:example.com:support@example.com` |
| `--expires-in <dur>` | string | - | e.g. `30d`, `12h` |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FLYING_MAIL_ENDPOINT` | no | config file value | Deployment base URL |
| `FLYING_MAIL_API_KEY` | no | config file value | API key |
| `FLYING_MAIL_CONFIG` | no | `~/.config/mailcal/config.json` | Config file path |
| `FLYING_MAIL_BOOTSTRAP_TOKEN` | `admin bootstrap` only | - | Bootstrap token; supply via `kinko exec` |
| `NO_COLOR` | no | - | Disables ANSI color when set |

The API key is read from the environment or the config file and is never
echoed back by any command; `config show` masks it to its `keyPrefix`.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Usage error (unknown subcommand, missing required flag) |
| 3 | Authentication failure (`UNAUTHENTICATED`) |
| 4 | Authorization failure (`FORBIDDEN`) |
| 5 | Not found (`NOT_FOUND`) |
| 6 | Network / endpoint unreachable |
