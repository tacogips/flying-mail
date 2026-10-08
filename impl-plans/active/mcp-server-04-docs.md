# MCP Server 04: README Client Configuration and Deploy-Skill Smoke Check (documentation only)

**Status**: Not Started
**Plan ID**: mcp-server-04-docs
**Wave**: 1 (phase 30)
**Depends On**: none (documents the accepted design; no code dependency)
**Design Reference**: design-docs/specs/design-mcp-server.md sections 2.2, 3, 3.3, 4.4, 11
**Created**: 2026-10-08

## Intent and context

Operators and agent users need three things:

- how to connect MCP clients to `https://mail.tacoserve.online/mcp`;
- how to issue a least-privilege API key for MCP;
- after a deploy, how to smoke-check the endpoint without ever printing the
  key.

This is a **documentation-only** plan.

Repository context:

- `README.md` (509 lines). The `## API` section (line ~93) includes
  `#### User administration by API key` (~163) and
  `### Subscriptions (real-time push)` (~203). `## Agent quick start` is at
  ~459.
- `.agents/skills/flying-mail-deploy/SKILL.md` (269 lines):
  - `## Resource inventory` has the table row
    `Rate limit binding | AUTH_RATE_LIMITER (10 requests per 60 s)`;
  - `## Post-deploy smoke checks` (~111) already uses the pattern
    `kinko --path "$PWD" exec --env FLYING_MAIL_API_KEY -- sh -c '... "authorization: Bearer $FLYING_MAIL_API_KEY" ...'`.
- `.codex/skills/flying-mail-deploy` is a symlink to the same file. Do not
  touch the symlink.

## Non-goals

- No source, test, `wrangler.toml` or design-doc edits.
- No real key values anywhere. Use placeholders only: `$FLYING_MAIL_MCP_KEY`
  or `ybm_<prefix>_<secret>`.
- No deploy steps change except the smoke check and the inventory row.
- No CLI helper.

## writePaths

- README.md
- .agents/skills/flying-mail-deploy/SKILL.md
- impl-plans/active/mcp-server-04-docs.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: README `### MCP server` (inside `## API`, after the Subscriptions subsection)

Content, in this order:

1. **One paragraph.**
   - `POST /mcp` is MCP over Streamable HTTP.
   - It is stateless and serves protocol versions `2026-07-28`,
     `2025-11-25`, `2025-06-18` and `2025-03-26`.
   - Authentication is `Authorization: Bearer <API key>` only; cookies are
     ignored and there is no OAuth.
   - JSON responses only (no SSE).
2. **Claude Code:**
   `claude mcp add --transport http flying-mail https://mail.tacoserve.online/mcp --header "Authorization: Bearer $FLYING_MAIL_MCP_KEY"`.
3. **Codex** (`~/.codex/config.toml`):
   - a `[mcp_servers.flying-mail]` table with
     `url = "https://mail.tacoserve.online/mcp"` and
     `bearer_token_env_var = "FLYING_MAIL_MCP_KEY"`;
   - a sentence telling the reader to check the key names against the
     Codex configuration documentation for their Codex version.
4. **Generic client:**
   - the URL;
   - the header;
   - `Accept: application/json, text/event-stream`;
   - the supported versions;
   - legacy clients send `initialize`, modern clients may call
     `server/discover`.
5. **Tool table.** Columns: tool name, required capability (from design
   4.4, "Visible with"), and read-only or destructive. Exactly the 27 names.
   Note that USER_ADMIN tools appear only for USER_ADMIN keys, and that no
   tool creates users, sends invitations or logs in.
6. **Untrusted content.** Mail content arrives only in `untrusted_content`
   fields, with a fixed notice. HTML is converted to text by default, and
   bodies are capped with markers.
7. **Least-privilege key** (bullets):
   - one key per agent;
   - MAIL_READ and MAIL_MANAGE scoped to the needed domain or address;
   - MAIL_SEND only for the exact `from` addresses;
   - FILE_LINK only if large attachments are needed;
   - never KEY_ADMIN, DOMAIN_ADMIN or USER_ADMIN unless user administration
     is the purpose;
   - set `expiresAt`;
   - keep the key in kinko or an environment variable, never in a committed
     file.

   Include one example of creating such a key with the existing
   `createApiKey` GraphQL mutation (placeholders only), imitating the
   README's existing key examples.
