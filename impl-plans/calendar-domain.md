# Calendar Domain and Migration Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-calendar.md#domain-model
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-calendar.md

### Summary
Domain layer for calendars and events (branded IDs, TimeZoneId, EventTime
union, RecurrenceRule RFC 5545 subset, pure recurrence expansion, mentions,
links, CalDAV account entity, new API-key capabilities) plus D1 migration
0006.

### Scope
**Included**: packages/domain additions; apps/api/migrations/0006_calendar.sql.
**Excluded**: ports/use cases (calendar-application.md), adapters
(calendar-adapter.md), GraphQL/web.

---

## Tasks

### TASK-001: Branded IDs and TimeZoneId
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**:
- `packages/domain/src/value-objects/ids.ts` (extend): `CalendarId`,
  `CalendarEventId`, `EventLinkId`, `CaldavAccountId`, `CaldavCalendarId`
  + `createXxxId` constructors via `requireNonEmptyId`.
- `packages/domain/src/value-objects/time-zone.ts` (new): branded
  `TimeZoneId`; `parseTimeZoneId(value: string): TimeZoneId | null`
  (validates via `new Intl.DateTimeFormat("en-US", { timeZone })` in
  try/catch); `createTimeZoneId(value, field?): TimeZoneId` (throws
  `ValidationError`).
**Completion Criteria**:
- [x] IDs follow existing brand + smart-constructor pattern
- [x] TimeZoneId dual constructors mirror email-address.ts
- [x] Unit tests: valid IANA zones, garbage, empty, "UTC"

### TASK-002: RecurrenceRule value object
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `packages/domain/src/value-objects/recurrence.ts` (new):
```typescript
type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
interface RecurrenceRule {
  readonly freq: RecurrenceFrequency;
  readonly interval: number;              // >= 1
  readonly count?: number;                // XOR until
  readonly untilUtc?: number;             // epoch ms
  readonly byDay?: readonly Weekday[];
  readonly byMonthDay?: readonly number[]; // 1..31 only (no negatives)
  readonly byMonth?: readonly number[];    // 1..12
  readonly weekStart: Weekday;             // default "MO"
}
function parseRecurrenceRule(rrule: string): RecurrenceRule | null; // null on unsupported parts (BYSETPOS, BYHOUR, SECONDLY, negative BYMONTHDAY, ...)
function createRecurrenceRule(input: ...): RecurrenceRule;          // throws ValidationError
function formatRecurrenceRule(rule: RecurrenceRule): string;        // RRULE text
```
**Completion Criteria**:
- [x] COUNT/UNTIL mutual exclusion enforced
- [x] parse -> format round-trip stable; unsupported input returns null
- [x] Unit tests for each part and each rejection

### TASK-003: Calendar, CalendarEvent, CaldavAccount entities
**Status**: Completed
**Parallelizable**: No (depends on TASK-001, TASK-002)
**Deliverables**:
- `packages/domain/src/entities/calendar.ts`: `Calendar` interface +
  `createCalendar` (name 1..120, color `#rrggbb`, ownerUserId).
- `packages/domain/src/entities/calendar-event.ts`:
```typescript
type EventTime =
  | { readonly kind: "TIMED"; readonly startsAt: number; readonly endsAt: number; readonly timeZone: TimeZoneId }
  | { readonly kind: "ALL_DAY"; readonly startDate: string; readonly endDateExclusive: string }; // YYYY-MM-DD
interface EventLink { readonly id: EventLinkId; readonly url: string; readonly title?: string; readonly position: number }
interface CalendarEvent { id, calendarId, uid, title, description?, location?, time: EventTime,
  recurrence?: RecurrenceRule, exdates: readonly number[] /* or ISO dates for all-day */,
  overrideOf?: { parentEventId: CalendarEventId; recurrenceInstanceStart: number | string },
  mentions: readonly EmailAddress[], links: readonly EventLink[], createdAt, updatedAt }
function createCalendarEvent(input): CalendarEvent; // enforces invariants from design doc
```
  Invariants: end > start; override XOR recurrence; absolute http(s) link
  URLs; deduplicated normalized mentions.
- `packages/domain/src/entities/caldav-account.ts`: `CaldavAccount`
  (passwordCiphertext only), `CaldavCalendarLink` (remoteUrl, ctag?,
  syncToken?, lastSyncedAt?).
- `packages/domain/src/entities/api-key.ts` (extend):
  `ApiKeyCapability.CalendarRead = "CALENDAR_READ"`,
  `CalendarWrite = "CALENDAR_WRITE"` (non-global).
**Completion Criteria**:
- [x] All invariants throw ValidationError with field names
- [x] Capability additions do not alter GLOBAL_CAPABILITIES
- [x] Unit tests per invariant, incl. all-day date ordering

