# User Mail Permissions Implementation Plan

**Status**: Completed
**Design Reference**: `design-docs/specs/design-user-mail-permissions.md`
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

## Design Reference and Scope

Implement `ADMIN`, `MEMBER`, and `VIEWER` interactive-user roles with
domain/address allow and deny rules. Preserve the existing independent,
allow-only API-key scope model while making listing filters retain correlated
domain/address tuples. Add admin-only management through GraphQL and the web
settings UI.

Out of scope: delegating user administration to API keys, changing API-key
ownership semantics, and per-capability customization within a user role.

## Modules

### 1. Domain model and migration

#### `packages/domain/src/entities/user-mail-permission.ts`

```typescript
enum UserPermissionEffect { Allow = "ALLOW", Deny = "DENY" }

interface UserMailPermission {
  readonly id: UserMailPermissionId;
  readonly userId: UserId;
  readonly effect: UserPermissionEffect;
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

interface CreateUserMailPermissionInput extends UserMailPermission {}
function createUserMailPermission(input: CreateUserMailPermissionInput): UserMailPermission;
```

Add `UserRole.Viewer`, the branded permission ID, entity tests, and
`apps/api/migrations/0005_user_mail_permissions.sql` with indexes and enum
constraints.

### 2. Repository and viewer loading

#### `packages/application/src/ports/user-mail-permission-repository.ts`

```typescript
interface UserMailPermissionRepository {
  findById(id: UserMailPermissionId): Promise<UserMailPermission | null>;
  listByUserId(userId: UserId): Promise<readonly UserMailPermission[]>;
  save(permission: UserMailPermission): Promise<void>;
  delete(id: UserMailPermissionId): Promise<void>;
}
```

Implement the SQL adapter, fake repository, dependency composition, and load
current rules when resolving a user viewer.

### 3. Authorization policy and correlated filters

#### `packages/application/src/policies/authorization.ts`

```typescript
interface MailAuthorizationRule {
  readonly effect: "ALLOW" | "DENY";
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
}

function mailAuthorizationRules(
  viewer: Viewer,
  capability: Capability,
): readonly MailAuthorizationRule[];

function authorizesAnyAddress(
  viewer: Viewer,
  capability: Capability,
  domainId: DomainId,
  addresses: readonly EmailAddress[],
): boolean;
```

Update message repository filter contracts and SQL so each rule's domain and
address pattern remain correlated, denies win per candidate address, viewer
mail mutations fail, and specific unauthorized reads remain `NOT_FOUND`.

### 4. User administration use cases

#### `packages/application/src/usecases/users.ts`

```typescript
interface CreateUserInput { readonly email: string; readonly name: string; readonly role: UserRole }
interface UserWithPermissions { readonly user: User; readonly permissions: readonly UserMailPermission[] }

function createListUsersUseCase(deps: AppDependencies):
  (viewer: Viewer) => Promise<readonly UserWithPermissions[]>;
function createCreateUserUseCase(deps: AppDependencies):
  (viewer: Viewer, input: CreateUserInput) => Promise<UserWithPermissions>;
function createSetUserRoleUseCase(deps: AppDependencies):
  (viewer: Viewer, id: UserId, role: UserRole) => Promise<UserWithPermissions>;
function createSetUserActiveUseCase(deps: AppDependencies):
  (viewer: Viewer, id: UserId, active: boolean) => Promise<UserWithPermissions>;
function createAddUserMailPermissionUseCase(deps: AppDependencies):
  (viewer: Viewer, userId: UserId, input: UserMailPermissionInput) => Promise<UserMailPermission>;
function createRemoveUserMailPermissionUseCase(deps: AppDependencies):
  (viewer: Viewer, id: UserMailPermissionId) => Promise<boolean>;
```

User administration requires an admin user, validates domains/patterns, and
prevents demotion or deactivation of the last active admin.

### 5. GraphQL transport

Add schema types, admin-only queries and mutations, resolvers, loaders, and
schema/resolver tests. `Viewer.capabilities` and user fields must reflect the
new role and effective scope without exposing denied messages.

### 6. Web user settings

