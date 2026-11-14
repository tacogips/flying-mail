# Pending: remote MCP server decisions

Design: `design-docs/specs/design-mcp-server.md`. Each item below already has
a default **applied** in the design, so implementation is not blocked. Each
one is waiting for user confirmation and can be changed later.

## M1. Protocol era: dual-era instead of `initialize`-only

- **Finding:** the current MCP revision, 2026-07-28, removed the
  `initialize`/`initialized` handshake, `ping` and sessions. Every request
  now carries its version in `_meta`, and `server/discover` is mandatory.
  The request asked for `initialize` and `ping`, which are legacy
  (2025-11-25 and earlier) features.
- **Applied default:** a stateless dual-era server.
  - Modern requests are served per 2026-07-28: `server/discover`,
    `tools/list`, `tools/call`, header checks, and `-32022` / `-32020`.
  - `initialize`, `notifications/initialized` and `ping` are served for
    legacy clients on 2025-11-25, 2025-06-18 and 2025-03-26.
  - Modern `ping` gets `404` / `-32601`, as the new transport requires.
- Alternative A: legacy only (2025-11-25 and earlier). Fails for
  modern-only clients.
- Alternative B: modern only. Fails for clients that still send
  `initialize`.

## M2. Rate limit numbers

- **Applied default:** a new `MCP_RATE_LIMITER` binding, 120 requests per
  60 s, applied separately per API key and per client IP. When the binding
  is missing, the Worker answers `503` on `/mcp`. A binding error fails
  open, as for auth.
- Alternative: reuse `AUTH_RATE_LIMITER` (10 per 60 s). Too low for an agent
  session, and it couples MCP traffic to login budgets.

## M3. Size caps

- **Applied default:**
  - request body 7 MiB;
  - upload 5 MiB decoded, the same as REST;
  - inline `get_attachment` up to 256 KiB;
  - message body 20,000 characters by default, 100,000 at most;
  - thread bodies 4,000 per message, at most 50 messages;
  - HTML input 512 KiB.
- Alternative: lower the upload cap (for example 2 MiB) to reduce Worker
  CPU spent on base64 decoding, and steer large files to
  `POST /api/attachments`.

## M4. Trash semantics

- **Applied default:** `move_to_trash` only trashes and never purges, even
  for messages already in Trash. No permanent-delete tool exists.
- Alternative: expose the GraphQL two-stage `deleteMessages` behavior as a
  separate `delete_messages` tool.

## M5. Attachment links

- **Applied default:** `get_attachment` over the inline cap mints a
  single-download link valid for 10 minutes (TTL 60 to 3600 s). This
  requires FILE_LINK.
- Alternative: return metadata only, and add a separate link tool.

## M6. Annotations

- **Applied default:** the rule in design section 4.2.
  - Send, trash, delete, draft overwrite, role and active changes, and
    permission removal are `destructiveHint: true`.
  - Read state, tags and spam marks are `destructiveHint: false`, because
    another tool reverses them.
- Alternative: mark every write tool destructive.

## M7. No `outputSchema`

- **Applied default:** tools return `structuredContent` plus a serialized
  JSON text block, but declare no `outputSchema`.
- Alternative: declare output schemas, at the cost of strict conformance
  coupling with clients.
