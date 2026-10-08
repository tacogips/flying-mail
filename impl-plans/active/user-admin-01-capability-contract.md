# User Admin 01: USER_ADMIN Capability Contract (domain, SDL, migration, bootstrap, fail-closed policy)

**Status**: Ready
**Plan ID**: user-admin-01-capability-contract
**Wave**: 1 (phase 27)
**Depends On**: none
**Design Reference**: design-docs/specs/design-user-admin-capability.md sections 2.1, 2.5 (bootstrap bullet), 2.6, 2.9; design-docs/specs/design-api-keys-and-permissions.md "Capabilities", "Scopes", "USER_ADMIN"
**Created**: 2026-10-08

## Intent and context

This plan introduces `USER_ADMIN` as a stored, storable, and **inert**
capability. When it is done:

- the value exists in the domain enum, the GraphQL `Capability` enum and
  the D1 CHECK constraint;
- it is classified as global;
- the bootstrap key does not receive it;
- no scope-only check can ever accept it.

Plan 07 (wave 2) adds the only path that accepts it.

Current code, read before editing:

- `packages/domain/src/entities/api-key.ts:Capability` has 12 values, and
  `GLOBAL_CAPABILITIES` is at line 72.
- `packages/application/src/policies/authorization.ts:authorizesGlobal` is
  at line 51.
- `packages/application/src/usecases/email-auth.ts:createBootstrapAdminUseCase`
  iterates `Object.values(Capability)` at line 302.
- `packages/infrastructure/src/graphql/schema.graphql.ts` declares
  `enum Capability` at line 84.
- `apps/api/migrations/0012_remove_calendar.sql:36-56` is the newest
  rebuild of `api_key_scopes`. Its pattern is the one to imitate.

## Non-goals

- No guard, no use-case authorization change, and no `assertGrantable`
  change. All of those belong to plan 07.
- Do not edit migrations 0001-0016.
- Do not touch `viewer.ts`, `auth-guards.ts`, `users.ts`,
  `user-template-permissions.ts`, `api-keys.ts`, or
  `test-support/viewer-fixtures.ts`.
- No web, CLI or realtime changes.

## writePaths

- packages/domain/src/entities/api-key.ts
- packages/domain/src/entities/api-key.test.ts
- packages/application/src/policies/authorization.ts
- packages/application/src/policies/authorization.test.ts
- packages/application/src/usecases/email-auth.ts
- packages/application/src/usecases/auth.test.ts
- packages/infrastructure/src/graphql/schema.graphql.ts
- packages/infrastructure/src/graphql/schema.test.ts
- apps/api/migrations/0017_user_admin_capability.sql (new)
- packages/adapter/src/migrations/user-admin-migration.test.ts (new)
- packages/adapter/src/migrations/runner.test.ts
- impl-plans/active/user-admin-01-capability-contract.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: Domain enum and classification (`api-key.ts`)

- Add `UserAdmin = "USER_ADMIN"` as the **last** member of `Capability`.
- Add `Capability.UserAdmin` to `GLOBAL_CAPABILITIES`. Give it a one-line
  comment: "instance-wide; accepted only by the user-administration guard,
  never by scope membership alone".
- Do not change `scopesAuthorizeGlobal`. Plan 07 calls it to detect that a
  key holds the scope.

### TASK-002: Fail-closed policy (`authorization.ts`)

- `authorizesGlobal(viewer, capability)` returns `false` when
  `capability === Capability.UserAdmin`, for **both** viewer kinds. Put
  this check first in the function.
- Update the doc comment to say why: liveness needs repository access, so
  only `requireUserAdministrator` in `auth-guards.ts` (plan 07) may accept
  it.
- `requireGlobalCapability` needs no edit; it throws through
  `authorizesGlobal`.

### TASK-003: Bootstrap exclusion (`email-auth.ts`)

- In `createBootstrapAdminUseCase`, iterate
  `Object.values(Capability).filter((c) => c !== Capability.UserAdmin)`.
- Update the comment: the key holds every capability except `USER_ADMIN`,
  because user administration by key must be granted by a signed-in admin
  (design 2.5).

### TASK-004: GraphQL enum (`schema.graphql.ts`)

- Append `USER_ADMIN` to `enum Capability`. Give it a `"""` description
  with the exact text from design 2.1: "Manage users (list, roles,
  activation, mail and template rules) while the key's creator is an active
  ADMIN. Never creates or invites users."
- Domain and SDL values must match exactly. The resolvers pass the strings
  through.

### TASK-005: Migration `0017_user_admin_capability.sql`

- Start with a header comment like the one in 0010 and 0012: SQLite cannot
  widen a CHECK in place.
