# Mail Templates Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-mail-templates.md
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-mail-templates.md

### Summary

Stored, variable-driven mail templates written in Eta, sent through the
existing send pipeline after a server-side render. Template create/update/
delete are separately grantable capabilities for both users and API keys.

### Scope

**Included**: domain entities, Eta-parse-based safe renderer, repositories and
migration, use cases, GraphQL surface, and the web client's pick/fill/review/
send flow plus admin pages.

**Excluded**: control flow inside templates, per-mailbox template ownership,
template-attached attachments, CLI parity.

---

## Modules

### 1. Domain

#### packages/domain/src/value-objects/ids.ts

**Status**: DONE

Adds `MailTemplateId` and `UserTemplatePermissionId` brands and their
`create*Id` constructors. A `TemplateVariableId` was planned and dropped: the
repository rewrites a template's whole variable set on every save, so a
variable row needs no identity beyond its `(template_id, key)` slot.

**Checklist**:
- [x] Two brands and constructors
- [x] Cases added to ids.test.ts

#### packages/domain/src/entities/api-key.ts

**Status**: DONE

Adds `Capability.TemplateRead|TemplateCreate|TemplateUpdate|TemplateDelete`
plus `TEMPLATE_CAPABILITIES` and `isTemplateCapability`. Template capabilities
are address-independent, so `createApiKeyScope` canonicalizes their
`domainId`/`addressPattern` the way it already does for global capabilities;
they are deliberately **not** added to `GLOBAL_CAPABILITIES`.

**Checklist**:
- [x] Enum members and helpers
- [x] Canonicalization in createApiKeyScope
- [x] Tests for canonicalization and non-globalness

#### packages/domain/src/entities/mail-template.ts

**Status**: DONE

```typescript
enum TemplateVariableType { TEXT, MULTILINE_TEXT, NUMBER, BOOLEAN, DATE, EMAIL }
interface TemplateVariable { key; label; type; required; defaultValue; description }
interface MailTemplate { id; name; description; subject; textBody; htmlBody;
  from; to; cc; bcc; variables; createdByUserId; createdAt; updatedAt }
function createMailTemplate(input): MailTemplate
function updateMailTemplate(template, patch, now): MailTemplate
```

**Checklist**:
- [x] Entity + factory validation (name, subject, at least one body, unique keys)
- [x] Unit tests

#### packages/domain/src/entities/template-values.ts

**Status**: DONE

Pure coercion and validation: `coerceTemplateValue`,
`validateTemplateValues(variables, values) -> TemplateValidation`,
`buildRenderData(variables, values)`. No Eta dependency.

**Checklist**:
- [x] Per-type coercion
- [x] missing/invalid/unknown reporting
- [x] Unit tests

#### packages/domain/src/entities/user-template-permission.ts

**Status**: DONE

`UserTemplatePermission`, `createUserTemplatePermission`, and
`resolveUserTemplateCapability(role, rules, capability)` implementing
DENY > ALLOW > role default.

**Checklist**:
- [x] Entity + resolution function
- [x] Unit tests covering every role/effect combination

### 2. Application

#### packages/application/src/ports/template-renderer.ts

**Status**: DONE

```typescript
interface TemplateRenderer {
  referencedVariables(source: string): readonly string[];
  assertRenderable(source: string, field: string): void;
  render(source: string, data, options: { escape: "html" | "none" }): string;
}
```

#### packages/application/src/ports/mail-template-repository.ts
#### packages/application/src/ports/user-template-permission-repository.ts

**Status**: DONE

#### packages/application/src/policies/authorization.ts

**Status**: DONE

`authorizesTemplateCapability(viewer, capability)` and
`requireTemplateCapability`. Users resolve through role default + rules; keys
through scopes.

#### packages/application/src/usecases/mail-templates.ts (+ -render.ts, -send.ts)

**Status**: DONE

list/get/create/update/delete/validateValues/preview/sendTemplatedMessage and
add/removeUserTemplatePermission.

**Checklist**:
- [x] Write-time reference check against declared variables
- [x] sendTemplatedMessage delegates to the existing send path
- [x] Fakes + use case tests

### 3. Adapter

