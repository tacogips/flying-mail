# User Admin 07: USER_ADMIN Authorization (guard, use cases, grant rules)

**Status**: Completed
**Plan ID**: user-admin-07-authorization
**Wave**: 2 (phase 28)
**Depends On**: user-admin-01-capability-contract
**Design Reference**: design-docs/specs/design-user-admin-capability.md sections 2.2, 2.3, 2.4, 2.5, 2.9; design-docs/specs/design-security-model.md section 9b; design-docs/user-qa/pending-user-admin.md U1, U4
**Created**: 2026-10-08

## Intent and context

A **live** `USER_ADMIN` key may perform exactly the user-administration
operations in design 2.2. "Live" means the key's creator exists, is ACTIVE
and has role ADMIN, checked on every call. An ADMIN session keeps working
as before. Everything else is refused.

Plan 01 already provides:

- `Capability.UserAdmin` in `GLOBAL_CAPABILITIES`;
- `authorizesGlobal(..., UserAdmin) === false`;
- the bootstrap exclusion;
- the GraphQL enum value.

Current code:

- `packages/application/src/usecases/auth-guards.ts:requireAdminUser`
  (session-only, synchronous).
- `packages/application/src/usecases/users.ts`: seven `requireAdminUser`
  calls. `addUserMailPermission` writes `createdByUserId: viewer.userId`
  (line ~209).
- `packages/application/src/usecases/user-template-permissions.ts`: a
  private `requireAdminUser` at line 30. `add` writes
  `createdByUserId: viewer.userId`.
- `packages/application/src/usecases/invitations.ts:73` (resend) and
  `users.ts:createCreateUserUseCase` must stay on `requireAdminUser`.
- `packages/application/src/usecases/api-keys.ts:assertGrantable` (line
  145) and `createAddApiKeyScopeUseCase` (line 254).
- Ports: `deps.apiKeyRepository.findById`, `deps.userRepository.findById`.
- Domain: `isApiKeyUsable(key, now)`, `isUserActive(user)`, `UserRole.Admin`,
  `scopesAuthorizeGlobal(scopes, Capability.UserAdmin)`. This last one only
  detects that a key holds the scope.

## Non-goals

- Do not change `Viewer`, `viewer.ts`, `auth.ts` (viewer resolution) or
  `test-support/viewer-fixtures.ts`.
- Do not change `createUser`, `invitations.ts`, rate limiting, Turnstile or
  realtime authorization.
- No atomic last-admin rewrite. U4 is accepted as residual risk.
- Do not touch plan 01 files (`authorization.ts`, `email-auth.ts`,
  `schema.graphql.ts`, `schema.test.ts`, `auth.test.ts`).
- No GraphQL resolver changes. Use-case signatures stay identical.

## writePaths

- packages/application/src/usecases/auth-guards.ts
- packages/application/src/usecases/auth-guards.test.ts
- packages/application/src/usecases/users.ts
- packages/application/src/usecases/user-template-permissions.ts
- packages/application/src/usecases/api-keys.ts
- packages/application/src/usecases/user-admin-capability.test.ts (new)
- packages/application/src/usecases/users.test.ts (only if an existing assertion on a FORBIDDEN message text must change)
- packages/application/src/usecases/user-template-permissions.test.ts (same condition)
- packages/application/src/usecases/admin.test.ts (same condition)
- packages/infrastructure/src/graphql/schema-user-admin.test.ts (new)
- packages/infrastructure/src/graphql/schema-users.test.ts (same condition)
- impl-plans/completed/user-admin-07-authorization.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: Guard (`auth-guards.ts`)

Pin this signature:

```
export interface UserAdministrator { readonly actorUserId: UserId }
export async function requireUserAdministrator(deps: AppDependencies, viewer: Viewer): Promise<UserAdministrator>
```

The checks run in design 2.3 order. Each failure throws `ForbiddenError`
with the exact message given.

1. A `USER` viewer:
   - `role === UserRole.Admin` -> `{ actorUserId: viewer.userId }`;
   - otherwise -> "Only an admin user may administer users". This is the
     current text; keep it.
2. An `API_KEY` viewer without
   `scopesAuthorizeGlobal(viewer.scopes, Capability.UserAdmin)` ->
   "This API key lacks the USER_ADMIN capability".
3. Load the key with `apiKeyRepository.findById(viewer.apiKeyId)`. If it
   is `null`, or `!isApiKeyUsable(key, deps.clock.now().toISOString())` ->
   "USER_ADMIN is inactive: this key is no longer usable".
4. `key.createdByUserId === null` ->
   "USER_ADMIN is inactive: this key has no creating admin".
5. Load the creator with `userRepository.findById`. If it is missing,
   `!isUserActive(creator)`, or `creator.role !== UserRole.Admin` ->
   "USER_ADMIN is inactive: the admin who created this key is no longer an active ADMIN".
6. Return `{ actorUserId: creator.id }`.

- Keep `requireAdminUser` exported and unchanged. `createUser` and
  `invitations.ts` still use it.
- No caching, memoization or module-level state.

### TASK-002: Use cases

