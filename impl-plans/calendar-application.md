# Calendar Application Layer Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-calendar.md#authorization
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-calendar.md

### Summary
Ports, use cases, authorization, and in-memory test fakes for calendars,
events, mentions, links, attachments, and CalDAV sync orchestration.

### Scope
**Included**: packages/application additions (ports, policies, usecases,
test-support), AppDependencies extension, UseCases aggregation hook.
**Excluded**: concrete adapters, GraphQL, web.

---

## Tasks

### TASK-001: Ports and AppDependencies
**Status**: Completed
**Parallelizable**: Yes (needs calendar-domain TASK-003 types)
**Deliverables**:
- `packages/application/src/ports/calendar-repository.ts`:
  `CalendarRepository` (insert/update/delete/getById/listByOwner/listAll).
- `packages/application/src/ports/calendar-event-repository.ts`:
  `CalendarEventRepository` — atomic `createEvent(event)` /
  `updateEvent(event)` (event row + mentions + links in one batch),
  `deleteEvent(id)`, `getById`, `listOverrides(parentEventId)`,
  `listCandidatesInRange(calendarIds, rangeStartUtc, rangeEndUtc)`
  (non-recurring overlap OR recurring window per design),
  `listByMentionAddress(address, range?)`, attachment claim methods
  `attach(eventId, attachmentId, position)` / `detach` /
  `listAttachments(eventId)` / `findEventIdsByAttachment(attachmentId)`.
- `packages/application/src/ports/caldav.ts`: `CaldavAccountRepository`
  (accounts CRUD, calendar links, event states upsert/list, tombstones
  add/list/remove); `CaldavClient`:
```typescript
interface CaldavClient {
  discover(server: { serverUrl: string; username: string; password: string }): Promise<CaldavDiscoveredCalendar[]>;
  listChanges(cal: RemoteCalendarRef, syncToken: string | null): Promise<CaldavChangeSet>; // falls back internally to etag listing
  multigetEvents(cal: RemoteCalendarRef, hrefs: readonly string[]): Promise<CaldavObject[]>; // { href, etag, ics }
  putEvent(cal: RemoteCalendarRef, href: string, ics: string, etag: string | null): Promise<PutResult>; // CREATED|UPDATED|CONFLICT
  deleteEvent(cal: RemoteCalendarRef, href: string, etag: string | null): Promise<DeleteResult>;
}
```
- `packages/application/src/ports/credential-cipher.ts`:
  `CredentialCipher { encrypt(plaintext): Promise<string>; decrypt(ciphertext): Promise<string>; readonly available: boolean }`.
- `packages/application/src/ports/ics-codec.ts`: `IcsCodec {
  serializeEvent(event, opts): string; parseCalendarObject(ics): ParsedIcsEvent[] }`
  with `ParsedIcsEvent` carrying warnings (`unknownTimeZone`,
  `recurrenceUnsupported`) per design.
- `packages/application/src/dependencies.ts` (extend): add
  `calendarRepository`, `calendarEventRepository`,
  `caldavAccountRepository`, `caldavClient`, `credentialCipher`,
  `icsCodec`.
**Completion Criteria**:
- [x] Ports contain no adapter imports; typecheck passes

### TASK-002: Authorization rules
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**: `packages/application/src/policies/authorization.ts`
(extend, single choke point): `calendarReadRule(viewer, calendarOwner)` /
`calendarWriteRule(...)` implementing: owner full, ADMIN all, VIEWER
read-only own (VIEWER whitelist += CALENDAR_READ), mentioned-user
read-only per event, API-key scope match of CALENDAR_READ/WRITE against
owner's account email via existing AddressPattern machinery; unauthorized
reads -> NotFoundError (probe resistance). CalDAV account management is
USER-viewer-only.
**Completion Criteria**:
- [x] Matrix unit tests: owner/ADMIN/VIEWER/mentioned/scoped key/mail-only
      key(NOT_FOUND)/global-capability key
- [x] No change to existing mail rules (existing tests untouched/green)

### TASK-003: Calendar + event use cases
**Status**: Completed
**Parallelizable**: No (depends on TASK-002)
**Deliverables**:
- `packages/application/src/usecases/calendars.ts`: createCalendar,
  listCalendars, updateCalendar, deleteCalendar.
