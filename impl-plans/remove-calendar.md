# Remove Calendar Functionality Implementation Plan

**Status**: Completed
**Design Reference**: `design-docs/specs/design-calendar.md` (feature being retired)
**Created**: 2026-09-06
**Last Updated**: 2026-09-06

---

## Design Document Reference

**Source**: `design-docs/specs/design-calendar.md`. This plan reverses that
feature across the domain, application, adapters, GraphQL/HTTP composition,
web client, persistence, tests, configuration comments, and documentation.

### Scope

**Included**: remove calendars, calendar events and recurrence, event mentions
and links, event attachment claims, CalDAV accounts/sync, calendar user
permissions, `CALENDAR_READ`/`CALENDAR_WRITE`, calendar GraphQL operations,
the `/calendar` UI, and their dedicated tests and documentation. Add a forward
migration for deployed databases and verify both fresh and upgraded schemas.

**Preserved boundaries**:

- Mail and the distinct `MessageEvent` audit/activity feature remain.
- Contacts, birthdays, address books, and CardDAV remain. Consequently
  `IsoDate`, `CredentialCipher`, `FLYING_MAIL_CREDENTIAL_KEY`, the CardDAV client,
  vCard codec, and shared credential configuration remain.
- External JMAP/POP3/SMTP accounts continue using the shared credential cipher.
- Generic upload/download, message attachments, file links, and
  `AttachmentKind.Calendar` remain. The latter is the MIME classification for
  `text/calendar` mail attachments, not a calendar ownership relation.
- Historical migrations `0006_calendar.sql` and
  `0008_user_calendar_permissions.sql` remain immutable. A new migration
  removes their live schema so already-deployed databases can upgrade safely.

**Out of scope**: renaming the product, removing generic words such as
"event" where they refer to `MessageEvent` or UI/DOM events, deleting generic
credential secrets, and changing mail, contacts/CardDAV, templates, or
external-mail behavior.

---

## Target Contracts After Removal

### 1. Domain and shared value objects

`packages/domain/src/entities/api-key.ts` retains every non-calendar
capability, and `packages/domain/src/entities/attachment.ts` retains the MIME
kind used by ordinary mail attachments:

```typescript
export enum Capability {
  MailRead = "MAIL_READ",
  MailSend = "MAIL_SEND",
  MailManage = "MAIL_MANAGE",
  FileLink = "FILE_LINK",
  DomainAdmin = "DOMAIN_ADMIN",
  KeyAdmin = "KEY_ADMIN",
  TemplateRead = "TEMPLATE_READ",
  TemplateCreate = "TEMPLATE_CREATE",
  TemplateUpdate = "TEMPLATE_UPDATE",
  TemplateDelete = "TEMPLATE_DELETE",
  ContactRead = "CONTACT_READ",
  ContactWrite = "CONTACT_WRITE",
}

export enum AttachmentKind {
  Image = "IMAGE",
  Document = "DOCUMENT",
  Archive = "ARCHIVE",
  Audio = "AUDIO",
  Video = "VIDEO",
  Calendar = "CALENDAR",
  Other = "OTHER",
}
```

Delete calendar-only ID brands, entities, recurrence/time-zone value objects,
and permission types. Retain `IsoDate` because `Contact.birthday` imports it.

### 2. Application dependency and use-case aggregation

`packages/application/src/dependencies.ts` and
`packages/application/src/usecases.ts` must expose no calendar repository,
CalDAV/ICS, or calendar use-case fields. Shared and retained contracts include:

```typescript
export interface AppDependencies {
  readonly credentialCipher: CredentialCipher;
  readonly addressBookRepository: AddressBookRepository;
  readonly contactRepository: ContactRepository;
  readonly carddavAccountRepository: CarddavAccountRepository;
  readonly externalMailAccountRepository: ExternalMailAccountRepository;
}

export interface UseCases {
  createAttachmentLink(
    viewer: Viewer,
    attachmentId: AttachmentId,
    ttlSeconds?: number,
    maxDownloads?: number | null,
  ): Promise<CreatedFileLink>;
}
```