Add generated-local schema types/documents, `/settings/users`, navigation,
user creation, role/activation controls, and allow/deny scope editing. Reuse
existing settings and scope formatting patterns and preserve unrelated web
work already present in the worktree.

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Domain model/migration | `packages/domain`, `apps/api/migrations` | COMPLETED | 60 focused tests passed |
| Repository/viewer loading | `packages/application`, `packages/adapter`, `packages/infrastructure` | COMPLETED | 30 adapter/auth tests passed |
| Authorization/filtering | `packages/application`, `packages/adapter` | COMPLETED | 949 repo-wide tests passed |
| User use cases | `packages/application/src/usecases/users.ts` | COMPLETED | 1,107 repo-wide tests passed |
| GraphQL | `packages/infrastructure/src/graphql` | COMPLETED | 1,115 repo-wide tests passed |
| Web settings | `apps/web/src` | COMPLETED | 1,115 repo-wide tests passed |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| Repository/viewer | Domain model | COMPLETED |
| Authorization/filtering | Repository/viewer | COMPLETED |
| User use cases | Repository/viewer, policy | COMPLETED |
| GraphQL | User use cases | COMPLETED |
| Web settings | GraphQL | COMPLETED |

## Tasks

### TASK-001: Domain model and migration

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: Domain permission entity/ID, `VIEWER` role, tests, migration
**Dependencies**: None

**Completion Criteria**:
- [x] Permission invariants and role enum implemented
- [x] Migration upgrades existing databases safely
- [x] Domain and migration tests pass

### TASK-002: Repository and viewer integration

**Status**: Completed
**Parallelizable**: No
**Deliverables**: Port, SQL/fake adapters, dependencies, viewer rule loading
**Dependencies**: TASK-001

**Completion Criteria**:
- [x] Rules persist and load by user
- [x] Every session request receives current permissions
- [x] Adapter and auth tests pass

### TASK-003: Authorization and safe query filtering

**Status**: Completed
**Parallelizable**: No
**Deliverables**: Policy rules, repository contract/SQL, authorization tests
**Dependencies**: TASK-002

**Completion Criteria**:
- [x] Role matrix and deny precedence implemented
- [x] Domain/address tuples cannot form a scope cross-product
- [x] List, direct-read, send, manage, and file-link tests pass

### TASK-004: User administration use cases

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `users.ts`, `UseCases` wiring, tests
**Dependencies**: TASK-002, TASK-003

**Completion Criteria**:
- [x] Admin can create/manage users and rules
- [x] Non-admin and API-key callers are rejected
- [x] Last-active-admin invariant is tested

### TASK-005: GraphQL API

**Status**: Completed
**Parallelizable**: No
**Deliverables**: Schema, resolvers, loaders, transport tests
**Dependencies**: TASK-004

**Completion Criteria**:
- [x] User queries and mutations are exposed
- [x] Inputs and outputs preserve rule scope tuples
- [x] GraphQL schema and resolver tests pass

### TASK-006: Web settings UI

**Status**: Completed
**Parallelizable**: No
**Deliverables**: Users settings page, API documents/types, navigation, tests
**Dependencies**: TASK-005

**Completion Criteria**:
- [x] Admin can manage roles, activation, allows, and denies
- [x] Domain and exact-address assignments are supported
- [x] Existing dirty-worktree edits are preserved

### TASK-007: Full verification and documentation reconciliation

**Status**: Completed
**Parallelizable**: No
**Deliverables**: Repository-wide lint, typecheck, test, final spec consistency
**Dependencies**: TASK-006

**Completion Criteria**:
- [x] Biome passes
- [x] Typecheck passes
- [x] Full test suite passes
- [x] Design, GraphQL, and web documents match implementation

## Completion Criteria

- [x] All seven tasks completed
- [x] API keys retain domain/address scoping
- [x] All three user roles and explicit admin denies work end to end
- [x] No touched TypeScript source file reaches 1000 lines
- [x] Full repository checks pass

## Progress Log

### Session: 2026-08-23
**Tasks Completed**: TASK-001
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Added the VIEWER role, permission entity/ID, and populated-safe SQLite migration. Independent verification passed Biome, typecheck, formatting, and 1,059 tests; TypeScript review passed. Unrelated web changes remain preserved.

### Session: 2026-08-23 (2)
**Tasks Completed**: TASK-002
**Tasks In Progress**: None
**Blockers**: None
**Notes**: TASK-002 was already implemented in the worktree (port, SQL adapter with an upsert-on-conflict `save`, adapter test, fake repository, composition wiring, and viewer permission loading in `createResolveViewerFromTokenUseCase`). Verified rather than re-implemented: ran the adapter and auth test files directly (30 pass, 0 fail) and Biome check on all seven touched/related files (clean, no fixes). Marked Completed without code changes.

