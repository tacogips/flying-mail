# Webmail 14: Domain Rail and Inbound MX Readiness

**Status**: Completed
**Design Reference**: design-docs/specs/design-webmail-completion.md section 14
**Created**: 2026-10-07

## Scope

Two parallel tasks with disjoint write paths. The web task mirrors the
GraphQL contract in section 14.1 exactly.

### TASK-001: Server MX readiness gate
**Status**: Completed
**Parallelizable**: Yes

**writePaths**
- `packages/application/src/ports/dns-resolver.ts`
- `packages/application/src/usecases/domains.ts`
- `packages/application/src/dependencies.ts` (`inboundMxSuffix` only)
- `packages/application/src/test-support/*`
- `packages/application/src/usecases/*domain*.test.ts`, plus the admin
  tests that cover verifyDomain
- `packages/adapter/src/dns/doh-resolver.ts` and its test
- `packages/infrastructure/src/composition/config.ts`,
  `build-dependencies.ts` and their tests
- `packages/infrastructure/src/graphql/schema.graphql.ts` (MailDomain
  field and enum only)
- `packages/infrastructure/src/graphql/resolvers/types.ts` (MailDomain
  `inboundMx`)
- `apps/api/src/env.ts`, `apps/api/src/worker.ts` and `apps/api/src/server.ts`
  (env plumbing only)
- `apps/api/wrangler.toml`: a documented commented var only. The default
  applies when unset.
- Any additional test files.

**Completion Criteria**
- [x] `lookupMx` is on the port, the DoH adapter and the fakes, with tests
- [x] The verifyDomain MX gate covers ready, not Cloudflare, none, lookup
      failure, gate disabled, and already verified, with tests
- [x] `MailDomain.inboundMx` resolver and SDL, with a test
- [x] `MAILCAL_INBOUND_MX_SUFFIX` config: default, empty means disabled,
      with tests
- [x] `bun run typecheck`, `bun run test` and biome all pass

### TASK-002: Web domain rail
**Status**: Completed
**Parallelizable**: Yes

**writePaths**
- `apps/web/src/components/domain-rail.tsx`, its css and its test
- `apps/web/src/components/mailbox-sidebar.tsx` and its css
- `apps/web/src/pages/mailbox-page.tsx`
- `apps/web/src/components/app-shell.tsx` and its css
- `apps/web/src/components/compose-host.tsx` (default From only)
- `apps/web/src/components/compose-form.tsx` (filtering of From groups to
  ACTIVE domains only)
- `apps/web/src/pages/settings/domains-page.tsx` (and its css if present)
- `apps/web/src/api/schema-types.ts` and `documents.ts` (`inboundMx` mirror
  only)
- `apps/web/src/lib/*` helpers and tests as needed

**Completion Criteria**
- [x] The rail has All, ACTIVE domains, pill, badge, tooltip and the
      settings link, and is URL-scoped
- [x] The sidebar has the domain header, folders, and the ADDRESSES section
      in its per-domain and All variants. The DOMAINS section is removed.
- [x] PENDING and DISABLED domains are hidden from the mail UI and shown in
      Settings with the TXT record, the inboundMx badge and Verify
- [x] Compose's default From follows the scope
- [x] The phone drawer contains the rail and the sidebar
- [x] `bun run --cwd apps/web typecheck`, `bun run --cwd apps/web test`,
      biome and `mise run build-web` all pass

## Progress Log

### Session: 2026-10-07
Plan created from the design addendum, section 14.

### Session: 2026-10-07
**Tasks Completed**: TASK-001 implementation and focused tests
**Commands**:
- `bunx biome check packages/application/src/ports/dns-resolver.ts packages/application/src/dependencies.ts packages/application/src/test-support/runtime-fakes.ts packages/application/src/usecases/domains.ts packages/application/src/usecases/admin.test.ts packages/adapter/src/dns/doh-resolver.ts packages/adapter/src/dns/doh-resolver.test.ts packages/infrastructure/src/composition/config.ts packages/infrastructure/src/composition/config.test.ts packages/infrastructure/src/composition/build-dependencies.ts packages/infrastructure/src/graphql/schema.graphql.ts packages/infrastructure/src/graphql/resolvers/types.ts packages/infrastructure/src/graphql/schema-domain-mx.test.ts apps/api/src/env.ts apps/api/src/worker.ts apps/api/src/worker.test.ts` — exit 0; 16 files checked.
- `bun run typecheck` — exit 2; application, adapter, infrastructure, API and CLI passed. The concurrent web task currently fails at `apps/web/src/components/compose-form.test.tsx:57` and `apps/web/src/components/compose-host.tsx:301` (TS2322: missing required `activeDomainNames`). The first pass found TS4111 in `apps/api/src/worker.test.ts`; fixed with bracket notation.
- `bun run test` — exit 0; root Vitest 119 files / 1,710 tests passed; web Vitest 18 files / 251 tests passed.
**Notes**: The initial aggregate typecheck failed only in concurrent TASK-002 web files; the later refresh below passed after that work was fixed.