The attachment-link use case keeps its message-backed authorization path and
removes only event-backed lookup. An unattached staged upload remains
non-downloadable and non-linkable.

### 3. GraphQL and viewer surface

The composed schema excludes the calendar SDL and resolver maps. `User` and
viewer payloads retain mail/template permission fields but expose no calendar
permission field:

```typescript
export interface ViewerView {
  readonly capabilities: readonly string[];
  readonly user: UserView | null;
}
```

No calendar query, mutation, input, enum, object type, loader, or resolver may
remain introspectable.

### 4. Persistence target

Add `apps/api/migrations/0012_remove_calendar.sql`. It drops calendar-owned
tables in foreign-key-safe order, removes calendar permission rows/tables, and
rebuilds `api_key_scopes` without calendar capabilities while preserving all
mail, file-link, domain/key-admin, template, and contact scope rows.
Calendar-owned attachment metadata must be identified before dropping
`event_attachments`; delete only those unowned (`message_id IS NULL`) calendar
attachment rows/file links and their blob objects through an explicit cleanup
step. Never delete message-backed attachments, including `text/calendar`.

---

## Tasks

### TASK-001: Remove calendar domain model and capabilities

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: calendar-only files under
`packages/domain/src/entities/`; `packages/domain/src/entities/api-key.ts`;
`packages/domain/src/value-objects/ids.ts`; calendar-only value objects and
their tests.
**Dependencies**: None

**Description**: Delete `Calendar`, `CalendarEvent`, recurrence expansion,
`CaldavAccount`, and `UserCalendarPermission` code/tests. Remove calendar ID
brands and capability helpers. Delete `TimeZoneId` and recurrence code after
confirming no retained imports. Keep `IsoDate` and generic attachment MIME
classification, updating capability/id tests to assert the reduced surface.

**Completion Criteria**:
- [x] Calendar-only domain modules and exports are absent
- [x] Non-calendar capabilities and ID factories are unchanged
- [x] Contact birthday and `text/calendar` attachment tests remain green

### TASK-002: Remove calendar application ports, policies, and use cases

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `packages/application/src/dependencies.ts`,
`packages/application/src/usecases.ts`, `packages/application/src/ports/`,
`packages/application/src/policies/`, `packages/application/src/usecases/`,
`packages/application/src/test-support/`, and affected tests.
**Dependencies**: TASK-001

**Description**: Delete calendar repositories, CalDAV/ICS ports, use cases,
authorization, fixtures, and fakes. Remove calendar dependency/use-case fields
and user-calendar permission policy wiring. Simplify file-link authorization
to message attachments only while preserving the denial of unattached staged
uploads. Keep `CredentialCipher` and its fake in calendar-neutral test support
because CardDAV and external mail still consume it.

**Completion Criteria**:
- [x] No calendar/CalDAV/ICS application API remains
- [x] Mail, CardDAV/contact, external-mail, and shared cipher contracts compile
- [x] File-link tests cover message attachment success and staged-upload denial

### TASK-003: Remove calendar adapters and package exports

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: calendar/CalDAV/ICS code and tests under
`packages/adapter/src/`; `packages/adapter/package.json`.
**Dependencies**: None

**Description**: Delete calendar repositories/row mappers, ICS codec, CalDAV
HTTP/XML client, migration tests dedicated only to calendar creation, and
their package export. Retain credential cipher, CardDAV, vCard, SQL helpers,
and generic attachment/blob repositories and tests.

**Completion Criteria**:
- [x] Calendar, CalDAV, and ICS adapter imports/exports are absent
- [x] Credential cipher and CardDAV/external-mail adapter tests remain green
- [x] Shared repository and migration-runner coverage is preserved

### TASK-004: Remove backend GraphQL, composition, and event attachment hooks

**Status**: Completed
**Parallelizable**: No
**Deliverables**: `packages/infrastructure/src/graphql/`,
`packages/infrastructure/src/composition/`,
`packages/infrastructure/src/http/attachments.ts`,
`packages/infrastructure/package.json`, `apps/api/src/server.test.ts`.
**Dependencies**: TASK-001, TASK-002, TASK-003

