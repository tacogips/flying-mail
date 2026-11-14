# User Admin 06: README API and CLI documentation

**Status**: Completed
**Plan ID**: user-admin-06-readme-docs
**Wave**: 1 (phase 27)
**Depends On**: none (the design documents are already updated and accepted)
**Design Reference**: design-docs/specs/design-user-admin-capability.md sections 2.2, 2.5, 2.8, 3, 4; design-docs/specs/design-realtime-push.md 5.2, 10.4; design-docs/specs/command.md "user", "watch"
**Created**: 2026-10-08
**Verification type**: documentation-only (document checks below; no test count)

## Intent and context

Operators and agents read `README.md`. It must describe:

- the `USER_ADMIN` capability: what it allows and refuses, who can grant
  it, and that it lapses when its creator is no longer an active ADMIN;
- the `flying-mail user` commands;
- `MailEventScope.types` and `flying-mail watch --type`.

The design documents in `design-docs/specs/` were already updated in the
design step. This plan edits only `README.md`.

## Non-goals

- Do not edit `design-docs/` (already updated) or
  `.agents/skills/flying-mail-deploy/SKILL.md`. Design section 4 decides
  that no operator step changes: migration 0017 is applied by the existing
  "apply pending remote D1 migrations" step.
- No code.
- No real hostnames, keys or secrets. Use the placeholders that are
  already in the README (`<worker-host>`, `$KEY`, `<user-id>`).

## writePaths

- README.md
- impl-plans/completed/user-admin-06-readme-docs.md (progress log only)

sharedPaths: none.

## File-level changes (all in `README.md`)

### TASK-001: API section (after the "grant a user mailbox permission" example, before attachments)

Add a short subsection, "User administration by API key". Its content:

- `USER_ADMIN` authorizes `users`, `user(id)`, `setUserRole`,
  `setUserActive`, and `add`/`removeUserMailPermission` and
  `add`/`removeUserTemplatePermission`.
- It never authorizes `createUser` or `resendInvitation`; invitations stay
  in the web UI.
- Only a signed-in admin can grant it, in Settings > API keys. No API key
  can grant it, including `KEY_ADMIN` keys. The bootstrap key does not
  hold it.
- It works only while the admin who created the key exists, is active and
  is an ADMIN. Otherwise those operations return `FORBIDDEN`. The key's
  other scopes keep working.
- The last active admin cannot be demoted or deactivated (`CONFLICT`).
  Rules created through the key record the creating admin.
- One curl example in the existing style: `setUserRole(id: "<user-id>",
  role: MEMBER) { id role }` with `Bearer $KEY`.

### TASK-002: Subscriptions section

- Change the SDL line (README line ~190) to
  `input MailEventScope { domainId: ID, address: String, types: [MailEventType!] }`.
- Add 2-4 sentences:
  - `types` filters on the server.
  - Omitted means all types.
  - An empty list or `LIVE` is `BAD_USER_INPUT`.
  - `LIVE` is always delivered.
  - Cursors stay gap-free, because filtered rows still advance the cursor.
- Next to the `flying-mail watch` example (line ~272), add
  `flying-mail watch --type received,sent --json`. Then add one sentence:
  `--type` accepts `received`, `sent`, `updated`, `deleted`,
  `draft-saved`, `draft-deleted`, and the cursor is stored separately for
  each type filter.

### TASK-003: CLI user commands

- In "Agent quick start", or in a new short "User administration from the
  CLI" block after it, list:
  - `flying-mail user list --json`
  - `flying-mail user show <email|id>`
  - `flying-mail user set-role <user> MEMBER`
  - `flying-mail user deactivate <user>`
  - `flying-mail user rule add <user> --effect ALLOW --domain example.com --pattern support@example.com`
  - `flying-mail user template-rule add <user> --capability TEMPLATE_READ --effect ALLOW`
- Add one sentence on exit code 4 with the `USER_ADMIN` hint, and one
  noting that `create` and `invite` are web-only.

### TASK-004: Documentation table

- Add the row
  `| design-docs/specs/design-user-admin-capability.md | USER_ADMIN capability and event-type filter |`.
- Add the missing row for `design-docs/specs/design-realtime-push.md` only
  if it is absent. It is currently absent; add it with "Real-time push and
  subscriptions".

## Document checks (explicit; this plan has no automated tests)