### Session: 2026-08-23/24 (3)
**Tasks Completed**: TASK-003
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented `MailAuthorizationRule`/`MailPermissionFilter` and `mailAuthorizationRules`/`mailPermissionListFilter`/`mailPermissionFilterAuthorizesAnyAddress` in `packages/application/src/policies/authorization.ts`, rewriting `authorizesAnyAddress`'s USER branch for deny-wins semantics per the design doc's five-step order (DENY always rejects; ADMIN baseline; MEMBER/VIEWER require ALLOW; VIEWER limited to MAIL_READ/FILE_LINK; global capabilities untouched). `readableAddressPatterns`/`scopedDomainIds` were deliberately left unchanged (still `null` for USER viewers) since USER scoping now flows entirely through the new `mailPermissionFilter` field, independent of the API-key `allowedPatterns`/`domainIds` mechanism.

Added a new required `mailPermissionFilter: MailPermissionFilter | null` field to `MessageListFilter` and `MessageEventListFilter`, and a `buildMailPermissionFilterCondition` SQL builder in `message-repository-queries.ts` that correlates each rule's own `(domainId, addressPattern)` pairing per-rule (no flattening into independent lists), wired into both message listing (`collectFilterConditions`) and message-event listing (`message-event-repository.ts`, EXISTS-wrapped through the owning message, mirroring the existing `allowedPatterns` handling). Wired `mailPermissionListFilter` into `messages.ts` and `events.ts`'s filter builders, and added `mailPermissionFilter: null` to the admin-only classification-rule sweep in `rules.ts` (a system operation, not a per-viewer read). Added `viewerViewer`/`buildMailPermissions` test fixtures.

