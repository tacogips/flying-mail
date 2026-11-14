# Application security and correctness review

**Status**: Completed
**Design Reference**: design-docs/specs/design-mail-pipeline.md; design-docs/specs/design-contacts.md
**Created**: 2026-10-28

## Deliverables
- `packages/application/src/usecases/send.ts`: revalidate sending eligibility and limits before retry side effects.
- `packages/application/src/usecases/carddav.ts`: validate remote collection before creating a local book.
- `packages/application/src/usecases/carddav-sync.ts`: process every reported change in bounded multiget batches before advancing its sync token.
- Regression coverage in adjacent application tests.

## Tasks
### TASK-001: Retry guards
**Status**: Completed
**Parallelizable**: No
- [x] Disabled domains/mailboxes and exhausted limits reject retries without requeueing.

### TASK-002: CardDAV link validation
**Status**: Completed
**Parallelizable**: No
- [x] Invalid remote collections cannot persist orphan local books.

### TASK-003: Complete CardDAV change application
**Status**: Completed
**Parallelizable**: No
- [x] More than 500 changed contacts are all applied before checkpointing; each multiget remains bounded.

### TASK-004: Atomic retry claim
**Status**: Completed
**Parallelizable**: No
- [x] Add conditional repository requeue operation and verify concurrent retries with real SQLite and application fakes.

## Completion Criteria
- [x] Regression tests pass.
- [x] Lint and type checking pass.

## Progress Log
- 2026-10-28: Reviewed authorization, attachment binding, external credentials and transports, outbound delivery, and CardDAV sync; confirmed these three defects.

- Verification: Biome passed; workspace typecheck passed; 130 application/domain/adapter test files and 1738 tests passed. Four distinct defects fixed; retry claim verified against migrated SQLite as well as concurrent application calls.