- Steps, in this order:
  1. `CREATE TABLE api_key_scopes_new`. Copy the 0012 column definitions
     byte-for-byte, including `REFERENCES api_keys(id) ON DELETE CASCADE`,
     `REFERENCES domains(id) ON DELETE CASCADE` and
     `DEFAULT '*'`. The CHECK list is the 0012 list with `'USER_ADMIN'`
     appended.
  2. `INSERT INTO api_key_scopes_new SELECT id, api_key_id, capability,
     domain_id, address_pattern FROM api_key_scopes;` with **no** WHERE
     clause.
  3. `DROP TABLE api_key_scopes;`
  4. `ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;`
  5. `CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);`
- Do not add PRAGMA statements. 0010 and 0012 do not use any, and D1
  rejects some of them.
- Do not backfill USER_ADMIN rows.

### TASK-006: Tests

- `api-key.test.ts`:
  - The enum-set assertion (line ~255) includes `"USER_ADMIN"`.
  - "exactly 12 members" becomes 13.
  - New: `isGlobalCapability(Capability.UserAdmin)` is `true`.
  - New: `createApiKeyScope` with `UserAdmin` and a domain id stores
    `domainId: null`.
- `authorization.test.ts`:
  - An ADMIN user and a key whose scopes include `USER_ADMIN` both get
    `authorizesGlobal(..., UserAdmin) === false`.
  - `requireGlobalCapability(..., UserAdmin)` throws `ForbiddenError` for
    both.
  - `DOMAIN_ADMIN` and `KEY_ADMIN` behavior is unchanged. Add an assertion
    for this.
- `auth.test.ts` (line ~511):
  - The bootstrap scope count is `Object.values(Capability).length - 1`.
  - The scope list does not contain `USER_ADMIN`.
- `schema.test.ts` (line ~642):
  - Same change for the `bootstrapAdmin` GraphQL test: length minus 1, and
    no `USER_ADMIN`.
  - New: the introspected or printed schema `Capability` enum contains
    `USER_ADMIN`.
- `runner.test.ts`: append `"0017_user_admin_capability.sql"` to both
  expected `applied` lists (lines ~116 and ~171).
- `user-admin-migration.test.ts`: imitate
  `remove-calendar-migration.test.ts`, which uses
  `createInMemoryDatabase`, `loadMigrationFiles` and
  `createMigrationRunner`.
  - Apply migrations with names `< "0017"`. Seed a user, a domain, and one
    api key with 12 scopes, one per pre-existing capability. Include one
    scope with `domain_id = 'dom-1'` and pattern `support@example.com`.
  - Apply 0017. Every seeded row is unchanged (compare full rows ordered by
    id).
  - Inserting a `USER_ADMIN` scope succeeds. Inserting `'BOGUS'` throws.
  - `sqlite_master` lists `idx_api_key_scopes_key` on `api_key_scopes`.
  - `DELETE FROM api_keys WHERE id = ...` removes that key's scopes.
  - `DELETE FROM domains` (after removing rows that block it, if any)
    removes the domain-scoped scope.

## Pitfalls

- Appending to the enum changes `Object.values(Capability)` everywhere. Run
  `grep -rn "Object.values(Capability)" packages apps --include='*.ts'`.
  The only expected hits are `email-auth.ts`, `auth.test.ts`,
  `schema.test.ts`, `schema-auth-hardening.test.ts` and `api-key.test.ts`.
  - `schema-auth-hardening.test.ts:315` builds a root key with every
    capability and expects `createUser` to be FORBIDDEN. It stays correct;
    do not edit it.
  - If any other test breaks, record it in the progress log. Do not edit
    files outside writePaths.
- Do not put the `UserAdmin` exclusion in `scopesAuthorizeGlobal` (domain).
  Plan 07 needs that to detect that the scope is held.
- Do not reorder existing enum members.

## Verification (repo root; keep each log under `/tmp/user-admin-01-*.log`)

1. `bunx vitest run packages/domain packages/adapter/src/migrations packages/application/src/policies packages/application/src/usecases/auth.test.ts packages/infrastructure/src/graphql/schema.test.ts packages/infrastructure/src/graphql/schema-auth-hardening.test.ts`
   exits 0. The new migration test file is listed as passed.
2. `bun run --cwd packages/domain typecheck`,
   `bun run --cwd packages/application typecheck`,
   `bun run --cwd packages/infrastructure typecheck` and
   `bun run --cwd packages/adapter typecheck` each exit 0.
3. `bunx biome check packages/domain/src packages/application/src packages/infrastructure/src/graphql packages/adapter/src/migrations`
   exits 0.
4. `git diff --quiet -- apps/api/migrations/0001_init.sql apps/api/migrations/0012_remove_calendar.sql apps/api/migrations/0016_mail_events.sql`
   exits 0, which shows the old migrations are untouched.
5. `wc -l` on every touched file: each is under 1000 lines.

## Done criteria

- [ ] TASK-001 to TASK-006 are complete.
- [ ] `grep -c "USER_ADMIN" apps/api/migrations/0017_user_admin_capability.sql` is at least 1.
- [ ] Verification steps 1-5 pass. Exit codes and log paths are recorded
      in the Progress Log.

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
