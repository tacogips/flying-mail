# Realtime Push 03: README API Section and Deploy Skill

**Status**: Ready
**Plan ID**: realtime-push-03-docs
**Wave**: 1 (phase 22)
**Depends On**: none
**Design Reference**: design-docs/specs/design-realtime-push.md sections 5, 6.5-6.7, 7.1, 9, 10.4
**Created**: 2026-10-08

## Intent and context

Acceptance requires two documentation updates:

- The README API section documents subscriptions, with a `graphql-ws`
  client example.
- The flying-mail-deploy skill documents the Durable Object binding and
  migration, plus a post-deploy WebSocket smoke check.

Everything needed is fixed by the accepted design, so this plan can run in
wave 1.

## Non-goals

- No edits to `design-docs/` (already accepted), source code, `wrangler.toml`
  or the `cloudflare-mail-setup` skill.
- No secrets, tokens or real key values in examples. Use placeholders such
  as `ybm_xxx`.

## writePaths

- README.md
- .agents/skills/flying-mail-deploy/SKILL.md
- impl-plans/active/realtime-push-03-docs.md (progress log only)

sharedPaths: none.

Note: `.codex/skills/` holds symlinks to the same skill file. Do not touch
them.

## Changes

### README.md, under `## API` (README.md:93)

Add a `### Subscriptions (real-time push)` subsection. Content, in order:

1. **Endpoint and authentication.**
   - `wss://<host>/graphql`, subprotocol `graphql-transport-ws`.
   - Browser: the session cookie, same origin only.
   - API keys: `connection_init` payload
     `{ "authorization": "Bearer ybm_..." }`.
   - Never put a key in the URL.
2. **The operation.** The SDL of `Subscription.mailEvents(scope, after)` and
   `MailEvent`, with the event types including `LIVE`, copied from design
   5.1.
3. **A `graphql-ws` client example** (TypeScript, about 20 lines):
   - `createClient({ url, connectionParams: { authorization: "Bearer " + key }, keepAlive: 25_000, retryAttempts: 0 })`
   - subscribe with `{ scope: { address }, after: storedCursor }`
   - store `cursor` from each event
   - on `RESYNC_REQUIRED`, run the fetchStatus sync and resubscribe without
     `after`

   State that the stock client's own retry would resend the stale `after`.
   So the example resubscribes itself with the latest cursor, or uses
   `flying-mail watch`.
4. **A curl-free example:** `flying-mail watch --address support@example.com --json`
   with two sample NDJSON lines (a LIVE line and a MESSAGE_RECEIVED line).
5. **Semantics.**
   - Replay, then live.
   - Gap-free and duplicate-free by cursor.
   - The cursor is opaque `<epoch>.<seq>`.
   - Retention is 7 days by default (`FLYING_MAIL_EVENT_RETENTION_SECONDS`).
   - `RESYNC_REQUIRED` handling: web does a full refresh; API clients do a
     `fetchStatus` sync.
6. **Heartbeat.** Clients must ping at least every 25 s. The idle close is
   at 75 s with code 4000.
7. **Close-code table** (copy design 6.6) and **limits table** (copy design
   6.7).
8. One line: `flying-mail client serve` does not proxy WebSockets, so the
   web client shows Offline there.

Also add a `flying-mail watch` line wherever the README lists CLI commands.
Check with `grep -n "mail fetch" README.md`.

### `.agents/skills/flying-mail-deploy/SKILL.md`

- **Bindings and configuration**
  - The `MAIL_EVENT_HUB` Durable Object binding, the class `MailEventHub`,
    and the `[[migrations]]` tag `v1-mail-event-hub` with
    `new_sqlite_classes`.
  - The tag and class name are permanent.
  - Never remove the binding in a rollback. Only a `deleted_classes`
    migration removes it.
- **Optional var:** `FLYING_MAIL_EVENT_RETENTION_SECONDS`, range
  `[3600, 2592000]`.
- **Rollout order** (design 9.4)
  - D1 migration 0016 through `mise run cf-deploy`, which applies
    migrations first.
  - Then the deploy, which applies the DO migration.
- **Post-deploy smoke check**
  - `kinko exec -- env FLYING_MAIL_API_KEY=... flying-mail watch --json`.
    Put the variable names only, never values.
  - Expect a `LIVE` line.
  - Send a test mail to a managed address.
  - Expect a `MESSAGE_RECEIVED` line within seconds.
  - Check that the browser connection indicator shows Live.
- **Pitfalls**
  - Deploys disconnect all sockets; clients reconnect with jitter.
  - Upgrades succeed only on the custom domain.
  - A 403 on upgrade means an Origin mismatch, so check
    `FLYING_MAIL_PUBLIC_ORIGIN`.
- **Dry-run gate:**
  `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`
  must succeed with the DO binding.

Keep the skill's existing structure and headings. Add to the relevant
sections and do not rewrite unrelated content.

## Pitfalls

- Do not use emojis or non-ASCII characters.
- Do not claim that a live deployment has been done.
- Close codes, limits and variable names must match the design exactly.
  Copy them; do not paraphrase the numbers.

## Verification (repo root)

1. `git diff README.md .agents/skills/flying-mail-deploy/SKILL.md | LC_ALL=C grep -nP '^\+.*[^\x00-\x7F]'`
   prints nothing (grep exit 1): the added lines contain no non-ASCII
   characters.
2. `grep -n "graphql-transport-ws\|RESYNC_REQUIRED\|keepAlive\|flying-mail watch" README.md`
   shows each term.
3. `grep -n "MAIL_EVENT_HUB\|v1-mail-event-hub\|new_sqlite_classes\|LIVE" .agents/skills/flying-mail-deploy/SKILL.md`
   shows each term.
4. `grep -nE "ybm_[A-Za-z0-9]{8,}" README.md .agents/skills/flying-mail-deploy/SKILL.md`
   shows no real-looking key.

## Done criteria

- [ ] Both documents are updated with every item listed.
- [ ] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