#### packages/adapter/src/templates/eta-renderer.ts

**Status**: DONE

Eta `parse()` for tokenization, own interpreter for the restricted grammar.
No `new Function` anywhere on the request path.

**Checklist**:
- [x] AST unescaping of literal spans
- [x] path/literal/`||`/`??` evaluation
- [x] `<% %>` and unsupported expressions rejected with a field-named error
- [x] HTML escaping mode
- [x] Unit tests including a no-eval assertion

#### packages/adapter/src/repositories/mail-template-repository.ts
#### packages/adapter/src/repositories/user-template-permission-repository.ts
#### apps/api/migrations/0007_mail_templates.sql

**Status**: DONE

### 4. Infrastructure (GraphQL)

**Status**: DONE

SDL additions, query/mutation/type resolvers, `Viewer.capabilities` extension,
composition wiring in build-dependencies.ts.

### 5. Web client

**Status**: DONE

- `api/documents.ts`, `api/schema-types.ts` additions
- `components/template-send-panel.tsx` (pick -> fill -> review -> send)
- `pages/settings/templates-page.tsx`
- Users page: per-user template permission rows
- Store: template loading, validation, preview, templated send

---

## Subtasks

### TASK-001: Domain entities and capabilities
**Status**: Completed
**Parallelizable**: Yes

### TASK-002: Eta renderer adapter
**Status**: Completed
**Parallelizable**: Yes

### TASK-003: Application ports, policies, use cases (depends on TASK-001)
**Status**: Completed
**Parallelizable**: No

### TASK-004: SQL repositories and migration (depends on TASK-001, TASK-003)
**Status**: Completed
**Parallelizable**: No

### TASK-005: GraphQL surface (depends on TASK-003)
**Status**: Completed
**Parallelizable**: No

### TASK-006: Web client (depends on TASK-005)
**Status**: Completed
**Parallelizable**: No

---

## Progress Log

### Session: 2026-08-24
Design document written; plan created; every task implemented.

**Delivered**:

- Domain: `mail-template.ts`, `template-values.ts`,
  `user-template-permission.ts`, four `Capability` members plus
  `isAddressIndependentCapability`, three new branded ids.
- Adapter: `templates/expression.ts` + `templates/eta-renderer.ts` (Eta's
  parser, own interpreter, no `new Function`), the two SQL repositories, and
  `apps/api/migrations/0007_mail_templates.sql`.
- Application: `template-renderer` / `mail-template-repository` /
  `user-template-permission-repository` ports,
  `authorizesTemplateCapability`, `Viewer.templatePermissions`, and the
  use cases in `mail-templates.ts`, `mail-template-send.ts` and
  `user-template-permissions.ts`.
- GraphQL: `resolvers/templates.ts`, SDL types/inputs/queries/mutations,
  `User.templatePermissions`, template capabilities on
  `Viewer.capabilities`.
- Web: `template-send-panel.tsx` (pick -> fill -> review -> send),
  `settings/templates-page.tsx`, template permission rows on the Users
  page, and `lib/template-form.ts`.

**Tests**: 1250 package tests + 151 web tests pass, including the
`eta-renderer` suite's assertion that rendering succeeds with `Function`
and `eval` disabled -- the property the Cloudflare Workers runtime needs.

**Known non-template blockers** (pre-existing, from the in-flight calendar
work, not introduced here) -- all cleared by the calendar implementation and
re-verified 2026-08-24:

- [x] `packages/infrastructure/src/composition/build-dependencies.ts` wires
      `icsCodec`, `caldavClient`, `credentialCipher` and the three calendar
      repositories; every workspace typechecks.
- [x] `packages/adapter/src/migrations/calendar-migration.test.ts`:
      `calendarMigration()` now drives a 0001..0006-only apply, which is what
      the api_key_scopes losslessness test actually claims to check.
- [x] `packages/application/src/usecases/caldav.ts`: `discovery` is typed
      `CaldavDiscovery`; `noImplicitAnyLet` is clean.
- [x] `bun run lint:biome` and `bun run format:check` both exit 0 over all
      316 files.

## Regression notice: web integration lost 2026-08-24 (DEFERRED, not done)

