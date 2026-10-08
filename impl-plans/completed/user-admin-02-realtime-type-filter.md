# User Admin 02: Server-side `MailEventScope.types` Filter

**Status**: Completed
**Plan ID**: user-admin-02-realtime-type-filter
**Wave**: 1 (phase 27)
**Depends On**: none
**Design Reference**: design-docs/specs/design-realtime-push.md sections 5.1, 5.2 ("scope.types"), 6.4 (last paragraph), 13 ("Type filter" row), D15; design-docs/specs/design-user-admin-capability.md section 3
**Created**: 2026-10-08

## Intent and context

`mailEvents(scope: { types })` should narrow delivery to the listed event
types on the server. Replay must stay gap-free and duplicate-free, which
means `lastSeq` keeps advancing over every row the drain reads.

Current code:

- `packages/domain/src/entities/mail-event.ts:MailEventScope` is
  `{ domainId, address }`.
- `packages/infrastructure/src/realtime/drain-helpers.ts:matchesScope(domainFilter, addressFilter, row)`.
- `packages/infrastructure/src/realtime/drain.ts:233-295`. The filter call
  is at line 235. `subscription.lastSeq = row.seq` at line 294 is
  **outside** the match branch, and must stay there.
- `packages/infrastructure/src/realtime/executor.ts:coerceScope` (line
  236) returns `MailEventScope | null`. Its caller (lines 343-349) always
  reports `scope.address`.
- `packages/infrastructure/src/graphql/schema-realtime.graphql.ts:MailEventScope`.

## Non-goals

- No change to `host.ts`, `hub*.ts`, `in-process-host.ts`, `apps/api`, the
  web client or `realtime-documents.ts`. The web keeps sending no `types`.
- No change to cursor format, retention, or the LIVE emission branch.
- Do not touch `schema.graphql.ts` (plan 01) or the CLI (plan 03).

## writePaths

- packages/domain/src/entities/mail-event.ts
- packages/infrastructure/src/realtime/drain-helpers.ts
- packages/infrastructure/src/realtime/drain.ts
- packages/infrastructure/src/realtime/executor.ts
- packages/infrastructure/src/realtime/executor.test.ts
- packages/infrastructure/src/realtime/drain.test.ts
- packages/infrastructure/src/graphql/schema-realtime.graphql.ts
- packages/infrastructure/src/graphql/schema-realtime.test.ts
- impl-plans/completed/user-admin-02-realtime-type-filter.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: Contract

- `mail-event.ts`: add `readonly types?: readonly MailEventType[] | null;`
  to `MailEventScope`.
  - The field must be **optional**. `apps/api/src/mail-event-hub.test.ts`
    and `realtime-bun.test.ts` build `{ domainId: null, address: null }`
    literals and must keep compiling.
  - States persisted before this change have no field.
  - Absent and `null` both mean all types.
  - Doc comment: "Filter only; never a grant. LIVE is never listed here."
- `schema-realtime.graphql.ts`: add `types: [MailEventType!]` to `input
  MailEventScope`, with a description: "Only these event types; omitted or
  null means all. LIVE is not allowed here and is always delivered."

### TASK-002: Validation (`executor.ts`)

- Change `coerceScope` to return a discriminated result:
  `{ ok: true; scope: MailEventScope } | { ok: false; field: "scope.address" | "scope.types"; message: string }`.
- The caller passes `field` and `message` to the existing
  `badInput(message, field)`.
- Keep the address message text unchanged
  ("scope.address is not a valid email address").
- `types` rules:
  - `undefined` or `null`: `types: null`.
  - Not an array: invalid on `scope.types`.
  - Empty array: `"scope.types must list at least one event type"`.
  - Any `"LIVE"` entry: `"scope.types cannot include LIVE; it is always delivered"`.
  - Any value not in `Object.values(MailEventType)`: invalid. GraphQL enum
    validation normally catches this first; keep the check defensively.
  - Otherwise: deduplicate, then sort into `Object.values(MailEventType)`
    declaration order.
- The returned scope always includes `types` (value or `null`).

### TASK-003: Filtering (`drain-helpers.ts`, `drain.ts`)

- New signature:
  `matchesScope(scope: MailEventScope, row: { readonly domainId: string; readonly addresses: readonly string[]; readonly type: MailEventType }): boolean`.
- Keep the existing domain and address logic, then add
  `scope.types == null || scope.types.includes(row.type)`. Use `== null`
  or an explicit undefined-or-null check so that a missing field matches
  everything.
- `drain.ts` line ~235: call `matchesScope(subscription.scope, row)`.
  Change nothing else in the loop. In particular, do not move or
  condition `subscription.lastSeq = row.seq`, and do not touch the
  `rows.length < REPLAY_PAGE` LIVE branch.

## Pitfalls

- Do not filter by type in `listAfter` or in SQL. Filtering stays per
  subscription in memory, so cursors stay global (D3).
- Do not reject `types` that the viewer cannot read. A scope is a filter
  that reveals nothing.