- `users.ts`:
  - `createListUsersUseCase`, `createGetUserUseCase`,
    `createSetUserRoleUseCase`, `createSetUserActiveUseCase`,
    `createAddUserMailPermissionUseCase` and
    `createRemoveUserMailPermissionUseCase` call
    `const { actorUserId } = await requireUserAdministrator(deps, viewer)`
    as their **first** statement, inside the existing
    `withAsyncDomainErrorTranslation` wrapper where one exists.
  - `addUserMailPermission` writes `createdByUserId: actorUserId`.
  - `createCreateUserUseCase` is **unchanged**.
- `user-template-permissions.ts`:
  - Delete the private `requireAdminUser`.
  - List, add and remove call `requireUserAdministrator`.
  - `add` writes `createdByUserId: actorUserId`.
  - Remove now-unused imports (`UserRole`, `ForbiddenError` if unused) to
    keep Biome clean.
- The last-active-admin logic (`countActiveAdmins`) is untouched, so it
  applies equally to keys.

### TASK-003: Grant rules (`api-keys.ts`)

- `assertGrantable`: add this as the **first** branch.
  If `scope.capability === Capability.UserAdmin` and `!isAdminViewer(viewer)`
  -> `ForbiddenError("USER_ADMIN can only be granted by a signed-in admin")`.
  - This covers API-key viewers, including keys holding
    `KEY_ADMIN` + `USER_ADMIN`.
  - The existing global branch (`scopesAuthorizeGlobal`) must never be
    reached for `USER_ADMIN`.
- `createAddApiKeyScopeUseCase`: after `assertGrantable`, if the capability
  is `UserAdmin` and the viewer is a `USER` whose `userId` differs from
  `key.createdByUserId` -> `ForbiddenError("USER_ADMIN can only be added to a key you created")`.
  A `null` creator also fails.
- `createCreateApiKeyUseCase` needs no other change. An ADMIN session
  already stores `createdByUserId = viewer.userId`.

## Pitfalls

- Do **not** call `requireGlobalCapability(viewer, Capability.UserAdmin)`.
  After plan 01 it always throws.
- Ordering: the guard must run before any repository read of the target
  user. Otherwise a refused key could probe ids through `NOT_FOUND` versus
  `FORBIDDEN`.
- `removeUserMailPermission` currently runs without
  `withAsyncDomainErrorTranslation`. Adding `await` is enough; do not
  restructure it.
- The guard's step 3 uses the clock from `deps` (`deps.clock.now()`), not
  `Date.now()`.
- Do not widen `isAdminViewer` or make an API key count as admin anywhere
  else.

## Tests (input or situation -> expected outcome)

Seed helpers live inside the new test files:

- create the creator user with `createUser` and save it;
- save an `ApiKey` with id `key-ua` and `createdByUserId` set to the
  creator;
- build the viewer with
  `apiKeyViewer([{ capability: Capability.UserAdmin }], "key-ua")`.

`user-admin-capability.test.ts`, using `createFakeDependencies`:

- A live key -> list, get, setUserRole, setUserActive(false/true), add and
  remove mail permission, list, add and remove template permission all
  succeed.
- A live key -> `createUser` -> `ForbiddenError`. `resendInvitation`
  (from `invitations.ts`) -> `ForbiddenError`.
- A key holding every capability except `USER_ADMIN` -> every operation
  above -> `ForbiddenError`.
- A MEMBER session -> `ForbiddenError`. An ADMIN session -> all operations
  succeed (regression).
- Creator demoted to MEMBER, or deactivated -> the next `listUsers` with
  the key -> `ForbiddenError` mentioning "no longer an active ADMIN".
- The same key with an added `MAIL_READ` scope -> a mail read use case
  still succeeds.
- Key saved with `createdByUserId: null` -> `ForbiddenError` "no creating
  admin".
- Key revoked in the repository after the viewer was built ->
  `ForbiddenError` "no longer usable".
- Creator is the only active admin -> the key tries
  `setUserRole(creator, MEMBER)` and `setUserActive(creator, false)` ->
  `ConflictError`.
- Two admins (creator A, admin B) -> the key demotes A, succeeds, and its
  next call is `ForbiddenError`. With A already demoted, the key tries
  `setUserRole(A, ADMIN)` -> `ForbiddenError` (no self-restoration).
- Rule and template rule created through the key -> `createdByUserId` is
  the creator id.
- `createApiKey` by an ADMIN session with a `USER_ADMIN` scope -> succeeds,
  stored scope `domainId === null`, key `createdByUserId === admin.userId`.
- `createApiKey` by a `KEY_ADMIN` key, and by a `KEY_ADMIN`+`USER_ADMIN`
  key, with `USER_ADMIN` -> `ForbiddenError`.
- `addApiKeyScope(USER_ADMIN)` by admin B on a key created by admin A ->
  `ForbiddenError`. The same call by admin A -> succeeds. The same call by
  a `KEY_ADMIN` key -> `ForbiddenError`.

`auth-guards.test.ts`:

- Unit cases for each of guard steps 1-6, including that
  `requireAdminUser` is unchanged for a `USER_ADMIN` key (it still
  throws).

