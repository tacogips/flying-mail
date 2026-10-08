# User Admin 06: README API and CLI documentation

**Status**: Ready
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
- impl-plans/active/user-admin-06-readme-docs.md (progress log only)

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

- [ ] TASK-001 to TASK-004 are complete.
- [ ] Document checks 1-10 pass, with outputs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.

## Progress Log

(empty)