Added a cross-product regression test at the SQL/seeded-DB level (two ALLOW rules on two domains, one wildcard, one exact-address, proving the exact pattern from one domain's rule cannot leak into the other domain) in a new `message-repository-permissions.test.ts`, split out of `message-repository.test.ts` to keep it under the 1000-line target. Added deny-wins, role-matrix, multi-address-message, and NOT_FOUND-not-FORBIDDEN coverage across `authorization.test.ts`, `messages.test.ts`, `events.test.ts`, `drafts.test.ts`, `send.test.ts`, and `event-and-rule-repositories.test.ts`.

Verification: `bunx biome check .` clean (only a pre-existing config-deprecation info notice, unrelated); `bun run --filter '*' typecheck` clean across all 7 packages; full `bun run test` (the project's real `vitest run` command) passes 1,088/1,088 tests (949 root + 139 web). No touched file reaches 1000 lines. Web (Proton-Mail-style redesign) and unrelated pre-existing worktree changes were left untouched.

Deviation from the standard workflow: the ts-coding subagent could not be reliably dispatched in this session (repeated tool-call interruptions), so this task's implementation was done directly via Read/Edit/Bash rather than delegated, with manual Biome/typecheck/test verification after each change in place of the usual ts-review cycle.

### Session: 2026-08-24 (4)
**Tasks Completed**: TASK-004
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Added `packages/application/src/usecases/users.ts` with `createListUsersUseCase`, `createGetUserUseCase`, `createCreateUserUseCase`, `createSetUserRoleUseCase`, `createSetUserActiveUseCase`, `createAddUserMailPermissionUseCase`, and `createRemoveUserMailPermissionUseCase`. Every use case is gated by a `requireAdminUser` assertion (`asserts viewer is Extract<Viewer, {kind: "USER"}>`) that requires `viewer.kind === "USER" && viewer.role === UserRole.Admin` -- deliberately not routed through `requireGlobalCapability`/`Capability`, so an API key can never administer users even while holding `KEY_ADMIN`, per the design doc. New users are created with no password (sign in via the existing passwordless flow). The last-active-admin invariant is enforced by `countActiveAdmins` (reads `userRepository.list()` fresh on every check, never cached) inside `setUserRole`/`setUserActive`: demoting or deactivating the sole active admin throws `ConflictError`; demoting/deactivating a non-admin, an already-inactive admin, or one of two-or-more active admins all succeed; reactivation is never blocked. Adding a mailbox permission (including a self-targeted DENY) never touches this invariant, since it does not change role or active state. Wired all seven functions into `packages/application/src/usecases.ts`'s `UseCases` interface and `createUseCases`.

Added `packages/application/src/usecases/users.test.ts` (19 tests) covering: admin-only gating (MEMBER, VIEWER, and an API key holding `KEY_ADMIN` are all rejected with `ForbiddenError`); user creation (no stored password/passwordHash field, duplicate-email `ConflictError`, malformed-email `BadUserInputError`); the last-active-admin invariant across both `setUserRole` and `setUserActive` (sole admin blocked, two-admin case succeeds, non-admin/inactive-admin/reactivation never blocked); and mail-permission add/remove (admin-to-self DENY succeeds without affecting admin status, unknown user/domain `NotFoundError`, malformed address pattern `BadUserInputError`, non-admin rejected, remove-then-remove-again `NotFoundError`).

Verification: `bunx biome check .` clean (only the same pre-existing config-deprecation info notice); `bun run --filter '*' typecheck` clean across all 7 packages; full `bun run test` passes 1,107/1,107 tests (968 root + 139 web). `users.ts` (251 lines) and `users.test.ts` (389 lines) are both well under the 1000-line target.

Continued deviation: as in the TASK-003 session, the ts-coding subagent spawn was unreliable, and a background-completing spawn independently rewrote `users.ts` while this session was writing its own version concurrently (same file, different implementations of the same interface). Resolved by re-reading the file's actual on-disk state before every edit and adopting the background version (verified correct and complete) rather than overwriting it, adding only the one function (`createGetUserUseCase`) it was missing and updating the test file to match its `UserPermissionEffect`-enum-typed `UserMailPermissionInput.effect` field instead of the string-literal-union shape this session had originally used.

### Session: 2026-08-24 (5)
**Tasks Completed**: TASK-005
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Extended `packages/infrastructure/src/graphql/schema.graphql.ts` with `VIEWER` on `enum UserRole`, `enum UserPermissionEffect { ALLOW DENY }`, `type UserMailPermission` (id, effect, domain, addressPattern, createdByUserId, createdAt), and extended `type User` with `active: Boolean!` and `permissions: [UserMailPermission!]!`. Added admin-only `Query.users`/`Query.user(id)` and `Mutation.createUser`/`setUserRole`/`setUserActive`/`addUserMailPermission`/`removeUserMailPermission`, plus `input CreateUserInput`/`UserMailPermissionInput`.

Added a `permissionsByUser` batch loader in `loaders.ts` (the port has no batch method, so it issues one point lookup per key via `Promise.all`, still coalesced into the request's microtask batch). Added `userResolvers` (`active` computed via `isUserActive`; `permissions` loader-based, discarding the use case's bundled value the same way `ApiKey.scopes` already does) and `userMailPermissionResolvers` (`domain` resolved via the existing `domainById` loader) in `resolvers/types.ts`, wired into `schema.ts`. Query/mutation resolvers in `query.ts`/`mutation.ts` delegate straight to the `users.ts` use cases and return `.user`/`.map(entry => entry.user)`, letting the loader re-fetch `permissions` lazily rather than trusting a bundled shape -- consistent with the existing `ApiKey`/`scopes` pattern. Fixed `helpers.ts`'s `viewerCapabilities`, which previously treated every non-admin `USER` viewer (MEMBER and VIEWER alike) as holding the full mail capability set; it now reports `[MAIL_READ, FILE_LINK]` for `VIEWER` and the full four-capability set for `MEMBER`, mirroring `policies/authorization.ts`'s `roleGrantsCapability`.

Extracted the shared end-to-end GraphQL test harness (`ExecutionResult`, `errorCodes`, `GraphQLHarness`, `createGraphQLHarness`, the yoga/schema singleton) out of `schema.test.ts` into a new `graphql-test-support.ts`, since `schema.test.ts` was already at 856 lines and a full admin-mutations suite would have pushed it over 1000; `schema.test.ts` itself now imports from the shared module with no behavior change (all 30 of its existing tests still pass). Added `schema-users.test.ts` (7 tests) exercising the real request path end-to-end: admin-only gating (`FORBIDDEN` for MEMBER, VIEWER, and an API key holding `KEY_ADMIN` -- user administration is deliberately outside the API-key scope system); user creation and duplicate-email `CONFLICT`; a nonexistent id reading as `null`; the last-active-admin invariant across `setUserRole`/`setUserActive` (had to persist a real `User` row for `adminViewer()`'s synthetic default id via a `seedCallingAdmin` helper, since the invariant counts real `userRepository` rows and the caller's own virtual session does not count on its own); `addUserMailPermission`/`removeUserMailPermission` round-tripping two independently-scoped `(effect, domainId, addressPattern)` tuples on the same user without conflation (proving no cross-product at the transport layer too); and an admin's self-targeted mailbox `DENY` leaving its role/active state untouched.

Verification: `bunx biome check .` clean (only the same pre-existing config-deprecation info notice); `bun run --filter '*' typecheck` clean across all 7 packages; full `bun run test` passes 1,115/1,115 tests (976 root + 139 web). All touched files are well under 1000 lines (`schema.graphql.ts` 730, `mutation.ts` 734, `schema.test.ts` 790).

Same operational pattern continued: a background-completing ts-coding spawn independently wrote its own version of `schema-users.test.ts` (and, transiently, an alternate `users.ts` before that) while this session worked concurrently. The background version of `schema-users.test.ts` was more polished than a first draft would have been, so it was adopted, but had one factually-wrong test: it assumed the synthetic `adminViewer()` caller already counted as a persisted admin for the last-active-admin invariant, when the invariant only counts real `userRepository` rows. Fixed by adding a `seedCallingAdmin` helper and restructuring that one test's sequence of assertions so each "sole admin" claim is checked against whichever user is actually the sole persisted active admin at that point -- rather than reverting to a from-scratch rewrite. The file was re-read from disk before every edit throughout, since several rounds of concurrent background writes landed mid-session.

### Session: 2026-08-24 (6)
**Tasks Completed**: TASK-006
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Extended `apps/web/src/api/schema-types.ts` with `VIEWER` on `UserRole`, a new `UserPermissionEffect` type, and `UserMailPermissionView`/`UserView` interfaces (hand-written mirrors, matching this file's existing no-codegen convention). Added `USERS_QUERY`, `CREATE_USER_MUTATION`, `SET_USER_ROLE_MUTATION`, `SET_USER_ACTIVE_MUTATION`, `ADD_USER_MAIL_PERMISSION_MUTATION`, and `REMOVE_USER_MAIL_PERMISSION_MUTATION` to `apps/web/src/api/documents.ts`.

Added `apps/web/src/pages/settings/users-page.tsx`: a create-user form (email, name, role select over ADMIN/MEMBER/VIEWER, no password field -- the new user signs in through the existing passwordless email link) plus a per-user `UserRow` component (role select, deactivate/reactivate with a `window.confirm` guard on deactivation, and a mail-permission editor listing existing `(effect, domain, addressPattern)` rules with per-rule remove buttons and an add-rule form reusing `isValidAddressPattern` from `lib/scope-format.ts`, the same client-side grammar check `api-keys-page.tsx` already uses). Registered the `/settings/users` route in `app.tsx` behind the existing `AdminGuard` (no new guard needed) and added the "Users" link to the admin-only settings block in `topbar.tsx`, alongside Domains/API keys/Rules. Added the `.user-row`/`.user-row-header`/`.permission-list`/`.permission-row` rules this page needs to `settings.css`, reusing every other existing class (`panel`, `field`, `scope-row`, `scope-list`, `muted`, `danger`, `primary`) rather than introducing new ones where an existing one already fit.

Verification: `bunx biome check .` clean across the whole repo (only the same pre-existing config-deprecation info notice); `bun run --filter '*' typecheck` clean across all 7 packages; full `bun run test` passes 1,115/1,115 tests (976 root + 139 web, unchanged from TASK-005 since no new automated web tests were added -- this repo has no precedent for page-level component tests, not even for the structurally similar `api-keys-page.tsx`, so none were introduced here either). No emojis. All touched files well under 1000 lines (`users-page.tsx` 385 lines). Confirmed via `git status` that every already-staged file from the unrelated Proton-Mail-style web redesign remains staged and untouched; only the files this task actually needed (`documents.ts`, `schema-types.ts`, `app.tsx`, `topbar.tsx`, `settings.css`, plus the new `users-page.tsx`) carry this session's changes.

Same background-spawn-collision pattern one more time: a background-completing spawn independently wrote its own, more idiomatic version of `users-page.tsx` (a `UserRow` sub-component for per-row form-state isolation, `window.confirm` on deactivation, matching new CSS classes already added to `settings.css`) while this session was mid-edit on its own version of the same file, and also briefly reintroduced a duplicate `const UsersPage = lazy(...)` line in `app.tsx` that had to be (and was, by the time of the next check) resolved. Adopted the background version of `users-page.tsx` after verifying it end-to-end (typecheck, biome, full test suite, git status, emoji sweep) rather than reverting to the version this session had written, since it was correct and slightly better-structured.

All seven tasks are now complete. TASK-007 (full verification and documentation reconciliation) remains.

### Session: 2026-08-24 (final)
**Tasks Completed**: TASK-007
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Final verification gate passed from the main session: Biome clean (215 files), typecheck clean across all 7 packages, full test suite 1,115/1,115 (976 root + 139 web), web production build succeeds (users-page chunk emitted), and no source file at or above 1000 lines. Design docs (design-api-keys-and-permissions.md, design-graphql-api.md, design-web-client.md) were reconciled with the implementation during TASK-005/006. Staged, unrelated web-redesign changes verified byte-identical to their pre-feature snapshot. Plan closed as Completed.