### Session: 2026-10-07
**Tasks Completed**: TASK-001 final verification refresh
**Commands**:
- `bun run typecheck` — exit 0; CLI, domain, web, application, adapter, infrastructure and API typechecks passed.
**Notes**: The earlier web type errors were fixed by the concurrent TASK-002 implementation; the full repository typecheck now passes.

### Session: 2026-10-07
**Tasks Completed**: TASK-002
**Validation**:
- `bunx biome check` on the TASK-002 source and test paths — exit 0; 13 files checked, no fixes applied
- `bun run --cwd apps/web typecheck` — exit 0
- `bun run --cwd apps/web test` — exit 0; 18 test files, 251 tests passed
- `mise run build-web` — exit 0
**Notes**: Added the domain rail, scoped address sidebar, ACTIVE-only compose From groups and scope defaults, inbound MX Settings display, and behavior tests.

### TASK-003: Recent-address list (depends on TASK-001, TASK-002)
**Status**: Completed
**Parallelizable**: No

**writePaths**
- Server:
  - `packages/application/src/usecases/*` (a new `address-activity.ts`
    plus its test, and wiring in `usecases.ts`)
  - the repository port and the D1/SQL repository method plus its test
  - `packages/infrastructure/src/graphql/schema.graphql.ts` (Viewer
    field and type)
  - `resolvers/*`
- Web:
  - `apps/web/src/components/mailbox-sidebar.tsx` and its css
  - `apps/web/src/api/schema-types.ts` and `documents.ts`
  - `apps/web/src/store/app-store.ts` (load and refresh `addressActivity`)
  - `apps/web/src/lib/*` helpers and tests

**Completion Criteria**
- [x] `Viewer.addressActivity` matches design section 14.3, uses a single
      aggregate query, and has tests for ordering, null activity, unread
      counts and scoping to readable addresses
- [x] The ADDRESSES section sits above All mail and the folders, shows the
      top 7 per scope, and has the expand toggle, the filter, the selected
      address always visible, and unread badges
- [x] The lists refresh after a send or receive reload
- [x] All verification passes

### TASK-003 Progress Log

#### Session: 2026-10-07
**Tasks Completed**: TASK-003
**Commands**:
- `bunx biome check` on 19 TASK-003 path arguments — exit 0; 18 supported files checked, no fixes; one informational `noUselessContinue` diagnostic in existing `compose-usecases.ts` code.
- `bun run typecheck` — exit 0; all workspace packages passed.
- `bun run --cwd apps/web typecheck` — exit 0.
- `bun run test` — exit 0; 121 server test files / 1,714 tests passed and 20 web test files / 257 tests passed.
- `bun run --cwd apps/web test` — exit 0; 20 test files / 257 tests passed.
- `mise run build-web` — exit 0; Vite production build completed.
- After correcting the fake resolver comment, targeted Biome on
  `packages/application/src/test-support/runtime-fakes.ts` reported zero
  diagnostics and `bun run typecheck` passed again.

#### Session: 2026-10-07 — Opus review corrections
**Tasks Completed**: TASK-003 review fixes and verification
**Review IDs and evidence**:
- **C1/N6**: `listAddressActivity` now binds readable address/domain pairs as
  one JSON parameter expanded with `json_each`; added a 60-address regression.
- **S1**: All-scope activity renders as one recency-ordered flat list with a
  per-row domain hint.
- **S2/N6**: The address filter resets when the selected domain changes and
  applies only when visible; added a scope-change regression.
- **S3/N6**: The selected address is appended after filtering in both short
  and expanded results; added coverage for both paths.
- **N1**: Address refresh preserves a logged-out null viewer.
- **N2**: Deleting selected messages now refreshes address activity; added a
  store regression.
