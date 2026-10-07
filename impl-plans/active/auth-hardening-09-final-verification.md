# Auth Hardening 09: Serial Reconciliation and Final Verification

**Status**: Ready
**Plan ID**: auth-hardening-09-final-verification
**Wave**: 5 (phase 21), serial
**Depends On**: auth-hardening-01-contracts-and-persistence, auth-hardening-02-web-client, auth-hardening-03-cli-bootstrap, auth-hardening-04-docs, auth-hardening-05-auth-usecases, auth-hardening-06-adapters, auth-hardening-07-graphql-http, auth-hardening-08-composition-and-worker
**Design Reference**: design-docs/specs/design-security-model.md section 9
**Created**: 2026-10-07

## Intent and context

This plan runs after every other auth-hardening plan has finished. It
proves that the integrated tree meets the acceptance criteria, then
reconciles the shared plan indexes. It is the only plan that edits
`impl-plans/PROGRESS.json` statuses and `impl-plans/README.md` after
creation, and the only plan that moves plan files to `completed/`.

## Non-goals

- No feature work.
- If a gate fails, do **not** patch source owned by another plan. Record
  the failure, the owning plan ID (from the ownership map below) and the
  full log path, and stop with status `Blocked`. The review loop returns the
  fix to the owner.
- Exception: a pure formatting diff that Biome reports in a touched file
  may be fixed with `biome format --write <that file>`. Record it.
- No git operations.

## writePaths

- impl-plans/PROGRESS.json
- impl-plans/README.md
- impl-plans/active
- impl-plans/completed
- apps/web/dist (build artifact root from `mise run build-web`)
- apps/api/.wrangler (dry-run cache artifact root)

sharedPaths: none.

## Ownership map (for routing failures)

| Area | Owner |
|------|-------|
| domain entities, application ports/errors/dependencies/fakes, adapter auth repository, migration 0015, context/app clientIp | 01 |
| apps/web | 02 |
| apps/cli, mise.toml | 03 |
| README, skill, design-deployment table | 04 |
| application use cases (email-auth, invitations, users, auth-guards, usecases.ts) | 05 |
| adapter turnstile and rate-limit | 06 |
| infrastructure graphql and http | 07 |
| infrastructure composition, apps/api src, wrangler.toml | 08 |

## Steps and evidence

Write every log to `/tmp/flying-mail-auth-hardening/` and record each exit
code.

1. `mise run lint > /tmp/flying-mail-auth-hardening/lint.log 2>&1` must
   exit 0. This covers biome, the format check and typecheck in every
   workspace.
2. `bun run test > /tmp/flying-mail-auth-hardening/test.log 2>&1` must exit
   0. Extract the vitest summaries:
   - the package suite must have at least 1720 passing tests, plus new ones
   - the web suite must have at least 264, plus new ones
   Record both numbers.
3. `mise run build-web > /tmp/flying-mail-auth-hardening/build-web.log 2>&1`
   must exit 0.
4. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun > /tmp/flying-mail-auth-hardening/dryrun.log 2>&1`
   must exit 0, and the log must mention `AUTH_RATE_LIMITER`.
5. `rg -n -i signup packages apps README.md mise.toml .agents` must print
   nothing.
6. Every TypeScript/TSX file changed in this feature must have fewer than
   1000 lines (`git diff --name-only` plus untracked files, through
   `wc -l`; read-only git use only).
7. `rg -n "https://challenges.cloudflare.com" packages/infrastructure/src/http/security-headers.ts apps/web/public/_headers`
   must show both files, and the security-headers test from plan 07 must be
   in the test log.
8. `git status --porcelain -- apps/api/migrations` (read-only) must print
   exactly one line: `?? apps/api/migrations/0015_auth_hardening.sql`.
   Under the no-commit constraint, that single line proves:
   - no tracked migration (0001-0014) was modified or deleted
   - only 0015 was added

   Do not use `git diff` here, because it never lists untracked files.
   Record the output verbatim in the progress log.
9. If every step passes:
   - Set all nine plans and phases 17-21 to `Completed` in `PROGRESS.json`,
     and update `lastUpdated`.
   - Move the nine plan files from `impl-plans/active/` to
     `impl-plans/completed/` and update their `planPath` values.
   - Update the auth-hardening table in `impl-plans/README.md` to link to
     `completed/`.
   - Remove `impl-plans/active/` if it is empty.

## Done criteria

- [ ] Steps 1-8 pass, with exit codes and log paths recorded below.
- [ ] `PROGRESS.json` and `README.md` are in sync with the plan files.

## Progress Log

### Session: (not started)
**Gate results**: -
**Blocked on**: -