During the calendar work an accidental `git checkout -- .` discarded every
uncommitted modification to tracked files. The mail-templates **new** files
survived (they were untracked); the edits that wired them into shared files
did not, and no recovery path existed (no stash, index copy, reflog entry,
dangling object or APFS snapshot).

Restored by re-derivation from the surviving consumers and migrations, and
covered by the green suite:

- `packages/domain` capability enum (`TEMPLATE_READ/CREATE/UPDATE/DELETE`)
  and `MailTemplateId` / `UserTemplatePermissionId`
- `packages/application` ports on `AppDependencies`, viewer
  `templatePermissions`, `authorizesTemplateCapability` /
  `requireTemplateCapability`, the `UseCases` registry entries, fakes
- `packages/infrastructure` template SDL, `templateQueryResolvers` /
  `templateMutationResolvers` merge, `User.templatePermissions` loader
- `apps/web` `schema-types.ts` template views, `documents.ts` template
  documents, `app-store.ts` template state, `/settings/templates` route and
  topbar link, capability labels in `scope-format.ts`

**Restored 2026-08-24 (round 3), closing the regression:**

- [x] `components/template-send-panel.tsx` is mounted in
      `pages/mailbox-page.tsx` beside `ComposeForm`, opened from the sidebar
      and gated on `TEMPLATE_READ`. The catalogue is fetched on open, so a
      visitor who never sends from a template does not pay for it.
- [x] `pages/settings/users-page.tsx` gained template and calendar rule
      editors over one shared `CapabilityRules` component (both are
      capability + ALLOW/DENY, so two near-copies would only drift). The
      calendar rule's per-owner axis stays API-only; the UI writes
      all-owners rules, which is the common case.
- [x] `components/mailbox-sidebar.{tsx,css}` "From template" entry under
      "New message", hidden without the capability.
- [x] `pages/settings/settings.css` `.settings-actions`; `panel` and `field`
      turned out to be global rules, so nothing else was missing.
- [x] `design-docs/specs/architecture.md` calendar/CalDAV and mail-template
      sections, the D1/R2 storage table, and the supporting-document index.

These are tracked here so the tree does not silently claim to be finished.
Anyone picking this up should treat the reconstructed shared files above as
re-derivation, not as the original author's work, and diff them against
intent before relying on their wording.

### Session: 2026-08-24 (follow-up: SDL size ceiling)

`packages/infrastructure/src/graphql/schema.graphql.ts` had grown past the
repository's 1000-line policy ceiling (730 -> 952 with the template and
calendar surfaces, then 1012 with the explicit mail-address surface). Split
along the same seam `schema-calendar.graphql.ts` already established:

- **Added** `packages/infrastructure/src/graphql/schema-templates.graphql.ts`
  (144 lines): `TemplateVariableType`, `TemplateVariable(Input)`,
  `MailTemplate(Input)`, `TemplateValueInput`, `TemplateValueProblem`,
  `TemplateValidation`, `RenderedTemplate`, `SendTemplatedMessageInput`, and
  `extend type Query` / `extend type Mutation` carrying the four template
  queries and four template mutations. SDL text moved verbatim.
- **Kept** in `schema.graphql.ts`: `TemplateCapability`,
  `UserTemplatePermission(Input)`, `User.templatePermissions` and the two
  permission mutations -- the admin user-management surface, matching the
  convention `schema-calendar.graphql.ts` documents.
- **Updated** `schema.ts` to merge three documents
  (`[typeDefs, calendarTypeDefs, templateTypeDefs]`) and `schema.graphql.ts`'s
  header, which still claimed the contract was a single unsplit SDL string.

`schema.graphql.ts` is now 896 lines; no source file in the repository is at
or above 1000. The change is behaviour-preserving and already covered:
`schema-templates.test.ts` and `schema.test.ts` execute against
`buildGraphQLSchema()`, so a failed `extend` merge would fail them.

**Verification**: `bun run typecheck` (7/7 workspaces, exit 0),
`bun run lint:biome` (326 files, no diagnostics), `bun run test`
(1480 package tests + 183 web tests pass), `bun run --cwd apps/web build`
(exit 0).
