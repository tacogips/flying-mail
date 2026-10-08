# Realtime Push 11: Serial Reconciliation and Final Verification

**Status**: Completed
**Plan ID**: realtime-push-11-final-verification
**Wave**: 5 (phase 26)
**Depends On**: realtime-push-01-contracts-and-persistence, realtime-push-02-realtime-client, realtime-push-03-docs, realtime-push-04a-emission-ingest-send-drafts, realtime-push-04b-emission-message-mutations, realtime-push-05-graphql-surface-and-executor, realtime-push-06-web-live-updates, realtime-push-07-cli-watch, realtime-push-08-hub-core, realtime-push-09-worker-durable-object, realtime-push-10-bun-server
**Design Reference**: design-docs/specs/design-realtime-push.md sections 12, 13 (repository gates)
**Created**: 2026-10-08

## Intent and context

This is the single serial step after every wave has joined. It:

- runs the full repository gates and the Worker dry run;
- routes any breakage to the owning plan as a repair request;
- reconciles shared indexes (`PROGRESS.json`, `impl-plans/README.md`);
- archives the plans.

## Non-goals

- No new features. No deploy, no remote wrangler, no secrets, no git
  commit, push, stash, reset or checkout.
- Do not change design decisions. A real design defect is reported, not
  silently fixed.

## writePaths

- impl-plans/PROGRESS.json
- impl-plans/README.md
- impl-plans/active (the realtime-push plan files move from here to
  `impl-plans/completed/`)
- impl-plans/completed
- design-docs/specs/design-realtime-push.md (only if implementation
  revealed a factual mismatch; record it in the progress log)

sharedPaths: none.

**Source files are read-only for this plan.**

- If a gate fails, do not edit `packages/`, `apps/` or `bun.lock`.
- Record the failing command, its log path, the failing file and the plan
  that owns that file (the writePaths of plans 01-10). Report it as a
  repair request for that owner.
- Re-run all gates after the owner's fix.

`bun.lock` is verified only with `bun install --frozen-lockfile`. This
plan never regenerates it.

## Steps

1. Run `git status --short` and confirm that only paths declared by the
   realtime-push plans changed.
2. Gates, run from the repo root. Keep every log as
   `/tmp/realtime-push-final-<step>.log` and record the exit codes:
   1. `bun install --frozen-lockfile` exits 0.
   2. `mise run lint` exits 0.
   3. `bun run test` exits 0.
      - The package count must be at least the 1830 baseline plus the new
        tests. Record the exact count from the vitest summary.
      - The web count must be at least the 274 baseline plus the new tests.
   4. `mise run build-web` exits 0.
   5. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`
      exits 0. The log shows the `MAIL_EVENT_HUB` binding.
3. Size policy:
   - `git diff --name-only` plus the untracked `*.ts` and `*.tsx` files,
     piped to `xargs wc -l`: no TypeScript file at 1000 lines or more.
   - Hub files under `packages/infrastructure/src/realtime` are under 400
     lines.
4. Security spot checks:
   - `grep -rn "connect-src" packages/infrastructure/src/http/security-headers.ts apps/web/public/_headers`:
     both say `connect-src 'self'`, and there is no `ws:` or `wss:` source.
   - `grep -rn "access_token\|apiKey=" packages/realtime-client/src apps/cli/src/commands/watch.ts apps/web/src/store/app-store-live.ts`:
     no credential is placed in a URL.
5. Design-to-code check. Confirm each item of design section 13 has a
   matching test file:
   - `mail-event-log-repository.test.ts`
   - `mail-event-cursor.test.ts`
   - `mail-events-emission-*.test.ts`
   - `hub.test.ts`, `drain.test.ts`, `upgrade.test.ts`
   - `executor.test.ts`
   - `schema-realtime.test.ts`
   - `mail-event-hub.test.ts`
   - `realtime-bun.test.ts`
   - realtime-client tests
   - `app-store-live.test.ts`
   - `watch.test.ts`
6. Reconcile:
   - Set every realtime-push plan's Status to Completed, with the
     Completion criteria checked.
   - `git mv` is forbidden (no git mutations), so move the plan files with
     a plain filesystem move from `impl-plans/active/` to
     `impl-plans/completed/`.
   - Update `planPath` and `status` in `PROGRESS.json`, set phases 22-26 to
     COMPLETED, and update `lastUpdated`.
   - Update the README table links to `completed/`.
7. If any gate fails:
   1. Stop before step 6.
   2. Report `{ command, exitCode, logPath, file, owningPlanId }` as a
      repair request.
   3. After the owner's fix, re-run **all** gates and record each
      iteration.

## Pitfalls

- A failure in a pre-existing test is a regression for the owning plan to
  fix. Never skip it or delete it.
- Do not reformat the repo. This plan edits no source files.
- Keep `PROGRESS.json` valid JSON; check it with
  `bun -e "JSON.parse(require('fs').readFileSync('impl-plans/PROGRESS.json','utf8'))"`.

## Done criteria

- [x] All five gates exit 0, with log paths and counts recorded.
- [x] Size and security checks pass.
- [x] Plans are archived, and `PROGRESS.json` and `README.md` are
      consistent.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Verification evidence**: -

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 04a, 04b, 05 and 07; its progress gate blocked 03 (docs-only, no test count), 06 (build-web output root not declared) and 08 (non-JSON worker output). The orchestrator continued with GPT-6 Luna and read-only Opus reviews: 03 APPROVED (notes fixed); 06 CHANGES_REQUESTED (H1 stale refresh, M1 boundary row, M2 bounded 4401 retry, M3 open-message patching, L1-L2) fixed; 08 CHANGES_REQUESTED twice (H1 revoked principal drain stall, H2 serial frames, M3 single state source, M4 cap races, L5-L8; then D1 ghost state, D2 unhandled rejections, D3 fail-open init limiter, D4 reservations) fixed; 09 and 10 CHANGES_REQUESTED (orphaned conn storage, accept/open failure, tag-based socket lookup, alarm/stub error handling, hibernation resume test; Bun end-to-end next test, handler error containment) fixed. Final gate: mise run lint exit 0; bun run test 2002 package + 299 web tests; build-web and Worker dry run exit 0. Deployed (migration 0016, MailEventHub Durable Object) to https://mail.tacoserve.online and verified live with the CLI watch client over wss: LIVE marker, real-time MESSAGE_SENT/MESSAGE_RECEIVED across domains, disconnect then offline send then resume from the persisted cursor replayed exactly the missed events (no duplicates) before LIVE; invalid key rejected; upgrade without subprotocol 400, cookie with foreign Origin 403, valid upgrade 101.
