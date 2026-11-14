# Calendar Web Client Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-calendar.md#web-client-appsweb
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-calendar.md

### Summary
SolidJS calendar UI: month + week views, event create/edit dialog with
mention-by-email chips, attachment upload, URL link rows, recurrence
editor, and CalDAV settings, over the GraphQL API.

### Scope
**Included**: apps/web additions (route, pages, components, store, api
documents/types, date helpers, CSS).
**Excluded**: day view (deferred), server-side code.

---

## Tasks

### TASK-001: API documents and types
**Status**: Completed
**Parallelizable**: Yes (contract from calendar-graphql TASK-001 SDL)
**Deliverables**:
- `apps/web/src/api/calendar-documents.ts`: string operation documents for
  every calendar query/mutation in the SDL (calendars, calendarEvents,
  calendarEvent, eventsMentioning, caldavAccounts, all mutations).
- `apps/web/src/api/calendar-types.ts`: hand-written TS types mirroring
  the SDL (no codegen), incl. EventOccurrence, SyncCalendarResult,
  RecurrenceRuleInput, EventEditScope.
- `documents.ts` / `schema-types.ts` untouched.
**Completion Criteria**:
- [x] Types compile under maximum strictness; names mirror SDL exactly

### TASK-002: Date-grid helpers
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `apps/web/src/lib/calendar-dates.ts`: pure functions —
month matrix (6x7 weeks honoring locale week start MO), week columns,
visible-range for a view (monthRange/weekRange returning UTC bounds for
the query), occurrence-to-cell layout (multi-day spans, all-day lane,
overlap stacking order for week view), date formatting helpers reusing
existing relative-time conventions.
**Completion Criteria**:
- [x] Unit tests: month boundaries, DST weeks, multi-day span layout,
      week-start correctness

### TASK-003: Calendar store
**Status**: Completed
**Parallelizable**: No (depends on TASK-001, TASK-002)
**Deliverables**: `apps/web/src/store/calendar-store.ts` (+ registration
in `store-context.tsx`): signals for view mode (month|week), anchor date,
calendar list + visibility toggles, occurrence cache keyed by
`viewRange+calendarIds`, dialog state; actions load/create/update/delete
event (optimistic with rollback, invalidate affected range), mention
add/remove, link add/remove, attachment attach/detach, caldav
connect/link/sync surfacing SyncCalendarResult toasts. `app-store.ts`
gains only the mount hook.
**Completion Criteria**:
- [x] Store unit tests: cache invalidation, optimistic rollback on error,
      visibility filtering

### TASK-004: Views and components
**Status**: Completed
**Parallelizable**: No (depends on TASK-003)
**Deliverables**:
- Route `/calendar` (AuthGuard, lazy) added to `apps/web/src/app.tsx`;
  topbar/sidebar navigation entry.
- `apps/web/src/pages/calendar-page.tsx`.
- `apps/web/src/components/calendar/`: `calendar-toolbar.tsx`
  (month/week switch, prev/today/next, calendar toggles),
  `month-grid.tsx`, `week-grid.tsx`, `event-chip.tsx` — each with sibling
  `.css` on `styles/tokens.css`.
**Completion Criteria**:
- [x] Month + week render occurrences (timed, all-day, multi-day spans);
      clicking a slot opens create dialog, clicking a chip opens edit

### TASK-005: Event dialog and CalDAV settings
**Status**: Completed
**Parallelizable**: No (depends on TASK-004)
**Deliverables**:
- `apps/web/src/components/calendar/event-dialog.tsx`: title, calendar
  select, all-day toggle, start/end pickers with time-zone select
  (Intl.supportedValuesOf("timeZone")), recurrence editor limited to the
  supported subset, `mention-input.tsx` email-chip field (EmailAddress
  format validation, dedup), attachment upload via existing staged
  `POST /api/attachments` then attachFileToEvent, URL link rows
  (add/remove, title), editScope prompt (THIS_OCCURRENCE|ENTIRE_SERIES)
  when mutating a recurring occurrence; delete with same prompt.
- `apps/web/src/components/calendar/caldav-settings.tsx` (mounted from
  calendar page or settings): connect account (serverUrl default
  caldav.icloud.com, username, app-specific password — input never
  persisted client-side), list/link discovered calendars, sync button
  with per-result summary, delete account.
**Completion Criteria**:
- [x] No RSVP-related UI anywhere; mentions render as plain chips
- [x] apps/web `bun run build` (vite build) passes
- [x] `bun run --cwd apps/web test` green

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| API layer | `apps/web/src/api/calendar-{documents,types}.ts` | NOT_STARTED | - |
| Date helpers | `apps/web/src/lib/calendar-dates.ts` | NOT_STARTED | - |
| Store | `apps/web/src/store/calendar-store.ts` | NOT_STARTED | - |
| Views | `apps/web/src/pages/calendar-page.tsx`, `apps/web/src/components/calendar/*` | NOT_STARTED | - |
| Dialog + CalDAV UI | `apps/web/src/components/calendar/{event-dialog,mention-input,caldav-settings}.tsx` | NOT_STARTED | - |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | calendar-graphql.md TASK-001/002 (live API for manual verify; TASK-001 SDL is enough to start) | Pending |

## Completion Criteria

- [x] All tasks complete; web tests green; vite build passes
- [x] typecheck + biome pass; no file at 1000+ lines

## Progress Log

### Session: 2026-08-24 (fable-and-improve-opus plan reconciliation)
**Tasks Completed**: None. No calendar files exist under apps/web yet.
**Notes**: Near-limit files app-store.ts / documents.ts / schema-types.ts must not grow; all additions in new modules per design.

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-calendar.md

## Related Plans

- **Depends On**: calendar-graphql.md

### Session: 2026-08-24 (fable-and-improve-opus implementation)
**Tasks Completed**: TASK-001..TASK-005.
**Notes**: `api/calendar-documents.ts` + `api/calendar-types.ts` (neither
`documents.ts` nor `schema-types.ts` grew), pure `lib/calendar-dates.ts`
(+ 19 unit tests), `store/calendar-store.ts` (range-keyed occurrence cache,
optimistic delete with rollback, + 13 tests), `components/calendar/`
(toolbar, month-grid, week-grid, event-chip, event-dialog, caldav-settings,
one shared `calendar.css`), `pages/calendar-page.tsx`, `/calendar` route in
`app.tsx` and a topbar link. The store is created by the lazy page rather
than mounted globally, so a mailbox-only visitor does not pay for it.

### Session: 2026-08-24 (opus-implementation, review revision)
**Tasks Completed**: TASK-001..005 (all criteria ticked against evidence).
**Notes**: No web change was needed for the review findings; the attachment
download link the event dialog renders now resolves, because the route it
points at gained its event branch (review H-001). Gates re-run: 183 web tests
and `vite build` green.

### Session: 2026-08-24 (opus-implementation, review round 3)
**Notes**: No calendar-web change. The mail-templates web integration that the
checkout incident had cost -- send panel mounting, sidebar entry, users-page
template/calendar permission editors, settings styles -- was restored this
round, so `apps/web` no longer carries an unreferenced component. The
calendar permission editor added there writes all-owners rules; per-owner
scoping stays API-only, as the design allows.