- `executor.test.ts` has its own SDL copy (line ~71: `input MailEventScope
  { domainId: ID, address: String }`). Add `types: [MailEventType!]` there
  too, or the new tests fail GraphQL validation rather than reaching
  `coerceScope`.
- Biome: keep the switch to `Object.values(MailEventType)` typed. No `any`.

## Tests (input or situation -> expected outcome)

`drain.test.ts`, using its existing fake log, host and executor harness:

- Rows seq 1..6 alternate RECEIVED and SENT. A subscription with
  `types: ["MESSAGE_SENT"]` -> only seq 2, 4, 6 are sent, in increasing
  order. After the drain, `subscription.lastSeq === 6`.
- Last row seq 7 is RECEIVED (filtered) -> `lastSeq` is 7, and LIVE carries
  cursor seq 7. LIVE is sent exactly once.
- Resubscribe with `after` = cursor of seq 4 -> only seq 6 is delivered. No
  duplicate of 2 or 4.
- Two subscriptions on one connection, `[MESSAGE_SENT]` and
  `[MESSAGE_RECEIVED]` -> each gets only its own subset. Each `lastSeq`
  reaches the head.
- A subscription state whose scope object has **no** `types` key (simulates
  a persisted pre-change state) -> receives all types.
- `types` combined with `domainId` -> both filters apply (AND).

`executor.test.ts`:

- `scope: { types: [] }` -> `ok: false`, `BAD_USER_INPUT`, field
  `scope.types`.
- `types: ["LIVE"]` -> same, with field `scope.types`.
- `types: ["MESSAGE_SENT","MESSAGE_RECEIVED","MESSAGE_SENT"]` -> prepared
  scope `types` is `["MESSAGE_RECEIVED","MESSAGE_SENT"]`.
- No `types` -> `types: null`. Invalid address -> field `scope.address`,
  with unchanged message.

`schema-realtime.test.ts`:

- The printed schema's `MailEventScope` has a `types` field of type
  `[MailEventType!]`.

## Verification (repo root; logs under `/tmp/user-admin-02-*.log`)

1. `bunx vitest run packages/infrastructure/src/realtime packages/infrastructure/src/graphql/schema-realtime.test.ts packages/domain/src/entities/mail-event.test.ts apps/api/src/mail-event-hub.test.ts apps/api/src/realtime-bun.test.ts`
   exits 0.
2. `bun run --cwd packages/domain typecheck`,
   `bun run --cwd packages/infrastructure typecheck` and
   `bun run --cwd apps/api typecheck` each exit 0. The apps/api check
   proves that optional `types` keeps old literals valid.
3. `bunx biome check packages/infrastructure/src/realtime packages/infrastructure/src/graphql packages/domain/src/entities`
   exits 0.
4. `wc -l` on every touched file: all are under 1000 lines, and
   `drain.ts` and `executor.ts` stay under 400.

## Done criteria

- [x] TASK-001 to TASK-003 and the tests are complete.
- [x] `grep -n "lastSeq = row.seq" packages/infrastructure/src/realtime/drain.ts`
      still shows exactly one assignment, outside the `matchesScope`
      block.
- [x] Verification steps 1-4 pass, with exit codes and logs recorded.

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

### Session: 2026-10-08
**Tasks Completed**: TASK-001, TASK-002, TASK-003 and planned tests
**Blockers**: None
**Notes**:
- Added optional nullable `MailEventScope.types`, SDL input documentation,
  defensive scope coercion, declaration-order deduplication, and per-row
  filtering while preserving the single cursor assignment outside the
  match branch and the existing LIVE path.
- Kept `executor.ts` below 400 lines by locating `coerceScope` in the
  existing approved `drain-helpers.ts` module; the executor retains the
  discriminated-result error mapping. `executor.ts` is 354 lines and
  `drain.ts` is 381 lines.
- Drain tests seed persisted filter scope and rehydrate the hub because the
  shared harness SDL is outside this plan's write paths. They cover filtered
  cursor advancement, replay, independent filters, legacy scope, domain AND,
  and LIVE at the head. Executor tests also cover empty, LIVE, non-array and
  unknown values on `scope.types`.
- Final behavioral run: 11 files, 80 tests passed; see
  `/tmp/user-admin-02-vitest-source-final-3.log` (exit 0).
- Final typechecks passed: domain at
  `/tmp/user-admin-02-domain-typecheck-source-final.log`, infrastructure at
  `/tmp/user-admin-02-infrastructure-typecheck-source-final-3.log`, and API
  at `/tmp/user-admin-02-api-typecheck-source-final.log` (each exit 0).
- Final Biome check passed at `/tmp/user-admin-02-biome-source-final-2.log`
  (exit 0). Cursor assignment check passed once at drain.ts:288 in
  `/tmp/user-admin-02-lastseq-source-final.log`; line counts are recorded in
  `/tmp/user-admin-02-line-counts-source-final.log` (exit 0).
- Earlier test fixture, type narrowing, formatting, and line-count failures
  were corrected and re-run on the final source. Formal review and serial
  reconciliation remain owned by later workflow steps.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
