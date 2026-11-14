# Calendar Adapter Layer Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-calendar.md#ics-mapping
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-calendar.md

### Summary
Concrete adapters: D1/libsql repositories for calendar tables, ICS codec
(RFC 5545 subset), CalDAV client with minimal multistatus XML reader, and
AES-256-GCM credential cipher.

### Scope
**Included**: packages/adapter additions + package.json export map entries.
**Excluded**: ports (calendar-application.md), wiring (calendar-graphql.md).

---

## Tasks

### TASK-001: Calendar repositories
**Status**: Completed
**Parallelizable**: Yes (needs calendar-application TASK-001 ports + migration 0006)
**Deliverables**:
- `packages/adapter/src/repositories/calendar-repository.ts`
- `packages/adapter/src/repositories/calendar-event-repository.ts` — raw
  SQL over `SqlDatabase`; `createEvent`/`updateEvent` write event +
  mentions + links in one `db.batch` (delete-then-insert for child rows);
  candidate range query per design (non-recurring overlap OR rrule window
  via `range_start_utc`/`recurrence_until_utc`); mention lookup via
  `event_mentions.address` index; attachment claim guarded by
  `message_id IS NULL` check + join-table uniqueness.
- `packages/adapter/src/repositories/caldav-account-repository.ts` —
  accounts, calendar links, event states, tombstones.
- Row mapping uses `assertEnumValue`, `boolToSql`/`sqlToBool`,
  `buildInPlaceholders` from `sql-helpers.ts`.
**Completion Criteria**:
- [x] Real-SQL tests via `repositories/test-support.ts` after applying
      migrations 0001..0006: CRUD, batch atomicity, range candidates
      (timed/all-day/recurring/unbounded), cascades, tombstone survival,
      attachment claim conflict
- [x] package.json export map covers new repository files (existing `./repositories/*` glob suffices — verify)

### TASK-002: ICS codec
**Status**: Completed
**Parallelizable**: Yes (needs calendar-domain TASK-002/003)
**Deliverables**: `packages/adapter/src/ics/ics-codec.ts` (+
`packages/adapter/src/ics/ics-format.ts` for folding/escaping helpers if
needed to stay modular): implements application `IcsCodec` port per design
"ICS mapping": serialize VCALENDAR/VEVENT (UID, DTSTAMP from injected
clock, SUMMARY, DESCRIPTION, LOCATION, DTSTART/DTEND with TZID= or
VALUE=DATE, RRULE, EXDATE, RECURRENCE-ID, URL, X-MAILCAL-LINK;X-TITLE,
X-MAILCAL-MENTION:mailto:) — never ATTENDEE; 75-octet folding, CRLF, RFC
5545/6868 escaping; IANA TZID without VTIMEZONE. Parse: tolerant unfold;
ATTENDEE -> mention dropping PARTSTAT/RSVP/ROLE/CN; X-MAILCAL-* mapping;
EXDATE multi-value TZID-aware; RECURRENCE-ID -> override linkage
descriptor; unknown TZID -> UTC + `unknownTimeZone` warning; unsupported
RRULE -> non-recurring + `recurrenceUnsupported` flag.
**Completion Criteria**:
- [x] Round-trip tests: own-output stability; iCloud-shaped fixtures
      (folded lines, ATTENDEE with PARTSTAT dropped, VALUE=DATE,
      EXDATE lists, VTIMEZONE blocks ignored)
- [x] No RSVP-bearing property ever emitted (explicit test)

### TASK-003: CalDAV client + XML reader
**Status**: Completed
**Parallelizable**: Yes (needs calendar-application TASK-001 port)
**Deliverables**:
- `packages/adapter/src/caldav/xml.ts`: minimal namespace-tolerant reader
  for multistatus documents (element name matching ignores prefixes,
  matches by local name; extracts href/status/propstat props).
- `packages/adapter/src/caldav/caldav-client.ts`: fetch-based
  `createCaldavClient({ fetchImpl })` implementing the port: discovery
  (PROPFIND current-user-principal at /.well-known/caldav following
  cross-host redirects -> calendar-home-set -> Depth:1 listing filtering
  VEVENT collections; captures displayname, getctag, sync-token);
  listChanges via RFC 6578 sync-collection REPORT with automatic fallback
  to Depth:1 getetag PROPFIND diff on invalid-token/unsupported;
  calendar-multiget REPORT chunked (50 hrefs); putEvent PUT
  If-Match/If-None-Match:* mapping 412 -> CONFLICT; deleteEvent DELETE
  If-Match (404 treated as success). Basic auth header built per request;
  password held only in call arguments.