- **N3**: The Show all label counts only the filtered set.
- **N4**: Address activity filters mailboxes with `authorizesAnyAddress`,
  using one domain and one mailbox repository read.
- **N5**: Replaced the activity materialization with correlated MAX lookups,
  added migration `0014_address_activity_index.sql`, and an EXPLAIN QUERY PLAN
  regression asserting use of the new index.

**Validation**:
- Targeted Biome check on 23 scoped files, including `compose-editor.tsx`
  and `biome.json` — exit 0; zero diagnostics.
- `bun run typecheck` — exit 0; all 7 packages/apps passed.
- `bun run test` — exit 0; 121 files / 1,720 tests passed, including the
  nested web suite (21 files / 264 tests).
- `bun run --cwd apps/web test` — exit 0; 21 files / 264 tests passed.
- `mise run build-web` — exit 0; Vite production build completed.

### Session: 2026-10-07 — Opus review corrections
**Tasks Completed**: TASK-001 review fixes; TASK-002 review fixes
**Review IDs and evidence**:
- **C1**: Removed MX from `DOMAINS_QUERY`; added `DOMAINS_ADMIN_QUERY` and
  settings-only loading. Non-admin `inboundMx`
  now resolves `UNKNOWN`; GraphQL regression test asserts the member still
  receives domain ID/name.
- **M1**: Per-domain unread effect now tracks `inboxUnreadCount`; added a
  mailbox-page regression test that changes the count and asserts another
  per-domain unread request.
- **M2**: Wildcard address matching now preserves a concrete scoped From;
  selected-domain fallback prefers concrete addresses. Compose does not
  derive a local part from a wildcard literal. Added helper and form tests.
- **S1**: Added application `classifyInboundMx` and `inboundMxStatus`
  use-case; verification and GraphQL resolution share application MX
  classification, and the resolver no longer calls DNS directly.
- **S2**: Verification tests reject an appended attacker domain and a fake
  Cloudflare hostname, and accept uppercase Cloudflare MX with a root dot.
- **S3**: DoH ignores RFC 7505 null MX; corrected the fake DNS resolver
  comment and removed the useless compose-loop `continue`.
- **S4**: TXT and MX lookup now share `queryDoh` transport/status handling.
- **S5**: Domain rail labels include unread totals; added keyboard focus
  selection styling and an aria-label assertion.
- **S6**: Sidebar heading uses the domain ID derived by `currentScope()`.
- **S7**: Tablet drawer and backdrop start after the 64px domain rail.
- **S8**: Settings ownership block renders only `_mailcal.` TXT records;
  page test asserts SPF is absent there.
- **S9**: Compose From grouping uses shared `addressDomain`; removed its
  duplicate active-domain filtering because ComposeHost supplies the
  active-only list.
- **Biome info**: Removed `noUselessContinue` at
  `compose-usecases.ts:69`.
**Validation**: Regression tests were added/updated for C1, M1, M2, S2, S3,
S5, and S8. Per caller instruction, verification commands were not run in
this implementation pass; the caller will run the required suite.

#### Verification refresh
- `bunx biome check . --diagnostic-level=info` — exit 0; 414 files checked.
  Two informational diagnostics remain outside the TASK-001/002/003 touched
  paths (`compose-editor.tsx:170` and `biome.json:25`). A targeted check of
  the review-touched files checked 21 files with zero diagnostics.
- `bun run typecheck` — exit 0; all 7 workspace packages passed.
- `bun run test` — exit 0; 121 files / 1,718 tests passed, including 21 web
  files / 259 tests.
- `bun run --cwd apps/web test` — exit 0; 21 files / 259 tests passed.
- `mise run build-web` — exit 0; Vite production build completed.

### Session: 2026-10-07 orchestrator completion
TASK-001..003 implemented by GPT-6 Luna; Opus reviews (rail/MX: C1, M1-M2, S1-S9; address activity: C1, S1-S3, N1-N6) returned to Luna and fixed. Final: mise run lint exit 0; bun run test exit 0 (1720 package, 264 web). Deployed (migration 0014 applied) and verified live with headless Chromium: rail shows only ACTIVE domains with unread counts, ADDRESSES above All mail in recency order, scope URL transitions, compose default From per domain, Settings MX badges (tacogips.me: MX not on Cloudflare), no horizontal scroll at 700px/400px.