- `packages/application/src/usecases/calendar-events.ts`: createEvent,
  getEvent, updateEvent(editScope THIS_OCCURRENCE|ENTIRE_SERIES ->
  override materialization), deleteEvent(editScope -> EXDATE append or
  series delete), listEventsInRange (candidates -> expandOccurrences ->
  override substitution -> sort; ExpansionResult.truncated surfaced),
  listEventsMentioning (authz per design), addEventMention,
  removeEventMention, addEventLink, removeEventLink,
  attachEventAttachment (attachment.message_id must be NULL and
  unclaimed), detachEventAttachment.
- All curried `create<X>UseCase(deps)` returning `(viewer, input)`.
- `packages/application/src/usecases.ts` (extend): new
  `usecases/calendar-usecases.ts` exporting
  `createCalendarUseCases(deps)` group; `UseCases` interface and
  `createUseCases` spread it (small hook only — bulk lives in new files).
**Completion Criteria**:
- [x] Use-case tests over fakes incl. editScope semantics and expansion caps
- [x] IDs generated at application layer (random port), never in domain

### TASK-004: CalDAV use cases
**Status**: Completed
**Parallelizable**: No (depends on TASK-003)
**Deliverables**: `packages/application/src/usecases/caldav.ts`:
connectCaldavAccount (USER only; cipher.available gate ->
ServiceUnavailableError; discover -> persist encrypted -> return
discovered calendars), linkCaldavCalendar (IMPORT_NEW creates local
calendar, BIND_EXISTING validates ownership), syncCalendar (pull
sync-token/etag diff -> multiget -> parse -> upsert with remote-wins
conflicts -> push dirty updated_at > last_synced_at -> push tombstones ->
persist tokens; returns SyncCalendarResult {pulled, pushed, deleted,
conflictsResolvedRemoteWins, truncated, warnings}), deleteCaldavAccount.
401 -> BadUserInputError; network/5xx -> ServiceUnavailableError.
**Completion Criteria**:
- [x] Sync tests with scripted fake CaldavClient: initial import,
      incremental, both-changed remote-wins, 412 conflict, local delete
      tombstone, remote delete, unsupported-RRULE excluded from push
- [x] Credentials never appear in results or thrown errors

### TASK-005: Test-support fakes
**Status**: Completed
**Parallelizable**: No (depends on TASK-001)
**Deliverables**:
- `packages/application/src/test-support/calendar-fakes.ts`: in-memory
  `fakeCalendarRepository`, `fakeCalendarEventRepository`,
  `fakeCaldavAccountRepository`, `scriptedCaldavClient(script)`,
  `plainCredentialCipher`, `identityIcsCodec` (or minimal real codec
  passthrough for use-case tests).
- `fakes.ts` `createFakeDependencies()` extended to include them.
**Completion Criteria**:
- [x] Fakes honor authz-relevant shapes (as message-repository-fake does)
- [x] Existing fake consumers unaffected

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Ports | `packages/application/src/ports/{calendar-repository,calendar-event-repository,caldav,credential-cipher,ics-codec}.ts` | IN_PROGRESS | - |
| Authorization | `packages/application/src/policies/authorization.ts` | IN_PROGRESS | - |
| Calendar/event use cases | `packages/application/src/usecases/{calendars,calendar-events,calendar-usecases}.ts` | IN_PROGRESS | - |
| CalDAV use cases | `packages/application/src/usecases/caldav.ts` | IN_PROGRESS | - |
| Fakes | `packages/application/src/test-support/calendar-fakes.ts` | IN_PROGRESS | - |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | calendar-domain.md TASK-001..004 | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] usecases.ts stays under 1000 lines (bulk in calendar-usecases.ts)

## Progress Log

### Session: 2026-08-24 (fable-and-improve-opus plan reconciliation)
**Tasks Completed**: TASK-001..TASK-005 code deliverables exist and typecheck; user-calendar-permissions use cases + test added beyond plan scope.
**Notes**: Remaining for completion criteria: unit tests for calendars/calendar-events/caldav(-sync)/calendar-access use cases (authorization matrix, editScope semantics, sync conflict policy). Fix lint: noImplicitAnyLet at usecases/caldav.ts:129.

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-calendar.md

## Related Plans

- **Depends On**: calendar-domain.md
- **Next**: calendar-adapter.md, calendar-graphql.md

