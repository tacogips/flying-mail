# USER_ADMIN API-Key Capability and Event-Type Subscription Filter

Status: Accepted for implementation (2026-10-08).
Scope: Part A adds a `USER_ADMIN` API-key capability, so a key created by a
signed-in admin can manage users from the API and the CLI. Part B adds an
optional server-side event-type filter to the `mailEvents` subscription and
`flying-mail watch --type`.

Related documents:

- `design-api-keys-and-permissions.md`: capabilities, scopes, `Viewer`.
- `design-user-mail-permissions.md`: roles, rules, last-active-admin
  invariant.
- `design-security-model.md` section 9b: the rationale for `USER_ADMIN`.
- `design-realtime-push.md` sections 5.1, 5.2, 6.4, 10.4 and D15: the
  `MailEventScope.types` filter.
- `command.md`: the `user` command group and `watch --type`.

Defaults that are applied but still need user confirmation are in
`design-docs/user-qa/pending-user-admin.md`.

---

## 1. Baseline (checked against the code at `f993bab`)

- Every user-management use case calls `requireAdminUser(viewer)`, which
  accepts only `viewer.kind === "USER" && role === ADMIN`. These are
  `packages/application/src/usecases/users.ts` (list, get, create, set role,
  set active, add and remove mail permission) and `invitations.ts`
  (`resendInvitation`). `user-template-permissions.ts` has its own private
  copy of the same check (list, add, remove).
- `api_keys.created_by_user_id` is `REFERENCES users(id) ON DELETE SET
  NULL` (migration 0005). `createApiKey` stores the session user's id when
  the caller is a user and `null` when the caller is an API key. The
  bootstrap key stores the first admin's id.
- Viewer resolution (`usecases/auth.ts`) checks only that a key is not
  revoked and not expired. A key's capabilities never depend on its creator.
  So the creator's state is not checked today. The earlier sentence in
  `design-api-keys-and-permissions.md` that said resolution rejects a key
  "whose owning user has been deactivated" was stale. That sentence is
  corrected in the same change.
- `bootstrapAdmin` grants `Object.values(Capability)`, which is every
  capability.
- `assertGrantable` (`usecases/api-keys.ts`) lets an ADMIN user grant
  anything. A key may grant a global capability only if it holds that
  capability itself.
- The `api_key_scopes.capability` CHECK was last rebuilt in migration
  `0012_remove_calendar.sql`. The latest migration is `0016_mail_events.sql`.
- The GraphQL enum is named `Capability` (not `ApiKeyCapability`). The
  repositories live in `packages/adapter/src/repositories`, and migration
  tests live in `packages/adapter/src/migrations/*.test.ts`.

## 2. Part A: the `USER_ADMIN` capability

### 2.1 Capability definition

- `Capability.UserAdmin = "USER_ADMIN"` is added to the domain enum
  (`packages/domain/src/entities/api-key.ts`) and to the GraphQL `Capability`
  enum. The GraphQL enum gets this description: "Manage users (list, roles,
  activation, mail and template rules) while the key's creator is an active
  ADMIN. Never creates or invites users."
- It is a member of `GLOBAL_CAPABILITIES`. `createApiKeyScope` therefore
  stores it in canonical form (`domainId: null`, `addressPattern: "*"`), and
  domain and address are ignored.
- **It is never checked by scope membership alone.** `authorizesGlobal`
  (`policies/authorization.ts`) returns `false` for `Capability.UserAdmin`
  for every viewer. `requireGlobalCapability(viewer, USER_ADMIN)` therefore
  always throws `FORBIDDEN`, so a later caller cannot accidentally skip the
  liveness check. The only accepting path is the guard in 2.3.
- Because the scope is stored with `domainId: null`, a key holding it sees
  the domain catalogue through `domains`. This is the same existing
  behavior as `DOMAIN_ADMIN` and `KEY_ADMIN` (`visibleDomains`), and the CLI
  needs it to resolve `--domain` and to show rule domains. It grants no mail
  access.

### 2.2 Authorized operations

