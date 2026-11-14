# Realtime Push 03: README API Section and Deploy Skill

**Status**: Completed
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
- impl-plans/completed/realtime-push-03-docs.md (progress log only)

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

- [x] Both documents are updated with every item listed.
- [x] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: 2026-10-08
**Tasks Completed**: Updated the README API subscription section, CLI listing and examples; updated the flying-mail-deploy runbook with the binding, permanent Durable Object migration, retention setting, rollout order, WebSocket smoke procedure and pitfalls.
**Hashes**:
- README.md: `2489201966c13ae092d5de8a0a9bf3e4ccf12556f3e4abcd50f435a270f76353`
- .agents/skills/flying-mail-deploy/SKILL.md: `ed77e1c3ea445e4da0f06cc96031b42fc8ecfc1d6566456aaa1b15218ba5f605`
- This plan before progress update: `e8162b7ea0cef0788e7b9112d5727a7e20e6c16f86555b3222a7304bb6f8b01b`
**Review correction**: The README client sample handles `RESYNC_REQUIRED` in the graphql-ws error callback, clears the cursor after fetchStatus sync, refreshes credentials on 4401, stops on fatal close codes, and retries other closes with capped full jitter, resetting on LIVE. A read-only review rechecked the correction and found no remaining behavioral mismatch; referenced helper functions are illustrative application hooks.
**Verification evidence**: Final source hashes and complete logs are under `tmp/realtime-push-s306/realtime-push-03-docs/attempt-7/`. The added-line ASCII check passed with the portable Perl equivalent (exit 0); the prescribed `grep -P` check is unsupported by the system macOS grep. README term checks, deploy-skill term checks, placeholder-key scan, and `git diff --check` passed (exit 0 each). Earlier attempt logs are retained under attempts 1-6.

### Session: 2026-10-08 (verification continuation)
**Tasks Completed**: Ran the current-source realtime-client behavioral suite to exercise the reconnect, cursor resume and RESYNC behavior documented in the README. Re-ran the plan's ASCII, README term, deploy-skill term, placeholder-key and diff checks.
**Hashes**:
- README.md: `2489201966c13ae092d5de8a0a9bf3e4ccf12556f3e4abcd50f435a270f76353`
- .agents/skills/flying-mail-deploy/SKILL.md: `ed77e1c3ea445e4da0f06cc96031b42fc8ecfc1d6566456aaa1b15218ba5f605`
- Plan before this progress update: recorded in `tmp/realtime-push-s306/realtime-push-03-docs/attempt-8/pre-edit-sha256.txt`.
**Verification evidence**: `bunx vitest run packages/realtime-client` passed 3 files and 21 tests (exit 0). The five plan-specific document checks passed (exit 0 each); complete logs are under `tmp/realtime-push-s306/realtime-push-03-docs/attempt-8/`. The first logging wrapper used zsh's read-only `status` variable and failed after invoking the commands; all checks were rerun with a corrected wrapper and final exit statuses captured.

### Session: 2026-10-08 (adversarial review correction)
**Finding addressed**: RP03-ADV-01. Replaced the post-deploy watch command with the kinko `--path` / `--env` injection pattern and an explicit `--endpoint https://mail.tacoserve.online`; no key value is assigned or exposed. README.md was not edited.
**Hashes**:
- README.md: `2489201966c13ae092d5de8a0a9bf3e4ccf12556f3e4abcd50f435a270f76353` (unchanged)
- .agents/skills/flying-mail-deploy/SKILL.md: `11a94ae0945b56518ef752ba9eb92f84578ba3248e4c1d9098ad09731d25c6dd`
- This plan before progress update: recorded in `tmp/realtime-push-s306/realtime-push-03-docs/attempt-9/pre-plan-edit-sha256.txt`; final hashes recorded in `attempt-9/final-sha256.txt`.
**Verification evidence**: All seven finding-specific and plan checks passed with exit status 0. Complete logs are under `tmp/realtime-push-s306/realtime-push-03-docs/attempt-9/`. No deployment or live smoke check was run.

### Session: 2026-10-08 (current-source verification)
**Tasks Completed**: Re-read the assigned documentation and design tables; confirmed the README includes endpoint/auth, SDL, self-managed graphql-ws resubscription, CLI watch JSON, replay/resync semantics, heartbeat, close codes, limits, and client-serve Offline behavior. Confirmed the deployment skill documents the binding, permanent migration, retention range, rollout order, smoke procedure, and pitfalls.
**Hashes before this progress update**: README.md `2489201966c13ae092d5de8a0a9bf3e4ccf12556f3e4abcd50f435a270f76353`; deployment skill `11a94ae0945b56518ef752ba9eb92f84578ba3248e4c1d9098ad09731d25c6dd`; plan hash is in `tmp/realtime-push-s306/realtime-push-03-docs/attempt-10/pre-edit-sha256.txt`.
**Verification evidence**: Current-source added-line ASCII, required-term, key-pattern, and `git diff --check` commands all exited 0. Complete command logs and exit statuses are under `tmp/realtime-push-s306/realtime-push-03-docs/attempt-10/`. No deployment or live smoke check was run.

### Session: 2026-10-08 (Opus review notes)
**Findings addressed**: 03-N1 now invokes the CLI smoke command as `bun run --cwd apps/cli start -- watch` while retaining the kinko environment wrapper, endpoint and JSON options. 03-N2 now identifies `FLYING_MAIL_API_KEY` as the admin operator key used by the smoke check and describes a separate read-only key as optional.
**Verification evidence**: The deploy skill's smoke command and key wording were inspected in place. No deployment or live smoke check was run.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
