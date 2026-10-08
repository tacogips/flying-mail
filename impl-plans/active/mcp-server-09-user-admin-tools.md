# MCP Server 09: USER_ADMIN Tools

**Status**: Not Started
**Plan ID**: mcp-server-09-user-admin-tools
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 4.1, 4.4 (rows 23-27), 4.5; design-docs/specs/design-user-admin-capability.md 2.2-2.4; design-docs/specs/design-security-model.md 9b
**Created**: 2026-10-08

## Intent and context

This plan fills the stub file
`packages/infrastructure/src/mcp/tools/user-admin-tools.ts` with five tools.
They are visible **only** to keys holding a USER_ADMIN scope:

- `list_users`
- `set_user_role`
- `set_user_active`
- `add_mail_permission`
- `remove_mail_permission`

Every call goes through the user use cases, which call
`requireUserAdministrator`. That guard re-checks creator liveness on every
call, so a key whose creating admin is demoted or deactivated gets
FORBIDDEN.

**No tool may create users, resend invitations or log in.** `createUser`,
`resendInvitation`, `requestEmailAuth` and `verifyEmailAuthToken` must not
be referenced anywhere in this file.

Use cases (`packages/application/src/usecases/users.ts`):

- `listUsers(viewer) -> UserWithPermissions[]`, where `{ user: User, permissions: UserMailPermission[] }`;
- `setUserRole(viewer, id, role: UserRole)`;
- `setUserActive(viewer, id, active)`;
- `addUserMailPermission(viewer, userId, { effect: UserPermissionEffect, domainId: DomainId | null, addressPattern: string }) -> UserMailPermission`;
- `removeUserMailPermission(viewer, id) -> boolean`.

Contracts consumed (plan 03): `defineTool`, `InferArgs` and
`createMcpTestHarness`. Tool inputs are `FieldSpecMap` object literals
passed as `defineTool({ input })`. `tool-schema.ts` exports `FieldSpec`,
`FieldSpecMap` and `InferArgs`; there is no field helper. Example
(prose): `user_id: { kind: "string", format: "id", required: true,
maxLength: 128, description: "..." }`.

## Non-goals

- No user-template-permission tools, no `get_user`, no API-key tools.
- No edits outside the writePaths.
- Do not reimplement the liveness or last-admin checks.

## writePaths

- packages/infrastructure/src/mcp/tools/user-admin-tools.ts
- packages/infrastructure/src/mcp/tools/user-admin-tools.test.ts (new)
- impl-plans/active/mcp-server-09-user-admin-tools.md (progress log only)

sharedPaths: none.

## Tool specifications (export `USER_ADMIN_TOOLS` in this order; all visible with USER_ADMIN)

Annotations are R/D/I/OpenWorld.

- **`list_users`** (T/F/T/F). No inputs.
  - **Structured:** `{ users: UserView[] }`.
- **`set_user_role`** (F/T/T/F).
  - **Inputs:** `user_id` (required), `role` (enum `ADMIN` or `MEMBER`,
    required).
  - **Structured:** `{ user: UserView }`.
- **`set_user_active`** (F/T/T/F).
  - **Inputs:** `user_id` (required), `active` (boolean, required).
  - **Structured:** `{ user: UserView }`.
- **`add_mail_permission`** (F/F/F/F).
  - **Inputs:**
    - `user_id` (required);
    - `effect` (enum `ALLOW` or `DENY`, required);
    - `domain_id` (id, optional; omitted means `null`);
    - `address_pattern` (string, max 320, required).
  - **Structured:** `{ permission: { id, user_id, effect, domain_id, address_pattern } }`.
- **`remove_mail_permission`** (F/T/T/F).
  - **Input:** `permission_id` (required).
  - **Structured:** `{ removed: boolean, permission_id }`.

**`UserView`** is
`{ id, email, name, role, active: deactivatedAt === null, invitation_accepted: invitationAcceptedAt !== null, permissions: [{ id, effect, domain_id, address_pattern }] }`.

These are admin-managed records, not mail, so `containsUntrusted: false`.

**Summaries:**

- `Listed <n> users.`
- `User <id> role set to <role>.`
- `User <id> active set to <bool>.`
- `Added <effect> permission <id> for user <id>.`
- `Removed permission <id>.`

## Pitfalls

- Brand ids with `createUserId`, `createUserMailPermissionId` and
  `createDomainId`.
- Map the role and effect enums to the domain enums (`UserRole`,
  `UserPermissionEffect`). Do not compare strings ad hoc.
- An address pattern of `*` is passed through as-is. The use case parses
  it.
- Never catch FORBIDDEN or CONFLICT (last-active-admin). They must surface
  as `isError` with their code.
- Keep the file under 300 lines.

## Tests (`user-admin-tools.test.ts`, using `createMcpTestHarness`)

`issueKey` makes a key whose creator is an active ADMIN. A second MEMBER
user is the target. Each test case is `situation -> expected outcome`.

- USER_ADMIN key: `listTools` -> exactly the 5 USER_ADMIN tools, and no
  mail tools.
- A MAIL_READ key: `listTools` -> none of the 5. Calling `list_users` ->
  `-32602`.
- `list_users` -> includes both users, with their permissions arrays.
- `set_user_role` MEMBER to ADMIN -> the role is ADMIN.
- Demoting the last active admin -> `isError` CONFLICT (or the code the use
  case raises; assert the existing behavior).
- `set_user_active false` on the member -> `active` is false.
- `add_mail_permission ALLOW *@example.com` -> a permission is created.
  `remove_mail_permission` -> `removed` is true.
- Liveness: set the key creator's role to MEMBER in `fake.stores.users`,
  then `list_users` -> `isError` FORBIDDEN.
- Deactivated creator -> FORBIDDEN.
- The registry name set has no match for
  `/create_user|invit|login|resend/`. Assert this over
  `MCP_TOOL_REGISTRY.tools`.
- `grep`-equivalent assertion: the source text of `user-admin-tools.ts`
  (read via `fs`) contains no `createUser`, `resendInvitation`,
  `requestEmailAuth` or `verifyEmailAuthToken`.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/tools/user-admin-tools.test.ts 2>&1 | tee /tmp/mcp-server-09-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bun run typecheck 2>&1 | tee /tmp/mcp-server-09-typecheck.log`
   - Expected: exit 0. Cross-plan transients are recorded and re-run.
3. `bunx biome check packages/infrastructure/src/mcp/tools/user-admin-tools.ts packages/infrastructure/src/mcp/tools/user-admin-tools.test.ts`
   - Expected: exit 0.
4. `grep -nE "createUser|resendInvitation|requestEmailAuth|verifyEmailAuthToken" packages/infrastructure/src/mcp/tools/user-admin-tools.ts`
   - Expected: no output.

## Done criteria

- [ ] `USER_ADMIN_TOOLS` has exactly the 5 tools, as specified.
- [ ] Verification steps 1-4 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- Put evidence under `tmp/mcp-server-s316/mcp-server-09-user-admin-tools/<attempt>/`.

## Progress Log

(empty)
