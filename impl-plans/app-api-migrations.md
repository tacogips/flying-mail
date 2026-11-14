# API App and Migrations Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-storage-and-file-links.md#d1-schema,
design-docs/specs/design-deployment.md, design-docs/specs/design-mail-pipeline.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
`apps/api`: the D1 migrations, the Workers entry point (both `fetch` and
`email` handlers), the Workers env binding types, and the local Bun/Node
server that applies migrations on startup.

### Scope
**Included**: `apps/api/{migrations/*.sql,src/*.ts,wrangler.toml}`.
**Excluded**: the hono app itself (infrastructure plan).

---

## Modules

### 1. Migrations

#### apps/api/migrations/0001_init.sql

**Status**: NOT_STARTED

Every table from `design-storage-and-file-links.md#d1-schema`, in dependency
order: `users`, `sessions`, `email_auth_challenges`, `domains`, `messages`,
`message_recipients`, `attachments`, `tags`, `message_tags`, `api_keys`,
`api_key_scopes`, `message_fetch_states`, `file_links`, plus every listed
index.

Constraints on the migration file itself: the runner splits on `;` with no
awareness of string literals, so no statement may contain a `;` inside a
quoted value.

#### apps/api/migrations/0002_system_tags.sql

**Status**: NOT_STARTED

Seeds the four system tags (`SPAM`, `TRASH`, `ARCHIVED`, `STARRED`) with fixed
UUIDs so a fresh deployment can classify mail before any user exists, and so
tests can reference them by a stable id.

**Checklist**:
- [ ] Both migration files
- [ ] A test applying them through `createMigrationRunner` against in-memory
      libsql, then asserting every table and index exists and the four system
      tags are present

---

### 2. Workers entry point

#### apps/api/src/env.ts

**Status**: NOT_STARTED

```typescript
interface FetcherLike { fetch(request: Request): Promise<Response>; }
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly props: unknown;
}

interface Env {
  readonly DB: D1DatabaseLike;
  readonly BLOB: R2BucketLike;
  readonly ASSETS: FetcherLike;
  readonly EMAIL: CloudflareSendEmailBinding;
  readonly MAILCAL_PUBLIC_ORIGIN?: string;
  readonly MAILCAL_MAIL_FROM?: string;
  readonly MAILCAL_SIGNUP?: string;
  readonly MAILCAL_SPAM_THRESHOLD?: string;
  readonly MAILCAL_FILE_LINK_MAX_TTL?: string;
  readonly MAILCAL_BLOB_BACKEND?: string;
  readonly MAILCAL_S3_ENDPOINT?: string;
  readonly MAILCAL_S3_BUCKET?: string;
  readonly MAILCAL_S3_ACCESS_KEY_ID?: string;
  readonly MAILCAL_S3_SECRET_ACCESS_KEY?: string;
  readonly MAILCAL_S3_REGION?: string;
}

/** Cloudflare's inbound message, as a local structural type. */
interface ForwardableEmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}
```

#### apps/api/src/worker.ts

**Status**: NOT_STARTED

```typescript
function buildWorkerConfig(env: Env): BuildDependenciesConfig;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
  email(message: ForwardableEmailMessageLike, env: Env,
        ctx: ExecutionContextLike): Promise<void>;
};
```

`fetch` caches the assembled hono app in a `WeakMap<Env, WorkerApp>` (the env
object is a stable per-isolate reference), never caching a failed build so a
misconfigured deployment retries instead of wedging until the next cold start.
A construction failure returns a masked JSON 500 by hand, because it happens
before `app.onError` exists.

`email` builds the same dependencies, calls `usecases.receiveMessage({
envelopeFrom: message.from, envelopeTo: message.to, raw: message.raw,
rawSize: message.rawSize, headers: headersToMap(message.headers) })`, and
calls `message.setReject(result.reason)` on a `REJECTED` result. An unexpected
throw is logged and rethrown so Cloudflare retries delivery rather than
silently dropping the message.

**Checklist**:
- [ ] Env types, `buildWorkerConfig`, both handlers
- [ ] Unit tests: config resolution per backend, app caching (two `fetch`
      calls build once), failed build not cached, `email` rejecting an unknown
      domain via `setReject`, `email` storing a good message

---

### 3. Local server

#### apps/api/src/server.ts

**Status**: NOT_STARTED

```typescript
function detectRuntime(): "bun" | "node";
function createLocalApp(migrationsDir?: string):
  Promise<{ readonly app: Hono<{ Variables: AuthVariables }>;
            readonly deps: AppDependencies }>;
function startServer(config?: Partial<{ port: number; migrationsDir: string }>):
  Promise<void>;
```

Loads config from `process.env`, creates the SQLite parent directory when the
URL is a `file:` one, applies every pending migration through the adapter's
runner **before** the app serves a request, seeds the system tags, and serves
via `Bun.serve` under Bun or `@hono/node-server` under Node.

Registers the dev-only `POST /dev/inbound` route (raw `.eml` body, plus
`?to=` and `?from=` query parameters) that feeds the identical
`receiveMessage` use case, since local development has no SMTP path.

**Checklist**:
- [ ] Runtime detection, local app factory, server start
- [ ] Tests: migrations applied before the first request, `/dev/inbound`
      round-trips a fixture into a stored message, route absent when
      `graphiql` is false

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Schema migration | `apps/api/migrations/0001_init.sql` | NOT_STARTED | - |
| System tag seed | `apps/api/migrations/0002_system_tags.sql` | NOT_STARTED | - |
| Env types | `apps/api/src/env.ts` | NOT_STARTED | - |
| Worker | `apps/api/src/worker.ts` | NOT_STARTED | - |
| Local server | `apps/api/src/server.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: D1 migrations

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `apps/api/migrations/{0001_init,0002_system_tags}.sql`
**Dependencies**: None

**Completion Criteria**:
- [ ] Every table, index and check constraint from the design doc
- [ ] Four system tags seeded with fixed ids
- [ ] No `;` inside any quoted literal
- [ ] Applied cleanly by the migration runner in a test

### TASK-002: Workers entry point

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/api/src/{env,worker}.ts`
**Dependencies**: infrastructure-http:TASK-004

**Completion Criteria**:
- [ ] `fetch` and `email` handlers
- [ ] Per-isolate app caching that never caches failures
- [ ] `setReject` on a rejected ingest
- [ ] Unit tests as listed

### TASK-003: Local Bun/Node server

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/api/src/server.ts`
**Dependencies**: TASK-001, infrastructure-http:TASK-004

**Completion Criteria**:
- [ ] Migrations applied before serving
- [ ] System tags seeded
- [ ] Dev-only `/dev/inbound` route
- [ ] Tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| TASK-002, TASK-003 | `infrastructure-http.md` | BLOCKED until Phase 4 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: TASK-001 has no dependencies and is needed early by
`adapter-layer.md`'s repository integration tests.

## Related Plans

- **Previous**: `impl-plans/infrastructure-http.md`
- **Next**: `impl-plans/app-web-client.md`, `impl-plans/app-cli.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
