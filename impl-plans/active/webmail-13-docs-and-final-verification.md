# Webmail 13: API Documentation, Calendar Cleanup, Full Verification

**Status**: Ready
**planId**: webmail-13-docs-and-final-verification
**Wave**: 4 (depends on every other webmail plan: 01-12)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 10 (Branding, Calendar, API documentation), section 12 (Verification)
**Created**: 2026-10-07

## Intent and context

Acceptance requires three things:
- `design-docs/specs` and `README.md` document the full GraphQL and REST
  surface, with curl examples.
- No calendar code paths remain. Only the empty untracked directories
  `packages/adapter/src/caldav` and `packages/adapter/src/ics` are left.
- The full verification suite passes:
  - `mise run lint`
  - `bun run test` (baseline 1579 + 192 tests, now more)
  - `mise run build-web`
  - the Worker dry-run bundle

This plan runs after all code plans have landed.

## Non-goals

- No source code changes. If verification fails because of a code
  defect, record the failing command, file and test in the Progress Log
  as a blocker for the owning plan. Do not fix it here.
- Do not change operational names (`MAILCAL_*`, `_mailcal`,
  `mailcal-verification=`, `mailcal-api`, `mailcal-db`, `mailcal-mail`).
- No deploy. The only wrangler use allowed is the `--dry-run` bundle.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `design-docs/specs/design-graphql-api.md`
- `README.md`
- `packages/adapter/src/caldav` (remove the empty directory only)
- `packages/adapter/src/ics` (remove the empty directory only)
- `impl-plans/active/webmail-13-docs-and-final-verification.md` (checkboxes and Progress Log only)

**sharedPaths**: none.

## File-level changes

### design-docs/specs/design-graphql-api.md

Add a section "## Operation catalogue (2026-10-07)". It lists every Query
and Mutation field with its current argument and return signature, taken
from:
- `packages/infrastructure/src/graphql/schema.graphql.ts`
- `schema-contacts.graphql.ts`
- `schema-external-mail.graphql.ts`
- `schema-templates.graphql.ts`
- `schema-compose.graphql.ts`

Group them as:
- Mail
- Drafts
- Compose
- Tags and triage
- Events
- Rules
- File links
- Domains and mailboxes
- Users and permissions
- API keys
- Auth
- Contacts
- External mail
- Templates

Copy the signatures from the SDL files; do not retype them from memory.
Also add a REST table covering:
- `POST /api/attachments`: field `file`, 201 body, and the 413 body with
  `code`/`maxBytes`
- `GET /api/attachments/:id`: headers, `?download=1`
- `GET /files/:token`

Leave the earlier sections as historical, but mark the stale user
permission signatures as superseded (the 2026-10-07 additions section
already notes this).

### README.md

**New "## API" section** with:
- Authentication headers: `Authorization: Bearer ybm_...` and the session
  cookie.
- curl examples, all in the existing README style (`curl -sX POST https://<worker-host>/graphql -H 'content-type: application/json' -H 'authorization: Bearer $KEY' -d '{...}'`):
  - `messages` with `domainId` and `toAddress`
  - `sendMessage` with cc, bcc and html
  - `saveDraft`, then `sendDraft`, then `deleteDraft`
  - `composeFromMessage(FORWARD)`, then `sendMessage` with
    `forwardedFromMessageId` and `forwardAttachmentIds`
  - `createDomain`, `verifyDomain`, `createMailAddress`,
    `addUserMailPermission`
  - `curl -F file=@report.pdf .../api/attachments`
  - `curl -OJ .../api/attachments/<id>`
  - `createAttachmentLink`, then `GET /files/<token>`
- Use placeholder hosts and keys only. Never real secrets.

**Rewrite "## Deployed instance"** so it no longer claims the instance is
idle. Describe:
- multi-domain operation (managed domains such as `tacoserve.online` and
  `mutvar-test.online`);
- the Email Routing catch-all to the `mailcal-api` Worker.

Keep the resource names exactly as they are.

**Documentation table.** Add a row for
`design-docs/specs/design-webmail-completion.md`.

### Calendar cleanup

- `rmdir packages/adapter/src/caldav packages/adapter/src/ics`. They must
  be empty first; check with `ls -A`. If either is non-empty, do not
  delete it, and log a blocker.
- Do not remove `AttachmentKind.CALENDAR`, `sameCalendarDay` or the
  CardDAV namespace (design D11).

## Verification (repo root; run in this order; record the exit code and log path for each)

Write each command's output to `/tmp/flying-mail-verify-<name>.log` and
record the exit status.

1. `mise run lint > /tmp/flying-mail-verify-lint.log 2>&1; echo $?` -> 0.
   This runs Biome, the format check and typecheck.
2. `bun run test > /tmp/flying-mail-verify-test.log 2>&1; echo $?` -> 0.
   Record the package and web passing counts. Both must be at or above
   the baseline (1579 packages, 192 web).
3. `mise run build-web > /tmp/flying-mail-verify-build-web.log 2>&1; echo $?`
   -> 0.
4. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun > /tmp/flying-mail-verify-dryrun.log 2>&1; echo $?`
   -> 0. This is a dry run only.
5. `rg -n -i "calendar" apps packages --glob '!**/node_modules/**' --glob '!**/dist/**'`
   -> only the allowed hits remain: AttachmentKind CALENDAR,
   `sameCalendarDay`, the CardDAV namespace, migration history tests, and
   the schema no-calendar assertion.
6. `rg -n "mailcal" apps/web/src apps/web/index.html` -> only
   `data-mailcal-blocked-src` and test fixtures. There must be no
   user-visible "mailcal" branding.
7. `git diff --cached --stat` -> empty.
8. `git status --short | grep -v '^ M\|^??'` -> empty (nothing staged and
   no other states).
9. `find apps packages -name '*.ts' -o -name '*.tsx' | grep -v node_modules | xargs wc -l | awk '$1 >= 1000 && $2 != "total"'`
   -> no files listed.

## Completion criteria

- [ ] The operation catalogue and REST table are in
      `design-graphql-api.md`.
- [ ] The README has the API section with curl examples, the updated
      deployed-instance text, and the doc table row.
- [ ] The empty caldav and ics directories are removed.
- [ ] All 9 verification steps pass, with exit codes and log paths
      recorded. Any failure is logged as a blocker naming the owning plan.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
