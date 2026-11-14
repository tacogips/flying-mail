# MCP Server 12: Serial Reconciliation and Final Verification

**Status**: Not Started
**Plan ID**: mcp-server-12-final-verification
**Wave**: 4 (phase 33)
**Depends On**: mcp-server-01-application-usecases, mcp-server-02-content-shaping, mcp-server-03-protocol-core, mcp-server-04-docs, mcp-server-05-read-tools, mcp-server-06-compose-tools, mcp-server-07-attachment-tools, mcp-server-08-manage-tools, mcp-server-09-user-admin-tools, mcp-server-10-transport-wiring, mcp-server-11-catalogue-integration
**Design Reference**: design-docs/specs/design-mcp-server.md sections 8, 9, 10, 11
**Created**: 2026-10-08

## Intent and context

This is the single serial step after waves 1-3 have joined. It:

- runs every repository gate and the Worker dry run;
- checks size, security and design-to-test mapping;
- routes failures to the owning plan;
- reconciles `impl-plans/PROGRESS.json` and `impl-plans/README.md`;
- archives the plans to `impl-plans/completed/`.

## Non-goals

- No feature work.
- No source edits: `packages/`, `apps/*/src`, `apps/api/wrangler.toml`,
  `README.md`, the skill and `bun.lock` are read-only here.
- No deploy, no remote wrangler (dry run only), no secrets, no DNS.
- No git commit, push, stash, reset or checkout.
- Do not change design decisions. A factual design mismatch is recorded and
  reported.

## writePaths

- impl-plans/PROGRESS.json
- impl-plans/README.md
- impl-plans/active
- impl-plans/completed
- design-docs/specs/design-mcp-server.md (only for a factual mismatch revealed by implementation; record it in the Progress Log)
- apps/web/dist (artifact root: `mise run build-web` output)
- apps/api/.wrangler (artifact root: wrangler local state from the dry run; gitignored)

artifactRoots: apps/web/dist, apps/api/.wrangler

sharedPaths: none.

## Steps

### 1. Drift check

Run `git status --short`. Every changed or untracked path must be:

- declared in the writePaths of plans 01-11; or
- one of the design-step files: `design-docs/specs/design-mcp-server.md`,
  `architecture.md`, `design-security-model.md`,
  `design-api-keys-and-permissions.md`, `design-deployment.md`,
  `design-docs/references/README.md`, `design-docs/user-qa/README.md`,
  `design-docs/user-qa/pending-mcp-server.md`; or
- an `impl-plans/` file.

List any other path as drift.

### 2. Gates

Run each from the repo root. Save each log as
`/tmp/mcp-server-final-<n>.log` and record its exit code.

1. `bun install --frozen-lockfile`
   - Expected: exit 0, with no `bun.lock` change.
2. `mise run lint`
   - Expected: exit 0 (Biome, format check and typecheck).
3. `bun run test`
   - Expected: exit 0.
   - Record the package and web test counts from the vitest summaries.
     Package tests must be at least 2055 plus the new tests. Web tests must
     be at least 302.
4. `mise run build-web`
   - Expected: exit 0, and `apps/web/dist/index.html` exists.
5. `bun run --cwd apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`
   - Expected: exit 0.
   - Record the bundle size line. Confirm `parse5` bundled without Node
     built-in errors.

### 3. Size policy

```
{ git diff --name-only; git ls-files --others --exclude-standard; } | grep -E '\.(ts|tsx)$' | xargs wc -l
```

Expected: no file at 1000 lines or more.

### 4. Security spot checks (record outputs)

- `grep -n 'app.all("/mcp"' packages/infrastructure/src/http/app.ts` and
  `grep -n 'createAuthMiddleware(' packages/infrastructure/src/http/app.ts`.
  The `/mcp` line number must be lower than the auth-middleware `use` line.
- `grep -rn "resolveViewerFromToken\b" packages/infrastructure/src/mcp`
  -> no output (only `resolveApiKeyViewerFromToken` is used).
- `grep -rn "deleteMessages\|createUser\|resendInvitation\|requestEmailAuth\|verifyEmailAuthToken" packages/infrastructure/src/mcp --include='*.ts' | grep -v '\.test\.ts'`
  -> no output.
- `grep -rn "fetch(" packages/infrastructure/src/mcp --include='*.ts' | grep -v '\.test\.ts'`
  -> no output.
- `grep -n '"parse5": "8.0.1"' packages/infrastructure/package.json`
  -> one match.
- `git diff --quiet -- apps/api/migrations`
  -> exit 0, and `ls apps/api/migrations | grep -c 0018` -> 0. No
  migration was added or edited.
- `grep -rnE "ybm_[0-9a-f]{12}_[A-Za-z0-9_-]{20,}" README.md .agents apps packages --include='*.md' --include='*.ts'`
  -> each match is inspected. Only test fixtures may match, and none may be
  a real key.

### 5. Design-to-test mapping

Confirm that each of these exists and passed in gate 3:

- `auth.test.ts` (`resolveApiKeyViewerFromToken`)
- `trash.test.ts`
- `attachment-uploads.test.ts`
- `authorization.test.ts` (`viewerHoldsCapability`)
- `tool-schema.test.ts`
- `errors.test.ts`
- `audit.test.ts`
- `protocol.test.ts`
- `html-text.test.ts`
- `html-sanitize.test.ts`
- `result-shaping.test.ts`
- `read-tools.test.ts`
- `compose-tools.test.ts`
- `attachment-tools.test.ts`
- `manage-tools.test.ts`
- `user-admin-tools.test.ts`
- `http-handler.test.ts`
- `worker-mcp.test.ts`
- `server-mcp.test.ts`
- `catalogue.test.ts`
- `e2e.test.ts`
- the plan 04 document-check outputs

### 6. Failure routing

On any failure:

1. Record the command, exit code, log path, failing file and owning plan
   (by writePaths).
2. Issue a repair request to that owner.
3. After the fix, re-run **all** gates in step 2.

### 7. Reconcile

1. In `impl-plans/PROGRESS.json`, set every `mcp-server-*` plan and task
   to `Completed`, set phases 30-33 to `COMPLETED`, change the `planPath`
   values to `impl-plans/completed/...`, and update `lastUpdated`.
2. Move `impl-plans/active/mcp-server-*.md` to `impl-plans/completed/`, and
   update the links in the `impl-plans/README.md` MCP table.
3. `jq empty impl-plans/PROGRESS.json`
   - Expected: exit 0.

## Done criteria

- [ ] All gates in step 2 exit 0, with logs and test counts recorded.
- [ ] Steps 3-5 have no violations.
- [ ] PROGRESS.json and README reconciled, JSON valid, plans archived.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge; never overwrite blindly.
- No git commit, push, stash, reset or checkout.
- Put evidence under `tmp/mcp-server-s316/mcp-server-12-final-verification/<attempt>/`.

## Progress Log

(empty)
