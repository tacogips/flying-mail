# Command Design

The `mailcal` CLI (`apps/cli`) is a thin operator/developer tool over the same
GraphQL API. It holds no business logic of its own: every subcommand is a
GraphQL call, apart from `client serve`, which serves the browser mail client.

## Subcommands

```
mailcal
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
└── config
    ├── show
    └── set <key> <value>
```

### `mailcal client serve`

The headline command. Serves the built SolidJS bundle from `apps/web/dist` on
a local port and reverse-proxies `/graphql`, `/api/*` and `/files/*` to the
configured mailcal endpoint, so a developer or operator gets a full mail client
against a remote deployment without hosting anything.

```bash
mailcal client serve --endpoint https://mail.example.com --port 5173 --open
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
| `--endpoint <url>` | string | `$MAILCAL_ENDPOINT` or config file | Base URL of the mailcal deployment |
| `--api-key <key>` | string | `$MAILCAL_API_KEY` or config file | API key used for requests |
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

### `key create`

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--scope <spec>` | string[] | required | Repeatable `CAPABILITY[:domain[:pattern]]`, e.g. `MAIL_READ:example.com:support@example.com` |
| `--expires-in <dur>` | string | - | e.g. `30d`, `12h` |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAILCAL_ENDPOINT` | no | config file value | Deployment base URL |
| `MAILCAL_API_KEY` | no | config file value | API key |
| `MAILCAL_CONFIG` | no | `~/.config/mailcal/config.json` | Config file path |
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