**Description**: Remove calendar SDL, resolvers, loaders, schema composition,
repository/client construction, user calendar-permission fields, and event
attachment download authorization. Preserve message attachment authorization.
Retain credential-key loading/wiring but rewrite CalDAV-only comments and tests
to describe CardDAV/external credentials. Remove only calendar fixtures from
API and GraphQL tests.

**Completion Criteria**:
- [x] Schema introspection exposes no calendar types, fields, or capabilities
- [x] `/api/attachments/:id` still protects message and staged attachments
- [x] CardDAV and external-account unavailable-cipher behavior is unchanged

### TASK-005: Remove the calendar web client and permission controls

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `apps/web/src/pages/calendar-page.tsx`,
`apps/web/src/components/calendar/`, `apps/web/src/api/calendar-*`,
`apps/web/src/store/calendar-*`, `apps/web/src/lib/calendar-dates*`,
`apps/web/src/app.tsx`, `apps/web/src/components/topbar.tsx`,
`apps/web/src/pages/settings/users-page.tsx`, affected schema types/tests.
**Dependencies**: None

**Description**: Delete the route, navigation, calendar UI/API/store/date
helpers, CalDAV settings, and calendar permission editor. Remove stale
calendar-specific comments in retained contact code without changing contact
behavior or layout.

**Completion Criteria**:
- [x] `/calendar` falls through to the existing not-found route
- [x] Navigation and user settings expose no calendar controls
- [x] Contacts/CardDAV pages and shared attachment UI still build and test

### TASK-006: Add forward data/schema removal migration

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `apps/api/migrations/0012_remove_calendar.sql`, migration
tests under `packages/adapter/src/migrations/`, and an operational cleanup path
for calendar-owned blob objects.
**Dependencies**: None

**Description**: Preserve immutable migration history. Before table removal,
capture calendar-only staged attachment IDs/blob keys, delete their file links,
rows, and blobs without touching message-backed attachments. Drop calendar
tables in dependency order. Rebuild `api_key_scopes` with the current
non-calendar capability CHECK and copy rows with calendar scopes filtered out.
Test both a fresh full migration run and upgrade from migration 0011 with
representative mail/template/contact scopes and attachments.

**Completion Criteria**:
- [x] Fresh schema contains no calendar tables or calendar scope values
- [x] Upgrade removes calendar data/scopes and preserves unrelated rows
- [x] Calendar blob cleanup is documented, idempotent, and narrowly targeted
- [x] `PRAGMA foreign_key_check` returns no violations

### TASK-007: Remove calendar documentation and deployment references

**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `README.md`, `apps/api/wrangler.toml`, relevant
`design-docs/` files, and the completed calendar plan/index/progress artifacts
under `impl-plans/`.
**Dependencies**: None

**Description**: Remove active calendar/CalDAV claims, setup instructions, and
obsolete completed plan entries. Retire `design-calendar.md` and the five
calendar implementation plans after preserving this removal plan as the
change record. Update architecture/contact/external-mail wording so the shared
credential key is justified by CardDAV and external mail. Do not remove
historical migration comments or generic `text/calendar` documentation.

**Completion Criteria**:
- [x] User/operator docs advertise no calendar or CalDAV feature
- [x] CardDAV and external credential setup remains accurate
- [x] `README.md` and `PROGRESS.json` have no dangling calendar-plan links

### TASK-008: Audit boundaries and run complete verification

**Status**: Completed
**Parallelizable**: No
**Deliverables**: verification evidence in this plan's progress log.
**Dependencies**: TASK-004, TASK-005, TASK-006, TASK-007

**Description**: Search for calendar terms and classify every remaining hit as
historical migration text, `text/calendar` MIME support, or unrelated language
such as `MessageEvent`/DOM events. Run formatting/lint, maximum-strictness type
checks, root and web tests/build, migration upgrade/fresh-schema tests, and
package export checks. Confirm no touched TypeScript source reaches 1000 lines.

**Completion Criteria**:
- [x] `rg` audit has no unexplained calendar/CalDAV/ICS implementation hit
- [x] `mise run`/package-defined Biome, typecheck, test, and build gates pass
- [x] Mail, contacts/CardDAV, generic attachments/file links, templates, and
      external mail have regression coverage
