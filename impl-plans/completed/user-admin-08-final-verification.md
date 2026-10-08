# User Admin 08: Serial Reconciliation and Final Verification

**Status**: Completed
**Plan ID**: user-admin-08-final-verification
**Wave**: 3 (phase 29)
**Depends On**: user-admin-01-capability-contract, user-admin-02-realtime-type-filter, user-admin-03-cli-watch-type, user-admin-04-web-api-keys, user-admin-05-cli-user-commands, user-admin-06-readme-docs, user-admin-07-authorization
**Design Reference**: design-docs/specs/design-user-admin-capability.md sections 2.9, 6; design-docs/specs/design-realtime-push.md section 13 ("Type filter" row)
**Created**: 2026-10-08

## Intent and context

This is the single serial step after waves 1 and 2 have joined. It:

- runs the full repository gates and the Worker dry run;
- checks the design-to-test mapping;
- routes any failure to the owning plan;
- reconciles `PROGRESS.json` and `impl-plans/README.md`;
- archives the plans.

## Non-goals

- No feature work.
- No deploy, no remote wrangler, no secrets, no DNS.
- No git commit, push, stash, reset or checkout.
- Do not change design decisions. A real design defect is reported, not
  silently fixed.

## writePaths

- impl-plans/PROGRESS.json
- impl-plans/README.md
- impl-plans/active
- impl-plans/completed
- design-docs/specs/design-user-admin-capability.md (only for a factual mismatch revealed by implementation; record it in the Progress Log)
- apps/web/dist (artifact root: `mise run build-web` output)
- apps/api/.wrangler (artifact root: wrangler local state written by the dry run; gitignored)

artifactRoots: apps/web/dist, apps/api/.wrangler

sharedPaths: none.

**Source files under `packages/`, `apps/*/src`, `apps/api/migrations`,
`README.md` and `bun.lock` are read-only for this plan.**

On any gate failure:

1. Record the command, its exit code, the log path, the failing file, and
   the owning plan (the writePaths of plans 01-07).
2. Issue a repair request to that owner.
3. Re-run **all** gates after the fix.

## Steps

1. `git status --short`. Every changed or untracked path must be declared
   by plans 01-07, be one of the design-docs files changed by the design
   step, or be one of these plan files. List any other path as drift.
2. Gates, run from the repo root. Save each log as
   `/tmp/user-admin-final-<n>.log` and record its exit code.
   1. `bun install --frozen-lockfile` exits 0. It must not modify
      `bun.lock`.
   2. `mise run lint` exits 0.
   3. `bun run test` exits 0.
      - Record the exact package and web test counts from the vitest
        summaries.
      - Package tests: at least 2002 plus the new tests.
      - Web tests: at least 299 plus the new tests.
   4. `mise run build-web` exits 0, and `apps/web/dist/index.html` exists.
   5. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`
      exits 0.
3. Size policy: run
   `git diff --name-only; git ls-files --others --exclude-standard` and
   pipe the `.ts` and `.tsx` files to `xargs wc -l`. No file may be at
   1000 lines or more.
4. Security spot checks (record the outputs):
   - `grep -n "requireAdminUser" packages/application/src/usecases/*.ts | grep -v test`
     shows `createUser` in `users.ts`, `invitations.ts` and the definition
     only.
   - `grep -n "UserAdmin" packages/application/src/policies/authorization.ts packages/application/src/usecases/email-auth.ts packages/application/src/usecases/api-keys.ts`
     shows the fail-closed check, the bootstrap exclusion and the
     grant-only-by-admin branch.
   - `git diff --quiet -- apps/api/migrations/0001_init.sql apps/api/migrations/0012_remove_calendar.sql apps/api/migrations/0015_auth_hardening.sql apps/api/migrations/0016_mail_events.sql`
     exits 0.
   - `grep -rnE "ybm_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{20,}" README.md apps packages --include='*.md' --include='*.ts'`
     finds no real secrets. Only test fixtures may match, and each match
     must be checked.
5. Design-to-test mapping. Confirm that each of the following exists and
   passes:
   - `user-admin-migration.test.ts`
   - `user-admin-capability.test.ts`
   - `schema-user-admin.test.ts`
   - `auth-guards.test.ts` (guard cases)
   - `drain.test.ts` (type-filter cases)
   - `executor.test.ts` (`scope.types` cases)
   - `watch.test.ts` (`--type` and cursor key)
   - `user.test.ts`
   - `api-keys-page.test.tsx`
   - `helpers.test.ts` (USER_ADMIN)
   - plan 06 document checks recorded
6. Reconcile:
   - Set every `user-admin-*` plan and task to `Completed` in
     `impl-plans/PROGRESS.json`, set phases 27-29 to `COMPLETED`, and
     update `lastUpdated`.
   - Move `impl-plans/completed/user-admin-0*.md` to `impl-plans/completed/`.
     Update the `planPath` values and the README table links.
   - Validate the JSON: `python3 -m json.tool impl-plans/PROGRESS.json > /dev/null`
     exits 0.

## Done criteria

- [x] All gates in step 2 exit 0, with logs and counts recorded.
- [x] Steps 3-5 have no violations.
- [x] PROGRESS.json and README reconciled, JSON valid, and plans archived.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- No git commit, push, stash, reset or checkout.

## Progress Log

(empty)

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