Run from the repo root and record the outputs in the Progress Log:

1. `grep -c "USER_ADMIN" README.md` reports at least 3.
2. `grep -n "types: \[MailEventType!\]" README.md` finds one match.
3. `grep -n "watch --type" README.md` finds at least one match.
4. `grep -n "flying-mail user " README.md` finds at least five matches.
5. `grep -n "design-user-admin-capability.md" README.md` finds one match.
6. `grep -nE "createUser|resendInvitation" README.md` shows that they are
   described as web or session only.
7. `grep -nE "ybm_[A-Za-z0-9]{6,}" README.md` finds no real key material.
   This is a secret hygiene check.
8. `grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" README.md` finds no
   match (no emojis).
9. `bunx biome check README.md` exits 0, or reports that the file is
   ignored. Record which.
10. `git diff --stat -- README.md` shows only README.md for this plan.

## Done criteria

- [x] TASK-001 to TASK-004 are complete.
- [x] Document checks 1-10 pass, with outputs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.

## Progress Log

### Session: 2026-10-08 (Step 6 implementation)

**Tasks Completed**: TASK-001, TASK-002, TASK-003, TASK-004.

**Notes**: Updated `README.md` with USER_ADMIN scope, grant and creator-liveness rules, bootstrap exclusion, last-admin CONFLICT and a placeholder curl example; documented subscription `types` semantics and `watch --type`; listed user CLI commands and web-only create/invite behavior; added design references. README before SHA-256: `2489201966c13ae092d5de8a0a9bf3e4ccf12556f3e4abcd50f435a270f76353`; final SHA-256: `59133a3e6708f709135de36bdabc577d7e3ff2d6db1c84cc880d47b5c3da1514`. The bootstrap section now states that the bootstrap key excludes `USER_ADMIN`.

**Verification**: Checks 1-7 and 10 exited 0. Check 8's prescribed `grep -P` is unsupported by the macOS grep on this host; the equivalent Python Unicode codepoint scan exited 0 and found no emoji. Check 9 ran `bunx biome check README.md`, exited 1 and reported that README.md is ignored with no files processed; this is an allowed plan outcome. Complete outputs and command statuses: `tmp/user-admin-s310/user-admin-06-readme-docs/attempt-04/document-checks.log` (final-source rerun). An initial attempt-01 logging wrapper failed before running checks because zsh reserves `status`; attempt-02 captured the platform limitations and is retained separately.

**Remaining**: Formal review and workflow finalization are downstream steps.

### Session: 2026-10-08 (Step 6 final-source verification)

**Tasks Completed**: TASK-001 through TASK-004; document checks 1-10.

**Verification**: Fresh checks against the unchanged final README passed checks 1-7 and 10; the Python Unicode scan passed the no-emoji check. The prescribed macOS `grep -P` command exited 2 because this grep does not support `-P`. `bunx biome check README.md` exited 1 after reporting that README.md is ignored and zero files were processed, an allowed documentation-plan outcome. Complete command output and each exit status: `/tmp/user-admin-06-step6-document-checks.log`. README SHA-256 remained `59133a3e6708f709135de36bdabc577d7e3ff2d6db1c84cc880d47b5c3da1514`.

**Remaining**: Independent review and workflow finalization are downstream steps.

### Session: 2026-10-08 (Step 6 attempt-07 current-source verification)

**Tasks Completed**: Re-verified TASK-001 through TASK-004 and document checks 1-10 against the current `README.md`.

**Verification**: Checks 1-7 and 10 exited 0: 9 `USER_ADMIN` matches; the SDL declaration at README.md:213; `watch --type` at README.md:302; 9 user-command matches; the design reference at README.md:444; web-only create/invite descriptions; no key-pattern match; and README-only diff stat (61 insertions, 4 deletions). The prescribed emoji `grep -P` exited 2 because host grep lacks `-P`; the portable Python Unicode scan exited 0 and found no emoji. `bunx biome check README.md` exited 1 after reporting that README.md is ignored and zero files were processed, the allowed documentation-only outcome. Complete output and exit statuses: `tmp/user-admin-s310/user-admin-06-readme-docs/attempt-07/document-checks.log`. Current README SHA-256: `59133a3e6708f709135de36bdabc577d7e3ff2d6db1c84cc880d47b5c3da1514`.

**Remaining**: Independent review and workflow finalization are downstream steps.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
