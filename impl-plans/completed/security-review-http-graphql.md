# HTTP and GraphQL Security Review

**Status**: Completed
**Design Reference**: `design-docs/specs/design-security-model.md`, `design-docs/specs/design-graphql-api.md`
**Created**: 2026-10-28
**Last Updated**: 2026-10-28

Review HTTP, authentication, GraphQL, and realtime boundaries. Preserve existing public APIs and reject malformed or over-budget requests before expensive processing.

## Tasks

### TASK-001: Enforce request byte budgets
**Status**: Completed
**Parallelizable**: Yes
**Dependencies**: None
**Deliverables**: `packages/infrastructure/src/http/body-limit.ts`, `attachments.ts`, regression tests.

- [x] Count actual bytes even with understated Content-Length (issue 1).
- [x] Bound multipart request streams before parsing, including unused fields (issue 2).
- [x] Preserve valid uploads and structured 413 responses.

### TASK-002: Reject malformed cookie credentials safely
**Status**: Completed
**Parallelizable**: Yes
**Dependencies**: None
**Deliverables**: `packages/infrastructure/src/http/auth-middleware.ts`, regression tests.

- [x] Invalid percent escapes resolve to an unauthenticated request instead of throwing (issue 3).
- [x] Valid cookie and bearer authentication remain functional.

### TASK-003: Bound fragment-depth analysis work
**Status**: Completed
**Parallelizable**: Yes
**Dependencies**: None
**Deliverables**: `packages/infrastructure/src/graphql/depth-limit.ts`, regression tests.

- [x] Repeated fragment DAGs cannot cause exponential traversal (issue 4).
- [x] Depth is correct across multiple usage depths and operations.
- [x] Cycles remain safe before GraphQL validation rejects them.

### TASK-004: Verification
**Status**: Completed
**Parallelizable**: No
**Dependencies**: TASK-001, TASK-002, TASK-003

- [x] Regression tests pass.
- [x] Biome and typecheck pass.
- [x] Parent runs independent verification agent.

## Progress Log

### 2026-10-28
Reviewed request handling, auth middleware, binary routes, GraphQL limit plugins, worker routing, and realtime upgrade/execution. Confirmed four issues above; implementing targeted regression coverage.

Implemented all four fixes. Verified 361 tests across 33 API, HTTP, GraphQL, and realtime suites; Biome clean and all workspace typechecks passed. WebSocket malformed-cookie rejection remains unchanged. Fragment cycles remain rejected by core GraphQL validation. Parent independent verification remains pending.

2026-10-28: Independent integrated verification passed: lint and formatting, all
8 workspace typechecks, 2792 tests across 211 files, production web build,
frozen lockfile install, clean dependency audit (309 packages), and diff checks.