### TASK-004: Recurrence expansion
**Status**: Completed
**Parallelizable**: No (depends on TASK-002, TASK-003)
**Deliverables**: `packages/domain/src/entities/recurrence-expansion.ts`:
```typescript
interface Occurrence { readonly startUtc: number; readonly endUtc: number; readonly startDate?: string; readonly endDateExclusive?: string }
interface ExpansionResult { readonly occurrences: readonly Occurrence[]; readonly truncated: boolean }
function expandOccurrences(event: CalendarEvent, rangeStartUtc: number, rangeEndUtc: number,
  limits?: { maxOccurrences?: number }): ExpansionResult;
```
Semantics (design doc "Domain model"): wall-clock arithmetic in event zone
via Intl offset lookup; spring-forward gap shifts forward; fall-back takes
earlier offset; COUNT consumed before EXDATE filtering; caps 400 days /
1000 occurrences (range violation throws ValidationError; occurrence cap
truncates). Overrides/EXDATE substitution helper
`applyOverrides(master, overrides, occurrences)` exported for the
application layer.
**Completion Criteria**:
- [x] Table-driven tests: DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT vs
      EXDATE, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, WKST
- [x] DST fixtures America/New_York + Asia/Tokyo (gap + ambiguity)
- [x] All-day and multi-day expansion without tz math

### TASK-005: Migration 0006_calendar.sql
**Status**: Completed
**Parallelizable**: No (depends on TASK-003 for column shape)
**Deliverables**: `apps/api/migrations/0006_calendar.sql` exactly per the
design doc "D1 schema" section: api_key_scopes rebuild (0005 `_new` +
rename pattern, capability CHECK widened to 8 values, rows copied
verbatim); tables `calendars`, `calendar_events` (+ exclusivity CHECK,
UNIQUE(calendar_id, uid, recurrence_instance_start), range indexes),
`event_mentions` (+ address index), `event_links`, `event_attachments`,
`caldav_accounts`, `caldav_calendars`, `caldav_event_states`,
`caldav_deletions`. No embedded semicolons in literals; no triggers.
**Completion Criteria**:
- [x] Applies cleanly via adapter migration runner (libsql local test)
- [x] Existing api_key_scopes rows preserved (migration test)
- [x] Wrangler d1 dry syntax check (`--local`) passes

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| IDs + TimeZoneId | `packages/domain/src/value-objects/{ids,time-zone}.ts` | DONE | - |
| RecurrenceRule | `packages/domain/src/value-objects/recurrence.ts` | DONE | - |
| Entities | `packages/domain/src/entities/{calendar,calendar-event,caldav-account}.ts` | DONE | - |
| Expansion | `packages/domain/src/entities/recurrence-expansion.ts` | DONE | - |
| Migration | `apps/api/migrations/0006_calendar.sql` | DONE | - |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | existing domain-model plan (Completed) | Available |

## Completion Criteria

- [x] All tasks complete, unit tests passing (vitest run)
- [x] bun run typecheck and biome check pass
- [x] No touched file at 1000+ lines

## Progress Log

### Session: 2026-08-24 (fable-and-improve-opus plan reconciliation)
**Tasks Completed**: TASK-001..TASK-005 (verified on disk; domain tests pass in full suite run)
**Notes**: ids/time-zone/recurrence value objects, calendar/calendar-event/caldav-account entities, recurrence-expansion, and migration 0006 all exist with tests; suite green (1272 root tests). Plan stays In Progress until final workflow verification, then move to completed/.

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-calendar.md

## Related Plans

- **Next**: calendar-application.md, calendar-adapter.md

### Session: 2026-08-24 (fable-and-improve-opus implementation)
**Tasks Completed**: TASK-001..TASK-005 (unchanged; verified green).
**Notes**: No domain code was changed this session. `value-objects/ids.ts`
and `entities/api-key.ts` were **reconstructed** after an accidental
`git checkout` discarded their uncommitted edits -- see the session report.
The reconstruction is driven by the surviving consumers and migrations, so
the id constructors and the twelve-member `Capability` enum match what the
rest of the tree and `0006`/`0007` require, but the accompanying unit-test
additions to `ids.test.ts` / `api-key.test.ts` were lost and not rewritten.

### Session: 2026-08-24 (opus-implementation, review revision)
**Tasks Completed**: TASK-001..005 (all criteria ticked against evidence).
**Notes**: Re-added the direct unit coverage lost in the earlier
`git checkout` incident: `value-objects/ids.test.ts` exercises all eight new
branded id constructors, and `entities/api-key.test.ts` pins the twelve-member
`Capability` enum against the migration CHECK constraints and asserts the
calendar/template narrowing plus the per-address vs instance-wide split
(review M-002). TASK-005's wrangler criterion was verified for real this
session: `wrangler d1 migrations apply mailcal-db --local` applies 0001..0008
cleanly under workerd's own D1, not only under the libsql runner.