| Operation | ADMIN session | Live `USER_ADMIN` key | Any other key |
|-----------|---------------|-----------------------|---------------|
| `users`, `user(id)` (including `User.permissions`, `User.templatePermissions`) | yes | yes | `FORBIDDEN` |
| `setUserRole` | yes | yes | `FORBIDDEN` |
| `setUserActive` (activate and deactivate) | yes | yes | `FORBIDDEN` |
| `addUserMailPermission`, `removeUserMailPermission` | yes | yes | `FORBIDDEN` |
| `addUserTemplatePermission`, `removeUserTemplatePermission` | yes | yes | `FORBIDDEN` |
| `createUser` | yes | **`FORBIDDEN`** | `FORBIDDEN` |
| `resendInvitation` | yes | **`FORBIDDEN`** | `FORBIDDEN` |

`USER_ADMIN` grants nothing else: no mail, domain, key or template-content
operations, and no realtime delivery. `createUser` and `resendInvitation`
keep calling the unchanged `requireAdminUser` (session only), because an
invitation mails a sign-in link to an address the caller chooses.

### 2.3 The user-administration guard

New function in `packages/application/src/usecases/auth-guards.ts`:

```
requireUserAdministrator(deps, viewer): Promise<{ actorUserId: UserId }>
```

The checks run in this order, and the first failure throws
`ForbiddenError`:

1. A `USER` viewer with `role === ADMIN` returns
   `{ actorUserId: viewer.userId }`. Any other `USER` viewer throws.
2. An `API_KEY` viewer without a `USER_ADMIN` scope throws: "This API key
   lacks the USER_ADMIN capability".
3. The guard loads the key with `apiKeyRepository.findById(viewer.apiKeyId)`.
   It throws if the key is missing or `isApiKeyUsable` is false. This
   catches a revocation that happens between resolution and use.
4. `createdByUserId === null` (a key created by a key, or a creator who was
   deleted and set to NULL) throws: "USER_ADMIN is inactive: this key has no
   creating admin".
5. The guard loads the creator with `userRepository.findById`. It throws if
   the creator is missing, `!isUserActive(creator)`, or
   `creator.role !== ADMIN`: "USER_ADMIN is inactive: the admin who created
   this key is no longer an active ADMIN".
6. Otherwise it returns `{ actorUserId: creator.id }`.

This runs on **every** call. Nothing is cached, so demoting, deactivating or
deleting the creator takes effect on the key's next request. The key's
other scopes are unaffected, which matches the existing no-inheritance rule.

The use cases change as follows:

- `users.ts`: list, get, set role, set active, and add and remove mail
  permission call `await requireUserAdministrator(deps, viewer)` instead of
  `requireAdminUser`. `addUserMailPermission` writes
  `createdByUserId: actorUserId`.
- `user-template-permissions.ts`: its private `requireAdminUser` is deleted.
  List, add and remove call `requireUserAdministrator`, and add writes
  `createdByUserId: actorUserId`.
- `createUser` and `invitations.ts` (`resendInvitation`) are unchanged.
- Use-case signatures and GraphQL resolvers are unchanged. The guard needs
  only `deps`, which every factory already has.

### 2.4 Invariants through the API path

- **Last active admin.** The existing `countActiveAdmins` checks in
  `setUserRole` and `setUserActive` run unchanged for both viewer kinds. A
  key cannot demote or deactivate the last active admin (`CONFLICT`).
- **Demoting or deactivating the creator** is allowed when the
  last-active-admin rule allows it. The key loses `USER_ADMIN` on its next
  request.
- **No self-escalation.**
  - `USER_ADMIN` authorizes no key or scope operation.
  - A key can never grant `USER_ADMIN` (2.5).
  - User role and rule changes never change any key's scopes, because
    there is no inheritance.
  - A key whose creator is no longer an active ADMIN fails at step 5 before
    any write. So it cannot re-promote its own demoted creator.
  - Promoting a different existing user to ADMIN is within `USER_ADMIN`'s
    stated authority. That is the ADMIN-level power the request asks for,
    and an admin granted it deliberately (section 9b of the security
    model).
- **Audit.** Mail and template rules created through a key record the
  key's creator in `created_by_user_id`. That is never `null`, because the
  guard guarantees the creator exists.

### 2.5 Who can grant `USER_ADMIN`

`assertGrantable` in `usecases/api-keys.ts` gets a rule that runs before the
existing global-capability branch:

- If `scope.capability === USER_ADMIN` and the viewer is not an ADMIN
  `USER`, it throws `FORBIDDEN`: "USER_ADMIN can only be granted by a
  signed-in admin". This applies even when the calling key holds
  `KEY_ADMIN` and `USER_ADMIN`.