- [x] No calendar GraphQL operation, route, table, capability, or package
      export remains

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Domain removal | `packages/domain/src/` | COMPLETED | 408 domain tests pass |
| Application removal | `packages/application/src/` | COMPLETED | 454 application tests pass |
| Adapter removal | `packages/adapter/src/` | COMPLETED | 413 adapter tests pass |
| Backend surface | `packages/infrastructure/src/`, `apps/api/src/` | COMPLETED | GraphQL/HTTP pass |
| Web surface | `apps/web/src/` | COMPLETED | 192 web tests/build pass |
| Data migration | `apps/api/migrations/0012_remove_calendar.sql` | COMPLETED | fresh + upgrade pass |
| Documentation/config | `README.md`, `design-docs/`, `impl-plans/`, `wrangler.toml` | COMPLETED | reference audit pass |
| Verification | repository-wide | COMPLETED | all gates pass |

## Dependencies

| Task | Depends On | Status |
|------|------------|--------|
| TASK-001 | None | COMPLETED |
| TASK-002 | TASK-001 | COMPLETED |
| TASK-003 | None | COMPLETED |
| TASK-004 | TASK-001, TASK-002, TASK-003 | COMPLETED |
| TASK-005 | None | COMPLETED |
| TASK-006 | None | COMPLETED |
| TASK-007 | None | COMPLETED |
| TASK-008 | TASK-004, TASK-005, TASK-006, TASK-007 | COMPLETED |

## Completion Criteria

- [x] All eight tasks are completed and synchronized with `PROGRESS.json`
- [x] All calendar-owned code, UI, API, persistence, configuration references,
      tests, and active documentation are removed
- [x] Unrelated mail, `MessageEvent`, contacts/CardDAV, attachments/file links,
      credential encryption, templates, and external mail remain functional
- [x] Fresh install and deployed-database upgrade paths are verified
- [x] Repository-wide lint, typecheck, tests, and web build pass

## Progress Log

### Session: 2026-09-06
**Tasks Completed**: TASK-008
**Tasks In Progress**: None
**Blockers**: None
**Review Summary**:
- `rg` classified every remaining calendar/CalDAV/ICS hit as immutable or
  removal migration evidence, a negative removal test, retained
  `text/calendar` attachment support, retained CardDAV RFC/namespace text, or
  unrelated generic date/DOM/`MessageEvent` language. Negative symbol, web
  route/navigation/settings/API, GraphQL implementation, and composed-SDL
  probes found no forbidden live surface.
- `mise run lint` passed: Biome and format checks examined 357 files with no
  fixes needed, and all seven workspace typechecks exited successfully.
- `mise run test` passed 1,579 root tests in 100 files and 192 web tests in
  eight files. A focused retained-boundary run passed 420 tests in 25 files;
  focused web contact/template coverage passed 38 tests in three files.
- `mise run build` passed with 95 web modules transformed. All 50 declared
  package export targets resolved, and package manifests contained no
  calendar/CalDAV/ICS export.
- The focused `0012_remove_calendar.sql` suite passed all four fresh-schema,
  deployed-upgrade, narrow/idempotent blob-cleanup, and retry tests. It also
  checks foreign keys, removal of calendar tables/scopes, and preservation of
  message-backed attachments and unrelated scopes.
- `git diff --check` passed. All 68 touched non-test TypeScript sources were
  below 1,000 lines; the largest was 842 lines.
**Notes**: `impl-plans/PROGRESS.json` was synchronized under the progress lock:
the five retired calendar plans were removed, phase 11 and this plan were
marked completed, and TASK-001 through TASK-008 were marked completed.

## Related Plans

- **Retires**: `calendar-domain.md`, `calendar-application.md`,
  `calendar-adapter.md`, `calendar-graphql.md`, `calendar-web.md`
- **Preserves**: `contacts-*.md`, `external-mail-*.md`, mail/template plans
- **Depends On**: None; removal targets the completed phase-7 implementation