8. **Limits.**
   - 120 requests per 60 s per key and per IP;
   - request body 7 MiB;
   - upload 5 MiB;
   - attachments up to 256 KiB inline, larger ones as single-download
     links (FILE_LINK).

### TASK-002: SKILL.md

- **Resource inventory.** Add a row:
  `Rate limit binding | MCP_RATE_LIMITER (120 requests per 60 s; /mcp answers 503 without it)`.
- **Post-deploy smoke checks.** Add an "MCP endpoint" block after the
  authenticated GraphQL check, using the existing kinko pattern with
  `--env FLYING_MAIL_API_KEY`. Three `curl` POSTs to `$B/mcp`, with
  headers `content-type: application/json`,
  `accept: application/json, text/event-stream` and
  `authorization: Bearer $FLYING_MAIL_API_KEY`:
  1. Legacy `initialize` (`protocolVersion` `2025-11-25`). Expect 200 and
     `result.protocolVersion`.
  2. Legacy `tools/list` with the header
     `mcp-protocol-version: 2025-11-25`. Expect the tool names. Pipe to
     `jq -r '.result.tools[].name'` (or a `bun -e` one-liner if `jq` is
     absent) so only names are printed.
  3. Modern `server/discover` with
     `_meta: {"io.modelcontextprotocol/protocolVersion":"2026-07-28"}` and
     the headers `mcp-protocol-version: 2026-07-28` and
     `mcp-method: server/discover`. Expect `result.supportedVersions`.
- **Negative check.** Without the authorization header, expect 401 and a
  `www-authenticate: Bearer` header. Use `curl -s -o /dev/null -D -` and
  grep the status and header lines only.
- **Rules to write into the skill:**
  - the key is referenced only as `$FLYING_MAIL_API_KEY` inside the
    `sh -c` single-quoted script;
  - never `echo` it, never pass it as a URL parameter, never enable
    `curl -v`;
  - this is a documented post-deploy procedure, run only after an
    authorized deployment.

## Pitfalls

- Inside `sh -c '...'`, the inner JSON needs double quotes escaped
  correctly. Imitate the existing GraphQL smoke line exactly.
- Do not write a real key, prefix or hash. Placeholders only.
- No emojis. Use ASCII only in new text.

## Document checks (explicit; this plan is documentation-only)

1. `grep -c "### MCP server" README.md`
   - Expected: `1`.
2. `grep -n "claude mcp add --transport http flying-mail https://mail.tacoserve.online/mcp" README.md`
   - Expected: one match.
3. `grep -n "mcp_servers.flying-mail" README.md`
   - Expected: one match.
4. For each of the 27 tool names in design 4.4,
   `grep -c "<name>" README.md`.
   - Expected: at least 1 each. Record a loop over the names; it exits 0.
5. `grep -nE "create_user|invite|login" README.md`
   - Expected: no MCP tool row matches. Existing non-MCP text may match;
     record and inspect it.
6. `grep -n "MCP_RATE_LIMITER" .agents/skills/flying-mail-deploy/SKILL.md`
   - Expected: at least 2 matches (the inventory row and the smoke-check
     note).
7. `grep -nE "/mcp" .agents/skills/flying-mail-deploy/SKILL.md`
   - Expected: at least 3 matches.
8. `grep -nE "echo .*FLYING_MAIL_API_KEY|curl -v|mcp\\?.*key=" .agents/skills/flying-mail-deploy/SKILL.md`
   - Expected: no output.
9. `grep -rnE "ybm_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}" README.md .agents/skills/flying-mail-deploy/SKILL.md`
   - Expected: no output.
10. `LC_ALL=C grep -c '[^[:print:][:space:]]' README.md .agents/skills/flying-mail-deploy/SKILL.md`
    - Expected: the count does not increase versus before the edit (record
      both values).
11. `bunx biome check README.md`
    - Not applicable; Biome does not lint Markdown. Skip and record "n/a".

## Done criteria

- [ ] TASK-001 and TASK-002 content present.
- [ ] Document checks 1-10 meet their expected results, with outputs
      recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout.
- Put evidence under `tmp/mcp-server-s316/mcp-server-04-docs/<attempt>/`.

## Progress Log

(empty)