- `createApiKey` from an ADMIN session may include `USER_ADMIN`. The new
  key stores `createdByUserId = viewer.userId`, so that admin is the
  liveness anchor.
- `addApiKeyScope` with `USER_ADMIN` is allowed only from an ADMIN session
  **and** only when `key.createdByUserId === viewer.userId`. Otherwise it
  throws `FORBIDDEN`: "USER_ADMIN can only be added to a key you created".
  This keeps the liveness anchor equal to the human who granted the
  capability.
- `bootstrapAdmin` grants every capability **except** `USER_ADMIN`. It
  iterates `Object.values(Capability)` filtered by
  `capability !== Capability.UserAdmin`.
- Revoking a key and removing a scope are unchanged. Both only narrow
  access.

### 2.6 Migration `apps/api/migrations/0017_user_admin_capability.sql`

The migration follows the rebuild pattern of migrations 0010 and 0012,
because SQLite cannot alter a CHECK constraint in place:

1. `CREATE TABLE api_key_scopes_new`. Its columns, FKs and defaults are
   identical to the 0012 definition (`api_key_id ... REFERENCES api_keys(id)
   ON DELETE CASCADE`, `domain_id ... REFERENCES domains(id) ON DELETE
   CASCADE`, `address_pattern ... DEFAULT '*'`). The CHECK list is the 0012
   list plus `'USER_ADMIN'`.
2. `INSERT INTO api_key_scopes_new SELECT id, api_key_id, capability,
   domain_id, address_pattern FROM api_key_scopes`, with no filter.
3. `DROP TABLE api_key_scopes`, then
   `ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes`.
4. `CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id)`.

Migrations 0001 to 0016 are not edited. No data is backfilled, and no
existing key gains `USER_ADMIN`.

A new migration test,
`packages/adapter/src/migrations/user-admin-migration.test.ts`, uses the
`remove-calendar-migration.test.ts` harness and checks the following:

- It applies 0001 to 0016 and seeds a key with one scope for each of the 12
  existing capabilities (including a domain-scoped one).
- It applies 0017.
- Every row is preserved byte-for-byte.
- A `USER_ADMIN` row inserts, and an unknown capability is rejected by the
  CHECK.
- `idx_api_key_scopes_key` exists.
- Deleting the key cascades to its scopes, and deleting the domain cascades
  to its domain-scoped scope.

### 2.7 Web: Settings > API keys

- `apps/web/src/api/schema-types.ts`: the `Capability` union gains
  `"USER_ADMIN"`.
- `apps/web/src/lib/scope-format.ts`:
  - `CAPABILITY_LABELS.USER_ADMIN = "Administer users (roles, activation,
    permission rules)"`.
  - `"USER_ADMIN"` is added to the web `GLOBAL_CAPABILITIES`, so the scope
    builder hides the domain and address inputs and `formatScope` renders
    it as "(instance-wide)".
- `apps/web/src/pages/settings/api-keys-page.tsx`: when `USER_ADMIN` is
  selected, the scope builder shows this fixed description: "Lets this key
  list users, change roles, activate or deactivate users and edit their
  mail and template rules. It cannot create or invite users. It works only
  while you remain an active admin." There is no extra confirmation step.
  The page is reached only by an admin session, and the server enforces
  2.5 regardless.
- Settings > Users is unchanged. A test proves it still loads, because its
  queries now go through `requireUserAdministrator`, which accepts the same
  ADMIN sessions as before.
- The web `GLOBAL_CAPABILITIES` list is already missing the `TEMPLATE_*`
  values, which is pre-existing drift. That drift is not changed here.

### 2.8 CLI: the `flying-mail user` group

The new file is `apps/cli/src/commands/user.ts`, registered as `"user"` in
`COMMAND_GROUPS` (`apps/cli/src/main.ts`). It is a separate file because
`commands/index.ts` is already 715 lines.

- **Operands.** `parseArgs` puts every leading non-flag token into
  `command`. So `flying-mail user show alice@example.com` yields
  `command = ["user","show","alice@example.com"]`. The user commands read
  operands as `[...args.command.slice(n), ...args.positionals]`, where `n`
  is 2 for single-word subcommands and 3 for `rule`/`template-rule`
  actions. That way operands work both before and after flags. The
  existing commands' `positionals[0]` behavior is not changed (out of
  scope).