### Session: 2026-08-24 (fable-and-improve-opus implementation)
**Tasks Completed**: TASK-001..TASK-005 (code was already present); test
coverage added this session.
**Notes**: `usecases/calendars.test.ts` (authorization matrix incl. per-user
ALLOW/DENY and DENY-beats-ADMIN), `usecases/calendar-events.test.ts`
(event authorization, mention visibility, editScope semantics),
`usecases/caldav-sync.test.ts` (remote-wins conflicts, tombstone push,
recurrenceUnsupported never pushed). `usecases/caldav-sync.ts` gained the
full-resync deletion rule: when the adapter falls back to a full listing,
local state absent from that listing is treated as remotely deleted (skipped
when the listing was truncated).

### Session: 2026-08-24 (opus-implementation, review revision)
**Tasks Completed**: TASK-001..005 (all criteria ticked against evidence).
**Notes**: `caldav-sync.ts` now pushes by calendar object resource:
`groupForPush` pairs each master with its overrides, one PUT per group at one
href, one `caldav_event_states` row keyed by the master, and stale per-
override rows are removed so `findEventStateByHref` is unambiguous. The pull
side writes the state row only for the master component for the same reason
(review H-002). `usecases/caldav.ts` validates the server URL with
`normalizeCaldavServerUrl` *before* the credential is put on the wire, and
`linkCaldavCalendar` constrains `remoteUrl` to the account's own origin
(review M-001). New tests: 7 override/resource-grouping cases and 3 URL
validation cases.

### Session: 2026-08-24 (opus-implementation, review round 3)
**Notes**: Fixed two confirmed correctness defects in the override path.
`createDeleteCalendarEventUseCase` now branches on `event.overrideOf !== null`
before the editScope check: an override addressed with THIS_OCCURRENCE (or
with no scope) resolves to its master and goes through
`deleteSingleOccurrence`, which writes the EXDATE and bumps the master --
previously the override row was simply deleted and the instance reappeared at
the series' base time on the very next listing, with no CalDAV deletion ever
pushed (H-003). ENTIRE_SERIES on an override now resolves and deletes the
master, recording the master's tombstone first. `deleteSingleOccurrence` was
refactored to take a resolved `OccurrenceStart` so both paths reuse it rather
than duplicating the EXDATE logic. `createUpdateCalendarEventUseCase` routes
ENTIRE_SERIES from an override to the master, leaving sibling overrides alone
as deliberate exceptions (M-004). In `push()`, override state rows are now
deleted *before* the master's row is saved, because
`caldav_event_states` is UNIQUE on `(caldav_calendar_id, href)` while the
upsert only resolves `ON CONFLICT(event_id)` -- the previous ordering would
have raised SQLITE_CONSTRAINT against a legacy row rather than self-healing
(L-004). Tests: 6 override delete/edit cases, a CalDAV follow-through case
asserting the resource is re-PUT with one VEVENT and no DELETE, and a
legacy-state-row case.

### Session: 2026-08-24 (opus-implementation, review round 4)
**Notes**: Verified all five carried-over review findings against HEAD
(commit `0fc9221`): the attachment download event branch, CalDAV resource
grouping for overrides, pre-transmission server-URL validation plus the
redirect scheme/host guard, the template/calendar permission UI and
capability/id test coverage, and the plan status bookkeeping are all present
and green. Closed the one gap the round-3 report left open: file links on
event attachments. `usecases/file-links.ts` previously rejected every
attachment with `messageId === null`, which is exactly the shape an event
attachment has, so the design's claim that "file links work unchanged"
(design-calendar.md#request-flows) was false in practice.
`createCreateAttachmentLinkUseCase` now branches: an attachment with no
message authorizes through a claiming event the viewer can read plus the
`FILE_LINK` capability at its coarsest form (`requireFileLinkCapability`,
since an event exposes no address to scope against), and an attachment no
event has claimed still reports as absent. `createRevokeFileLinkUseCase`
takes the same branch and re-labels a denied event lookup as
`NotFound("FileLink")` so the caller cannot use revoke to probe for
attachment ids. Resolution of a minted token was already message-agnostic
and is unchanged. Tests: 7 cases in `file-links.test.ts` covering mint by the
event owner end-to-end through `resolveFileLink`, denial for a bystander and
for a mail-only key, `FORBIDDEN` for a calendar key with read but no
`FILE_LINK`, success for one holding both, the still-unlinkable orphan
upload, and revoke authorization.

**Completion Criteria**:
- [x] Event attachments are linkable through their claiming event
- [x] `FILE_LINK` remains required, and an unclaimed upload stays unlinkable
- [x] Revoke authorizes identically and leaks no attachment existence
- [x] design-calendar.md#request-flows states the actual rule
