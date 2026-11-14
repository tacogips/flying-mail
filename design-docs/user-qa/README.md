# User Q&A

This directory contains items requiring user confirmation or decision.

## Purpose

Store questions, pending decisions, and items awaiting user approval.

## File Naming Convention

| Prefix | Use Case |
|--------|----------|
| `qa-` | Questions/confirmation items |
| `pending-` | Pending decisions |

## Current Items

- [qa-example.md](./qa-example.md) - Example: Database Selection (template example)
- [pending-example.md](./pending-example.md) - Example: CLI Output Format (template example)
- [pending-auth-hardening.md](./pending-auth-hardening.md) - Bootstrap key storage (default: 0600 file under .private/), fail-fast on half configuration, rate-limit numbers and fail-open, preview_urls=false (all defaults applied; awaiting confirmation)
- [pending-realtime-push.md](./pending-realtime-push.md) - Real-time push. Defaults applied, awaiting confirmation: single hub Durable Object; 7-day event retention; connection limits on the AUTH_RATE_LIMITER binding; event append not atomic with the mail write; no WebSocket through client serve or Node; hand-written client; events that are not emitted
- [pending-user-admin.md](./pending-user-admin.md) - USER_ADMIN capability and event-type filter. Defaults applied, awaiting confirmation: who may add USER_ADMIN to an existing key (creator admin only); no extra web confirmation; empty or LIVE `types` rejected; last-active-admin race kept as a residual risk; USER_ADMIN keys see the domain catalogue
- [pending-mcp-server.md](./pending-mcp-server.md) - Remote MCP server. Defaults applied, awaiting confirmation: dual-era protocol (2026-07-28 plus legacy initialize); MCP_RATE_LIMITER 120/60 per key and IP; size caps; trash never purges; single-download attachment links; annotation rule; no outputSchema
- [pending-webmail-completion.md](./pending-webmail-completion.md) - Multi-recipient storage default (D8, applied; awaiting user confirmation), live binding checks (answered), compose Reply-To (default: hidden)

## Adding New Items

1. Create a new file with appropriate prefix (`qa-` or `pending-`)
2. Include clear description of the question or decision needed
3. List available options if applicable
4. Update this README.md with a reference to the new item