- **`<user>`** is matched against `users { id email }`, first by exact id,
  then by case-insensitive email. No match exits 5 with "User not found:
  <value>".

| Command | GraphQL | Output |
|---------|---------|--------|
| `user list [--json]` | `users` | Table `ID EMAIL NAME ROLE ACTIVE INVITATION`; `--json` prints the array |
| `user show <user> [--json]` | `user(id)` with `permissions { id effect domain { name } addressPattern }` and `templatePermissions { id capability effect }` | Key/value block, then a mail-rule table `ID EFFECT DOMAIN PATTERN` (null domain shown as `*`) and a template-rule table `ID CAPABILITY EFFECT`; `--json` prints the object |
| `user set-role <user> <ADMIN\|MEMBER\|VIEWER>` | `setUserRole` | `Role of <email> is now <ROLE>.` |
| `user activate <user>` / `user deactivate <user>` | `setUserActive(active: true/false)` | `<email> is now active/inactive.` |
| `user rule add <user> --effect ALLOW\|DENY [--domain <name\|id>] --pattern <pattern>` | `addUserMailPermission` | Prints the new rule id |
| `user rule remove <user> <rule-id>` | `removeUserMailPermission` | `Removed rule <id>.` |
| `user template-rule add <user> --capability TEMPLATE_READ\|TEMPLATE_CREATE\|TEMPLATE_UPDATE\|TEMPLATE_DELETE --effect ALLOW\|DENY` | `addUserTemplatePermission` | Prints the rule id |
| `user template-rule remove <user> <rule-id>` | `removeUserTemplatePermission` | `Removed template rule <id>.` |

Validation and error handling:

- Role, effect and capability values are upper-cased and validated before
  any network call. An invalid or missing value exits 2.
- `--domain` is resolved like `watch --domain`, by id first and then by
  name. `--pattern '*'` means every address.
- `rule remove` and `template-rule remove` first load the user's rules. A
  rule id that does not belong to that user exits 5, so a typo cannot
  delete another user's rule.
- **FORBIDDEN.** `FORBIDDEN` exits 4, as `CliGraphQLClient` already does.
  The `user` group re-throws it with the server message plus this hint:
  "User administration needs an API key with USER_ADMIN, created by an
  admin who is still an active ADMIN. Creating and inviting users is only
  available in the web UI."
- `CONFLICT` (last active admin) exits 1 with the server message.
- There are no `user create` or `user invite` commands.

### 2.9 Tests required for Part A

These are application tests using `test-support/viewer-fixtures.ts`
(`admin.test.ts`, `users.test.ts`, `user-template-permissions.test.ts`,
`auth-guards.test.ts`, and an api-keys test). Each operation in 2.2 needs an
allowed case and a refused case:

- An ADMIN session is allowed.
- A live `USER_ADMIN` key is allowed for the seven operation groups.
- A `USER_ADMIN` key is refused for `createUser` and `resendInvitation`.
- A key with every capability except `USER_ADMIN` is refused.
- A MEMBER session is refused.

The liveness and invariant cases are:

- A creator who is demoted, deactivated, or deleted (`createdByUserId:
  null`) causes `FORBIDDEN` on the next call. On the same key, a
  `MAIL_READ` operation still succeeds.
- A key revoked after resolution is refused at guard step 3.
- The last active admin cannot be demoted or deactivated through the key
  (`CONFLICT`).
- A key whose creator was demoted cannot re-promote that creator.
- Rules created through the key carry the creator's id.

The grant cases are:

- An ADMIN session can create a key with `USER_ADMIN`.
- A `KEY_ADMIN` key is refused.
- A key holding both `KEY_ADMIN` and `USER_ADMIN` is refused.
- `addApiKeyScope(USER_ADMIN)` from a different admin is refused, and from
  the creating admin it is allowed.
- The bootstrap key has every capability except `USER_ADMIN`. This updates
  the existing count assertions in `auth.test.ts`, `schema.test.ts`,
  `schema-auth-hardening.test.ts` and `api-key.test.ts`.
- `requireGlobalCapability(viewer, USER_ADMIN)` always throws.

The GraphQL tests (`schema-users.test.ts`) cover:

- A `USER_ADMIN` bearer key performs `users`, `setUserRole` and
  `addUserMailPermission` end to end.
- `createUser` with the same key returns `FORBIDDEN`.
- The `Capability` enum lists `USER_ADMIN`.

The other tests are:

- The migration test (2.6).
- Web: `helpers.test.ts` covers the label and global formatting of
  `USER_ADMIN`, and a page test shows the description when `USER_ADMIN` is
  selected.
- CLI (`cli.test.ts` or a new `user.test.ts`): operand parsing for every
  subcommand, request documents and variables, table and `--json` output,
  usage exit 2, not-found exit 5, and the FORBIDDEN hint with exit 4.

## 3. Part B: the event-type filter

Normative changes are in `design-realtime-push.md` (sections 5.1, 5.2, 6.4,
10.4 and D15). In summary:

- `MailEventScope` (domain entity and GraphQL input) gains `types`. In
  GraphQL it is `types: [MailEventType!]`. In the domain it is the optional
  field `readonly types?: readonly MailEventType[] | null`, where absent
  and `null` both mean all types.
- `null` or omitted means every type, which is today's behavior.
- `coerceScope` (`realtime/executor.ts`) rejects an empty list and any
  `LIVE` entry with `BAD_USER_INPUT` on `scope.types`. It deduplicates the
  rest and sorts it into enum declaration order.
- `matchesScope` (`realtime/drain-helpers.ts`) also requires
  `types === null || types.includes(row.type)`. It treats a missing `types`
  (connection states persisted before this change) as `null`.
- `lastSeq` advances for every row the drain reads, whether matched,
  filtered or unauthorized. `LIVE` is always delivered. Replay therefore
  stays gap-free and duplicate-free.
- `packages/realtime-client` `MailEventStreamOptions.scope` gains
  `types?: readonly string[]`. The web client keeps sending no `types`.
- CLI `watch --type <list>` maps names to enum values (section 10.4). When
  types are given, the cursor key gets the suffix
  `|types=<enum values in declaration order, comma-joined>`. Without `--type`, the key is unchanged, so
  existing cursors keep working.

## 4. Documents updated by the implementation

- **This document**, plus `design-api-keys-and-permissions.md`,
  `design-security-model.md` (9b), `design-user-mail-permissions.md`
  (Administration), `design-graphql-api.md` (users comments),
  `design-realtime-push.md` and `command.md`. These are updated in this
  design step.
- **`README.md`**: the API section (`USER_ADMIN`, `MailEventScope.types`)
  and the CLI section (`user` group, `watch --type`). The docs plan does
  this.
- **`.agents/skills/flying-mail-deploy/SKILL.md`**: no operator step
  changes. Migration 0017 is applied by the existing "apply pending remote
  D1 migrations" step, and no secret or variable is added. The skill is not
  edited.

## 5. Suggested implementation waves (input to the plan author)

| Wave | Units (parallel within a wave) | Depends on |
|------|--------------------------------|------------|
| 1 | A1: domain enum, `GLOBAL_CAPABILITIES`, migration 0017 and its test. B1: domain `MailEventScope.types`, `matchesScope`, `coerceScope`, drain tests | - |
| 2 | A2: guard, `authorizesGlobal` exclusion, users and template use cases, `assertGrantable`, bootstrap exclusion, and their tests. A3: GraphQL enum and `schema-users` tests (needs A2 to pass). B2: GraphQL `MailEventScope.types`, `realtime-client` option type | A1 / B1 |
| 3 | A4: web picker. A5: CLI `user` group. B3: CLI `watch --type` and cursor key | A3 / B2 |
| 4 | D: README, then the final verification commands | all |

## 6. Verification

- `mise run lint`.
- `bun run test`: all workspaces, including `apps/web`. The baseline is 2002
  package tests and 299 web tests, plus the new tests.
- `mise run build-web`. Its artifact root is `apps/web/dist`.
- `bun run --cwd apps/api cf:deploy -- --dry-run --outdir
  /tmp/flying-mail-dryrun`.
- No touched file reaches 1000 lines. `schema.graphql.ts` (876) gains about
  5 lines. The CLI `user` group lives in its own file.

## 7. Out of scope

- Making the last-active-admin check atomic. It is read-then-write today
  for sessions too, and `USER_ADMIN` keeps exactly that behavior (see
  risks in `pending-user-admin.md` U4).
- API-key paths for `createUser` and `resendInvitation`. Login stays
  Turnstile-protected.
- Fixing the existing CLI commands that read only `positionals[0]`.
- The web `GLOBAL_CAPABILITIES` drift for `TEMPLATE_*`.