`schema-user-admin.test.ts` (new; imitate `schema-users.test.ts` with
`createGraphQLHarness` and `errorCodes`):

- The live key runs `{ users { id email permissions { id } templatePermissions { id } } }`
  -> no errors.
- `setUserRole` and `addUserMailPermission` -> no errors.
  `addUserMailPermission(...){ createdByUserId }` equals the creator id.
- `createUser` and `resendInvitation` with the same key ->
  `["FORBIDDEN"]`.
- After the creator is deactivated in the repository -> `users` ->
  `["FORBIDDEN"]`.

## Verification (repo root; logs under `/tmp/user-admin-07-*.log`)

1. `bunx vitest run packages/application packages/infrastructure/src/graphql`
   exits 0. All existing tests pass, including `schema-users.test.ts`,
   `invitations.test.ts` and `admin.test.ts`.
2. `bun run --cwd packages/application typecheck` and
   `bun run --cwd packages/infrastructure typecheck` both exit 0.
3. `bunx biome check packages/application/src packages/infrastructure/src/graphql`
   exits 0.
4. `grep -n "requireAdminUser" packages/application/src/usecases/*.ts | grep -v test`
   shows only `auth-guards.ts` (definition), `users.ts` (createUser only)
   and `invitations.ts`.
5. `wc -l` on every touched file: each is under 1000 lines.

## Done criteria

- [x] TASK-001 to TASK-003 and all listed tests are complete.
- [x] Verification steps 1-5 pass, with exit codes and log paths recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. If the file changed since your last read (drift), re-read
  and merge; never overwrite blindly.
- Edit only the writePaths above and this plan's Progress Log. Do not edit
  `PROGRESS.json` or `impl-plans/README.md`; plan 08 reconciles them.
- No git commit, push, stash, reset or checkout.
- This plan runs alone in wave 2. A failure in a file owned by a wave-1
  plan is a repair request for that plan's owner. Do not edit that file.

## Progress Log

### Session: 2026-10-08 plan-07 implementation

**Tasks Completed**: TASK-001, TASK-002, TASK-003.

**Implementation**:

- Added `requireUserAdministrator(deps, viewer)` with the design 2.3
  check order and exact `ForbiddenError` messages. It loads the key and
  creator on every call, checks usability against `deps.clock`, and returns
  the creator's `actorUserId`. `requireAdminUser` remains unchanged.
- Wired users list/get/role/activation/mail-rule operations and template
  permission list/add/remove operations to the async guard before target or
  permission reads. Mail and template rule creation now records
  `actorUserId` in `createdByUserId`. `createUser` and `resendInvitation`
  remain on `requireAdminUser`.
- Made USER_ADMIN grant refusal the first `assertGrantable` branch for
  non-admin-session viewers. Adding USER_ADMIN to an existing key now also
  requires the signed-in ADMIN to be that key's creator.
- Added guard, use-case and GraphQL tests for allowed/refused operations,
  liveness and expiry, last-admin conflicts, no self-restoration, unrelated
  MAIL_READ behavior, grant rules and audit actor IDs.

**Verification** (final source):

- `bunx vitest run packages/application packages/infrastructure/src/graphql`:
  exit 0, 57 files and 733 tests passed;
  `/tmp/user-admin-07-final-vitest.log`.
- `bun run --cwd packages/application typecheck`: exit 0;
  `/tmp/user-admin-07-final-application-typecheck.log`.
- `bun run --cwd packages/infrastructure typecheck`: exit 0;
  `/tmp/user-admin-07-final-infrastructure-typecheck.log`.
- `bunx biome check packages/application/src packages/infrastructure/src/graphql`:
  exit 0, 172 files checked;
  `/tmp/user-admin-07-final-biome.log`.
- `sh -c 'grep -n requireAdminUser packages/application/src/usecases/*.ts | grep -v test'`:
  exit 0; only the guard definition, `users.ts` createUser and
  `invitations.ts` remain;
  `/tmp/user-admin-07-final-guard-scan.log`.
- Assigned TypeScript line-count command: exit 0; all seven files are below
  1000 lines;
  `/tmp/user-admin-07-final-line-count.log`.
- Earlier Biome formatting diagnostics were fixed by formatting only the
  four reported changed files; the final Biome gate above passed.

**Downstream**: plan 08 owns the combined-tree gates, plan status and progress
index reconciliation, and final plan archival.

### Session: 2026-10-08 orchestrator completion
The riela workflow accepted plans 01, 02, 03, 05 and 07 through its reviews; it stopped with loopNotConverging because its implementation-progress-check gate never accepted plan 04 (web tests 302/302) or the documentation-only plan 06. The orchestrator ran the missing independent Opus review: 04 and 06 APPROVED with minor notes N1-N4 (aria-describedby for the USER_ADMIN description, README optional --domain, creator-only grant on existing keys, domains listing), fixed by GPT-6 Luna. Final gate (plan 08): mise run lint exit 0; bun run test 2055 package + 302 web tests; build-web exit 0; Worker dry run exit 0; largest TypeScript file 998 lines. Deployed to https://mail.tacoserve.online with migration 0017; Capability enum includes USER_ADMIN.
