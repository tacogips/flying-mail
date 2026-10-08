# User Admin 04: Settings > API keys can grant USER_ADMIN

**Status**: Ready
**Plan ID**: user-admin-04-web-api-keys
**Wave**: 1 (phase 27)
**Depends On**: none (the web has its own schema mirror; the server value arrives with plan 01)
**Design Reference**: design-docs/specs/design-user-admin-capability.md section 2.7; design-docs/user-qa/pending-user-admin.md U2
**Created**: 2026-10-08

## Intent and context

An admin session in Settings > API keys can pick `USER_ADMIN`. The page
then shows a clear description, and the scope renders as instance-wide.
Settings > Users is unchanged and keeps working.

Current code:

- `apps/web/src/api/schema-types.ts:Capability` (line 38) is a string
  union of 12 values.
- `apps/web/src/lib/scope-format.ts`:
  - `CAPABILITY_LABELS` is a `Record<Capability, string>`, so it is
    exhaustive.
  - The web `GLOBAL_CAPABILITIES` list is
    `["DOMAIN_ADMIN","KEY_ADMIN"]`.
  - `isGlobalCapability` and `formatScope` are defined here.
- `apps/web/src/pages/settings/api-keys-page.tsx`:
  - `ALL_CAPABILITIES = Object.keys(CAPABILITY_LABELS)`, so a new label
    appears in the picker automatically.
  - The scope row is at lines ~178-215. The domain and address inputs are
    hidden by `<Show when={!isGlobalCapability(row.capability)}>`.
- Test patterns to imitate:
  - `apps/web/src/lib/helpers.test.ts` (`formatScope` cases near line 268).
  - `apps/web/src/pages/settings/domains-page.test.tsx` (render with
    `StoreProvider`, stubbed `fetch`, toasts).

## Non-goals

- No confirmation dialog (U2 default).
- Do not add `TEMPLATE_*` to the web `GLOBAL_CAPABILITIES`. That is
  pre-existing drift and out of scope.
- No change to Settings > Users files, `documents.ts`,
  `realtime-documents.ts` or the store.
- Do not run `mise run build-web` in this plan. Plan 08 does that and owns
  the `apps/web/dist` artifact root.

## writePaths

- apps/web/src/api/schema-types.ts
- apps/web/src/lib/scope-format.ts
- apps/web/src/lib/helpers.test.ts
- apps/web/src/pages/settings/api-keys-page.tsx
- apps/web/src/pages/settings/api-keys-page.test.tsx (new)
- impl-plans/active/user-admin-04-web-api-keys.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: Types and formatting

- `schema-types.ts`: append `| "USER_ADMIN"` to `Capability`.
- `scope-format.ts`:
  - Add the label `USER_ADMIN: "Administer users (roles, activation, permission rules)"`.
  - Append `"USER_ADMIN"` to the web `GLOBAL_CAPABILITIES`.
  - Export a new constant, `USER_ADMIN_DESCRIPTION`, with exactly this
    text: "Lets this key list users, change roles, activate or deactivate
    users and edit their mail and template rules. It cannot create or
    invite users. It works only while you remain an active admin."
- `grep -rn "Capability" apps/web/src --include='*.ts' --include='*.tsx'`
  looks for other exhaustive switches or records over `Capability`. If the
  compiler flags one outside writePaths, record it in the Progress Log and
  stop; do not edit outside writePaths. Only `CAPABILITY_LABELS` is
  expected.

### TASK-002: Picker description (`api-keys-page.tsx`)

- Inside each scope row, add
  `<Show when={row.capability === "USER_ADMIN"}>` rendering
  `<p class="muted">{USER_ADMIN_DESCRIPTION}</p>`. Place it after the
  capability select. Use the existing `muted` class, and do not add CSS.
- Switching a row to `USER_ADMIN` must submit with `domainId: null` and
  `addressPattern: "*"`, exactly like `KEY_ADMIN` today. Follow whatever
  the existing global-capability submit path does, and do not invent a new
  one.

## Pitfalls

- `Object.keys(CAPABILITY_LABELS)` determines the picker order. Append
  `USER_ADMIN` last, so the existing default row (`MAIL_READ`) is
  unchanged.
- Keep the description text identical to the design. Tests compare it
  through the exported constant.

## Tests (input or situation -> expected outcome)

`helpers.test.ts`:

- `formatScope({ capability: "USER_ADMIN", domain: null, addressPattern: "*" })`
  -> contains "Administer users" and "(instance-wide)".
- `isGlobalCapability("USER_ADMIN")` -> `true`.

`api-keys-page.test.tsx`: render `ApiKeysPage` in `StoreProvider` with a
fake store that has no domains, and stub `fetch` so `apiKeys` returns
`[]`.

- The capability select offers an option with value `USER_ADMIN` and the
  new label.
- Selecting `USER_ADMIN` -> the `USER_ADMIN_DESCRIPTION` text is visible,
  and the "Domain" select is absent.
- Selecting `MAIL_READ` again -> the description disappears, and the
  domain select is shown.

## Verification (repo root; logs under `/tmp/user-admin-04-*.log`)

1. `bun run --cwd apps/web test` exits 0. The count is at least the 299
   baseline plus the new tests, and `users-page.test.tsx` still passes.
2. `bun run --cwd apps/web typecheck` exits 0.
3. `bunx biome check apps/web/src` exits 0.
4. `wc -l` on the touched files: each is under 1000 lines.

## Done criteria

- [ ] TASK-001 and TASK-002 and the tests are complete.
- [ ] Verification steps 1-4 pass, with exit codes, the web test count and
      log paths recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.
- If a check fails only in a file owned by another plan that runs in the
  same wave, that is a cross-plan transient. Record the file, the owner and
  the log, wait for the owner to report done, then re-run. Do not edit that
  file.

## Progress Log

(empty)