**Completion Criteria**:
- [x] Fixture tests: iCloud-prefix and generic-DAV-prefix multistatus,
      discovery redirect chain (301 to pXX host), sync-collection,
      fallback diff, multiget chunking, 412, 404-on-delete
- [x] No real network in tests (injected fetchImpl)

### TASK-004: Credential cipher
**Status**: Completed
**Parallelizable**: Yes
**Deliverables**: `packages/adapter/src/crypto/credential-cipher.ts`:
`createCredentialCipher(keyBase64: string | null): CredentialCipher` —
WebCrypto AES-256-GCM; key = base64-decoded 32 bytes (invalid -> throw at
construction, config layer fails fast); `available=false` implementation
when key null (encrypt/decrypt throw ServiceUnavailable-translatable
error). Format `v1:` + base64(12-byte IV || ciphertext||tag).
**Completion Criteria**:
- [x] Round-trip, tamper rejection (auth tag), wrong-key rejection,
      invalid-key-format construction failure tests
- [x] package.json export entry (`./crypto/credential-cipher`)

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Repositories | `packages/adapter/src/repositories/{calendar-repository,calendar-event-repository,caldav-account-repository}.ts` | NOT_STARTED | - |
| ICS codec | `packages/adapter/src/ics/ics-codec.ts` | NOT_STARTED | - |
| CalDAV client | `packages/adapter/src/caldav/{xml,caldav-client}.ts` | NOT_STARTED | - |
| Cipher | `packages/adapter/src/crypto/credential-cipher.ts` | NOT_STARTED | - |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | calendar-domain.md (all), calendar-application.md TASK-001 | Pending |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] New export map entries added for ics/ and caldav/ and crypto/ modules
- [x] No file at 1000+ lines (split ics-format.ts / xml.ts as needed)

## Progress Log

### Session: 2026-08-24 (fable-and-improve-opus plan reconciliation)
**Tasks Completed**: None of TASK-001..004. Outside-plan additions verified done: repositories/user-calendar-permission-repository.ts (+test), migrations/calendar-migration.test.ts (has TS6133 unused import to fix).
**Notes**: ics/, caldav/, crypto/credential-cipher.ts and the three calendar repositories do not exist yet. These four tasks are the critical path for the typecheck failure in build-dependencies.ts.

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-calendar.md

## Related Plans

- **Depends On**: calendar-domain.md, calendar-application.md
- **Next**: calendar-graphql.md

### Session: 2026-08-24 (fable-and-improve-opus implementation)
**Tasks Completed**: TASK-001..TASK-004.
**Notes**: `repositories/calendar-repository.ts`, `calendar-event-repository.ts`
(+ `calendar-event-rows.ts` for the row mapping and the single-batch write),
`caldav-account-repository.ts`, `ics/ics-format.ts` + `ics/ics-codec.ts`,
`caldav/xml.ts` + `caldav/caldav-client.ts`, `crypto/credential-cipher.ts`.
Tests: `repositories/calendar-repositories.test.ts` (real SQL over migrations
0001..0008, incl. range-candidate matrix, batch atomicity, cascades,
tombstone survival, attachment claim rules), `ics/ics-codec.test.ts` (round
trip, iCloud ATTENDEE/PARTSTAT drop, no-ATTENDEE-on-serialize, folding,
unknown TZID, unsupported RRULE), `caldav/caldav-client.test.ts` (cross-host
redirect keeping Basic auth, sync-collection, 507 fallback, multiget
chunking, 412, 404 delete), `caldav/xml.test.ts`,
`crypto/credential-cipher.test.ts` (round trip, tamper, wrong key, unset key).
`COUNT`-bounded rules are stored with a null `recurrence_until_utc`
(candidate query less selective, never wrong) -- documented in
`calendar-event-rows.ts`.

### Session: 2026-08-24 (opus-implementation, review revision)
**Tasks Completed**: TASK-001..004 (all criteria ticked against evidence).
**Notes**: Added `IcsCodec.serializeCalendarObject` and split the serializer
into a `VEVENT` builder plus a `VCALENDAR` wrapper, so a series master and
its `RECURRENCE-ID` overrides go to the server as one calendar object
resource (review H-002). Hardened `caldav/caldav-client.ts`: the initial
request and every redirect target must be https (localhost http excepted)
before the Basic auth header is attached, so a plain-http or foreign-host
hop can no longer harvest the app-specific password (review M-001). New
tests: grouped serialization + round trip + still-no-ATTENDEE (3), credential
transport safety incl. the iCloud cross-host hop still working (4).
