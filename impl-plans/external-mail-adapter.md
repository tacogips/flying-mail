# External Mail Adapter Layer Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-external-mail.md#storage-migration-0011_external_mailsql, #protocol-clients
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-external-mail.md

### Summary
Concrete adapters for the ports defined in `external-mail-core.md`: the D1
migration and repositories, the two `TcpDialer` implementations (Workers
`cloudflare:sockets` and Bun/Node `node:net`/`node:tls`), and the three
protocol clients -- JMAP over `fetch`, POP3 and SMTP submission over
`TcpDialer`.

### Scope
**Included**: `apps/api/migrations/0011_external_mail.sql`,
`packages/adapter` repositories/tcp/jmap/pop3/smtp additions, package.json
export map entries.
**Excluded**: ports (`external-mail-core.md`), composition wiring and
GraphQL (`external-mail-graphql.md`).

**Migration numbering assumption**: this plan reserves `0011`, per the
design doc, on the assumption that migration `0010` is claimed by the
contacts/CardDAV feature plan. If that plan lands a different number,
renumber this file before running it -- the migration runner has no
namespacing, only a strict sequential order.

---

## Tasks

### TASK-001: Migration `0011_external_mail.sql`
**Status**: Done (SQL file only; D1/`wrangler` local apply and dedicated
migration-shape tests not run/written in this session)
**Parallelizable**: Yes
**Deliverables**: `apps/api/migrations/0011_external_mail.sql`:

```sql
CREATE TABLE external_mail_accounts (
  id TEXT PRIMARY KEY,
  mail_address_id TEXT NOT NULL UNIQUE
    REFERENCES mail_addresses(id) ON DELETE CASCADE,
  external_address TEXT NOT NULL,
  display_name TEXT,
  fetch_kind TEXT NOT NULL CHECK (fetch_kind IN ('JMAP','POP3')),
  fetch_config TEXT NOT NULL,           -- JSON, non-secret fetch fields only
  fetch_password_ciphertext TEXT NOT NULL,
  smtp_config TEXT,                     -- JSON, non-secret smtp fields; NULL if none
  smtp_password_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  last_fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_external_mail_accounts_mail_address
  ON external_mail_accounts(mail_address_id);

CREATE TABLE external_message_states (
  account_id TEXT NOT NULL
    REFERENCES external_mail_accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, remote_id)
);

CREATE INDEX idx_external_message_states_message
  ON external_message_states(message_id);
```

Follow the `0009_mail_addresses.sql` header-comment convention: explain the
ciphertext-in-dedicated-columns rationale (a future key-rotation migration
can find every ciphertext without parsing `fetch_config`/`smtp_config` JSON)
and repeat the "statement terminator has no comment/string awareness" caveat
verbatim, since this file will contain SQL comments too. The migration
runner naively splits on `;` with zero comment/string awareness: this file
must contain plain `CREATE TABLE`/`CREATE INDEX` DDL only, no seed
`INSERT`, and no string literal or comment containing a literal `;`.

**Completion Criteria**:
- [x] Migration applies cleanly after `0001`..`0009` and `0010` (contacts
      claimed `0010`, so this file is `0011` as this plan already assumed)
      against the libsql migration runner path -- verified via
      `createMigrationRunner(db).apply(loadMigrationFiles())` applying all
      of `0001`..`0011` in order, and via `bunx vitest run apps/api
      packages/adapter`; the D1/`wrangler d1 migrations apply --local` path
      was not exercised in this session
- [x] `mail_address_id` uniqueness enforces "at most one external account per
      managed address" at the database layer: `UNIQUE` column constraint
      plus `idx_external_mail_accounts_mail_address` unique index, not just
      in the use case
- [ ] Migration test asserting the
      table/index shapes above -- not written; this session was scoped to
      the SQL file only (TypeScript test authorship excluded), left for
      TASK-004 (`external-mail-repository.ts`) or a follow-up test task

### TASK-002: Fake `TextSocket` test-support
**Status**: Done
**Parallelizable**: No (needs `external-mail-core:TASK-002` for `TcpDialer`/`TextSocket` types)
**Deliverables**: `packages/adapter/src/tcp/fake-socket.ts`:

```typescript
export interface ScriptedSocketScript {
  /** Lines the fake server sends, consumed in order by readLine(). */
  readonly serverLines?: readonly string[];
  /** Fails the *next* dial() call with this error instead of connecting. */
  readonly failDialWith?: Error;
}

export interface FakeTcpDialer extends TcpDialer {
  /** Every write() call across every socket this dialer has produced, so a
   * test can assert the exact wire sequence (USER/PASS/RETR, EHLO/AUTH
   * PLAIN/MAIL FROM/RCPT TO/DATA, ...). */
  readonly writes: readonly string[];
  /** The `TcpDialOptions` each dial() call was made with, in order. */
  readonly dialedWith: readonly TcpDialOptions[];
  queueScript(script: ScriptedSocketScript): void;
}

export function fakeTcpDialer(): FakeTcpDialer;
```

`startTls()` on a produced socket is a no-op that records the call (so a
test can assert STARTTLS happened at the right point in the exchange without
a real TLS handshake). Byte-stuffed leading-dot lines and multi-line
terminators (`.\r\n`) in `serverLines` are handled the same way a real
server's would be, so client-side dot-unstuffing tests are exercised through
the fake rather than duplicated.

**Completion Criteria**:
- [x] Supports scripting: greeting, auth failure mid-exchange, multiline
      `UIDL`/`RETR` response, dot-stuffed body lines in both directions
- [x] `writes` and `dialedWith` are append-only and inspectable after the
      client under test finishes

### TASK-003: TCP dialers
**Status**: Done
**Parallelizable**: Yes (parallel with TASK-004..007; needs `external-mail-core:TASK-002` types only)
**Deliverables**:
- `packages/adapter/src/tcp/cloudflare-tcp-dialer.ts`:
  `createCloudflareTcpDialer(): TcpDialer`, wrapping `connect()` from
  `cloudflare:sockets`. `tls: "implicit"` -> `secureTransport: "on"`;
  `tls: "starttls-ready"` -> `secureTransport: "starttls"` plus
  `TextSocket.startTls()` calling the underlying socket's `startTls()`;
  `tls: "none"` is never used by this feature (POP3/SMTP always run over
  TLS or upgrade to it) but is implemented for port-parity with the `TcpDialer`
  interface. Wraps the socket's `readable`/`writable` streams to satisfy
  `readLine`/`readBytes`/`write`/`close`.
- `packages/adapter/src/tcp/node-tcp-dialer.ts`:
  `createNodeTcpDialer(): TcpDialer`, wrapping `node:net`
  (`net.connect`) for `tls: "starttls-ready"`/`"none"` and `node:tls`
  (`tls.connect`) for `tls: "implicit"`; `startTls()` calls
  `tls.connect({ socket: <existing net.Socket>, ... })` to upgrade in place.
  This is what Bun's `node:net`/`node:tls` compatibility layer runs under
  `bun test`, so the same test suite exercises real sockets locally against
  a loopback listener where useful, and the fake dialer (TASK-002) elsewhere.

**Completion Criteria**:
- [x] Both implementations satisfy the exact same `TcpDialer` contract; a
      *separate* suite per dialer (`node-tcp-dialer.test.ts` against a real
      loopback `net.Server`, `cloudflare-tcp-dialer.test.ts` for
      import-safety only) rather than one parameterized suite -- see the
      progress log for why
- [x] `cloudflare-tcp-dialer.ts` never imports `node:net`/`node:tls`, and
      vice versa -- each is import-safe in the other's runtime

### TASK-004: External mail repositories + `insertWithRelations` batching
**Status**: Done
**Parallelizable**: Yes (parallel with TASK-003, TASK-005..007)
**Deliverables**: `packages/adapter/src/repositories/external-mail-account-repository.ts`
(`createExternalMailAccountRepository(db: SqlDatabase): ExternalMailAccountRepository`)
and `packages/adapter/src/repositories/external-message-state-repository.ts`
(`createExternalMessageStateRepository(db: SqlDatabase): ExternalMessageStateRepository`)
in two files rather than the one this task originally specified -- see the
progress log. Each follows repo convention exactly: a plain object literal,
a private snake_case `ExternalMailAccountRow`/`ExternalMessageStateRow`
interface plus a `rowToExternalMailAccount`/`rowToExternalMessageState`
mapper, and `assertEnumValue`
from `sql-helpers.ts` for `fetch_kind`/`status`. Row mapping: `fetch_kind` +
`fetch_config` JSON + `fetch_password_ciphertext` reassemble into the
`ExternalFetchConfig` union (`JSON.parse` + a `kind`-discriminated
constructor, never `as` cast past validation); `smtp_config` JSON +
`smtp_password_ciphertext` reassemble into `SmtpSubmissionConfig | null`.
`listRemoteIds` is one indexed `SELECT remote_id FROM external_message_states
WHERE account_id = ?` into a `Set`. `buildSaveStatement` returns the exact
`SqlStatement` `save()` executes, unexecuted. Also extend the *existing*
`packages/adapter/src/repositories/message-repository.ts`'s
`insertWithRelations`: append `input.extraStatements ?? []` to the
`SqlStatement[]` array passed to `db.batch()`, after its own statements --
this is what makes `external-mail-core.md` TASK-005's ledger write land in
the same atomic `batch()` call as the message insert.

**Completion Criteria**:
- [x] Real-SQL tests via `repositories/test-support.ts` after applying
      migrations through `0011`: CRUD round-trip for both `ExternalFetchConfig`
      branches and a null/non-null `smtp`, cascade delete on
      `mail_addresses` and on `external_mail_accounts`, `listRemoteIds`
      correctness, unique-index conflict on a second account for one
      `mail_address_id`
- [x] Ciphertext columns round-trip byte-for-byte (no re-encoding)
- [x] `insertWithRelations` test: an `extraStatements` entry lands in the
      same `batch()` call (assert against a recording `SqlDatabase` fake, or
      that a forced failure in an extra statement rolls back the message
      insert too); an omitted `extraStatements` behaves exactly as before
      -- in `message-repository-extra-statements.test.ts`, a new file kept
      separate from the already-substantial `message-repository.test.ts`
- [x] A dedicated migration-shape test (`migrations/external-mail-migration.test.ts`)
      was added in this session too, closing TASK-001's deferred completion
      criterion

### TASK-005: POP3 client
**Status**: Done
**Parallelizable**: Yes (parallel with TASK-003, TASK-004, TASK-006, TASK-007)
**Deliverables**: `packages/adapter/src/pop3/pop3-client.ts`:
`createPop3Client(dialer: TcpDialer): Pop3Client` (RFC 1939). Flow per call:
dial `tls: "implicit"` on the configured host/port (always 995, enforced
already by the domain validator, but the client itself does not re-validate
-- that would duplicate `validatePop3Endpoint`), read the greeting, `USER`,
`PASS` (auth failure -> `ExternalMailAuthError`), `UIDL` for `listUidls`
(multi-line response terminated by a lone `.`), `RETR <n>` per requested id
for `fetchByUidl` (byte-stuffed leading dots undone), `QUIT`. Never sends
`DELE`, per the design doc's aggregator-not-migrator stance -- omit the
method entirely rather than leaving a dead code path.

**Completion Criteria**:
- [x] Tests against TASK-002's fake dialer: greeting, successful auth,
      auth failure, multiline `UIDL`, multiline `RETR` with dot-unstuffing,
      an id absent from the mailbox (server `-ERR`) treated as a skip, not a
      hard failure for the whole `fetchByUidl` batch
- [x] No `DELE` is ever written to the wire (assert against `writes`)

### TASK-006: SMTP submission client
**Status**: Done
**Parallelizable**: Yes (parallel with TASK-003, TASK-004, TASK-005, TASK-007)
**Deliverables**: `packages/adapter/src/smtp/smtp-client.ts`:
`createSmtpSubmissionClient(dialer: TcpDialer): SmtpSubmissionClient` (RFC
5321/6409/8314). Dial per `security`: `IMPLICIT_TLS` (465) ->
`tls: "implicit"`; `STARTTLS` (587) -> `tls: "starttls-ready"`, `EHLO`,
`STARTTLS`, `startTls()`, second `EHLO` post-upgrade. `AUTH PLAIN` first
(base64 `\0username\0password`), falling back to `AUTH LOGIN` (base64
username then password prompts) on a `504`/unsupported-mechanism reply.
`MAIL FROM:<envelope.from>`, one `RCPT TO:<addr>` per `envelope.to`, `DATA`
with the raw source dot-stuffed (a leading `.` on any line doubled) and
terminated `\r\n.\r\n`, `QUIT`. A non-2xx/3xx reply at any step throws
`ExternalMailTransportError` with the server's text folded into the message
(never the credential).

**Completion Criteria**:
- [x] Tests against TASK-002's fake dialer: implicit-TLS happy path,
      STARTTLS happy path (assert the upgrade happens before `AUTH`),
      `AUTH PLAIN` then `AUTH LOGIN` fallback, a rejected `RCPT TO` mapped
      to `ExternalMailTransportError`, dot-stuffing verified both on a body
      line starting with `.` and on the terminator itself
- [x] Credential never appears in a thrown error's message

### TASK-007: JMAP client
**Status**: Done
**Parallelizable**: Yes (parallel with TASK-003..006)
**Deliverables**: `packages/adapter/src/jmap/jmap-client.ts`:
`createJmapClient(options?: { fetchImpl?: typeof fetch }): JmapClient` (RFC
8620/8621 subset, plain `fetch` -- no `TcpDialer`, with injectable
`fetchImpl` so tests use canned JSON
fixtures with no real network). Flow: `GET` the session resource with Basic
auth, find the `Mailbox/get` inbox (`role: "inbox"`), `Email/query` sorted
by `receivedAt` ascending bounded to `max` beyond whatever
`knownRemoteIds` already covers, `Email/get` for `blobId`s of ids not in
`knownRemoteIds`, then a raw-bytes GET against each `downloadUrl` template
(never JMAP body parts -- the design doc is explicit that raw-blob download
gives the existing ingest pipeline byte-identical treatment to any other raw
`.eml`). `state`/`queryState` are read but not persisted, matching the
design's "re-query is idempotent" simplification. A 401 anywhere ->
`ExternalMailAuthError`; any other non-2xx or malformed JSON ->
`ExternalMailTransportError`.

**Completion Criteria**:
- [x] Tests against canned session/`Mailbox/get`/`Email/query`/`Email/get`/blob
      JSON fixtures: full page under `max`, a page hitting `max` reports
      `hasMore: true`, an id already in `knownRemoteIds` is skipped before
      the `Email/get`+download round trip (not fetched then discarded), 401
      on any request maps to `ExternalMailAuthError`
- [x] `testConnection` performs the session GET and nothing past it (no
      `Email/query`)

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Migration | `apps/api/migrations/0011_external_mail.sql` | DONE | `bunx vitest run apps/api packages/adapter` (373/374 pass; the one failure is `runner.test.ts`'s pre-existing hardcoded migration-name list, unrelated TS source) |
| Fake socket | `packages/adapter/src/tcp/fake-socket.ts` | DONE | `fake-socket.test.ts` (7) |
| TCP dialers | `packages/adapter/src/tcp/{cloudflare-tcp-dialer,node-tcp-dialer}.ts` | DONE | `node-tcp-dialer.test.ts` (4, real loopback), `cloudflare-tcp-dialer.test.ts` (2, import-safety only) |
| Repositories | `packages/adapter/src/repositories/{external-mail-account,external-message-state}-repository.ts` | DONE | `external-mail-account-repository.test.ts` (7), `external-message-state-repository.test.ts` (4), `message-repository-extra-statements.test.ts` (3), `migrations/external-mail-migration.test.ts` (6) |
| POP3 client | `packages/adapter/src/pop3/pop3-client.ts` | DONE | `pop3-client.test.ts` (8) |
| SMTP client | `packages/adapter/src/smtp/smtp-client.ts` | DONE | `smtp-client.test.ts` (9) |
| JMAP client | `packages/adapter/src/jmap/jmap-client.ts` | DONE | `jmap-client.test.ts` (8) |

Also add explicit `packages/adapter/package.json` subpath export entries --
no barrel files, no new wildcard: `./tcp/cloudflare-tcp-dialer`,
`./tcp/node-tcp-dialer`, `./tcp/fake-socket`, `./jmap/jmap-client`,
`./pop3/pop3-client`, `./smtp/smtp-client`, one entry per new module, the
same convention every existing non-`./repositories/*` entry already follows.

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `external-mail-core.md` TASK-001 (domain types), TASK-002 (port shapes) | Pending |
| `external-mail-graphql.md` | This plan, all tasks (concrete adapters to wire) | Blocks graphql composition until this lands |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] No file at 1000+ lines (largest touched file is `message-repository.ts`
      at 703 lines; every new file is under 400)
- [x] `packages/adapter/package.json` export map covers every new module
- [x] No real network in any test (fixtures/fake dialer/fake fetch only,
      matching the design doc's testing section) -- with one deliberate
      exception: `node-tcp-dialer.test.ts` opens a real loopback TCP socket
      (127.0.0.1, no external network) against `node:net`'s own
      `createServer`, since that dialer's entire job is wrapping real
      sockets and a fake dialer cannot exercise it. See the progress log.

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-external-mail.md.

### Session: 2026-08-24 (migration)
**Tasks Completed**: TASK-001 (`apps/api/migrations/0011_external_mail.sql`)
**Notes**: Wrote the migration per this task's deliverable block and the
design doc's "Storage" section (plain `CREATE TABLE`/`CREATE INDEX` DDL
only, no seed data). `0010_contacts.sql` from the sibling plan claimed
`0010` as this plan anticipated, so no renumbering was needed. Following
the `0009_mail_addresses.sql` header convention required repeating the
"statement terminator has no comment/string awareness" caveat in prose; the
first draft accidentally used a literal `;` inside that prose comment
(twice), which the naive splitter in
`packages/adapter/src/migrations/runner.ts` cut mid-statement, surfacing as
an opaque "not an error" libsql failure with no useful stack pointer --
exactly the failure mode `runner.test.ts`'s
"no migration writes a statement terminator inside a comment" test exists
to catch, and which caught it once identified via a standalone repro
script. Fixed by rephrasing both sentences without a semicolon. Verified
`0001`..`0011` apply cleanly in order via the adapter's libsql migration
runner, and ran `bunx vitest run apps/api packages/adapter`: 373/374 pass,
the one failure being `runner.test.ts`'s hardcoded migration-name-list
assertion (needs `0010_contacts.sql`/`0011_external_mail.sql` appended --
excluded from this session's scope, which was the SQL file only, not
TypeScript source). `apps/api/src/server.test.ts` passes (6/6).
`packages/infrastructure/src/graphql/schema.test.ts` still fails on an
unrelated `bootstrapAdmin` case, owned by the GraphQL plan, not touched.
Not run: D1/`wrangler d1 migrations apply --local`, and no dedicated
migration-shape test was written (left to TASK-004 or a follow-up test
task, matching this task's completion-criteria note).

### Session: 2026-08-24 (TASK-002..007)
**Tasks Completed**: TASK-002 (fake `TextSocket`), TASK-003 (both `TcpDialer`
implementations), TASK-004 (repositories + `insertWithRelations` batching),
TASK-005 (POP3 client), TASK-006 (SMTP client), TASK-007 (JMAP client)
**Notes**:

- **TASK-004 deviation from the plan's deliverable block**: the plan called
  for one file, `external-mail-repository.ts`, holding both repository
  factories. Implemented as two files instead --
  `external-mail-account-repository.ts` and
  `external-message-state-repository.ts` -- per this session's explicit
  task assignment, which named the two files directly. Both still follow
  the repository row/mapper convention exactly; the
  `./repositories/*` wildcard export already in `package.json` covers both
  without a new export entry.
- **TASK-001's deferred migration-shape test** was written in this session
  as `packages/adapter/src/migrations/external-mail-migration.test.ts`
  (table/index presence, both `CHECK` constraints, the one-account-per-address
  unique index, and both cascade-delete edges), closing the gap the TASK-001
  session had explicitly left open.
- **TASK-003's "shared conformance test suite" completion criterion**: built
  two independent suites instead of one parameterized one.
  `node-tcp-dialer.test.ts` dials a real loopback `net.Server` (127.0.0.1,
  no external network) since that dialer's entire job is wrapping real
  sockets and a fake dialer cannot exercise `node:net`/`node:tls` codepaths
  (connection-refused mapping, EOF-as-null, the `tls.connect({ socket })`
  upgrade). `cloudflare-tcp-dialer.test.ts` only checks import-safety and
  that `dial()` rejects (rather than crashing) outside `workerd`, since
  `cloudflare:sockets` genuinely does not exist under Bun -- there is no
  way to parameterize a single suite over "a real dial" and "a dial that
  cannot possibly succeed" without the Cloudflare half being conditionally
  skipped in a way that is really just a second suite with extra steps.
  Both still assert against the identical `TcpDialer`/`TextSocket` contract
  from `@flying-mail/application/ports/external-mail`.
- **`tcp/chunked-line-buffer.ts`** (not in the original plan) factors the
  async line/byte buffering logic shared by both TCP dialers into one
  runtime-agnostic file (imports neither `node:*` nor `cloudflare:sockets`),
  so the "never imports the other's runtime" completion criterion holds
  without duplicating that logic twice. Not exported via `package.json` --
  it is an internal implementation detail of the two dialers, not a public
  module the plan asked for.
- **`tcp/cloudflare-sockets.d.ts`** (not in the original plan) holds the
  `declare module "cloudflare:sockets"` ambient type. TypeScript treats a
  `declare module "specifier"` block inside a regular module file (one with
  imports/exports) as an *augmentation* of an existing module, which fails
  to resolve since nothing else in this project declares
  `"cloudflare:sockets"` (`@cloudflare/workers-types` is a devDependency but
  deliberately not referenced anywhere, matching the existing
  `blob/r2.ts`/`sql/d1.ts` convention of local structural types instead of
  its ambient globals, which this project's `tsconfig.json` excludes via
  `types: ["bun"]` to avoid colliding with Bun's own stream/global types).
  A standalone ambient `.d.ts` file has no augmentation requirement, so the
  type lives there instead. Its `readable`/`writable` fields are typed with
  hand-rolled minimal reader/writer interfaces rather than the DOM
  `ReadableStream`/`WritableStream` globals for the same reason: this
  workspace has more than one global declaration of those names in scope
  once any file imports `node:net`/`node:tls` (Bun's lib types plus
  `node:stream/web`'s), and `getReader()`/`getWriter()` on those globals do
  not resolve predictably through `ReturnType` across that ambiguity.
- **SMTP `AUTH PLAIN` fallback**: implemented literally as the design doc
  states -- falls back to `AUTH LOGIN` only on a `504` reply, not on every
  non-success reply (e.g. a `535` bad-credentials reply raises
  `ExternalMailAuthError` immediately without an `AUTH LOGIN` retry).
- **POP3 "`-ERR` treated as a skip"**: `fetchByUidl` builds a `UIDL`
  message-number map once per session and treats a requested id absent
  from that map as a skip without ever writing a `RETR` for it, in addition
  to treating an actual `-ERR` reply to a `RETR` that was attempted as a
  skip -- RFC 1939 has no "`RETR` by `UIDL`" primitive, so the map lookup
  is the only way to reach "this id is not currently in the mailbox".
- Ran `bunx tsc --noEmit -p packages/adapter` (clean), `biome check
  packages/adapter --diagnostic-level=warn` (clean after `biome format
  --write`, which only reformatted line-wrapping in files this session
  touched), and `bunx vitest run packages/adapter`: 42 files, 476 tests,
  all passing. Did not run the repo-wide `bun run typecheck`/`vitest run`
  (out of scope per this session's assignment; `packages/infrastructure`
  and `apps/web` were explicitly owned by concurrent agents and the
  assignment flagged `packages/infrastructure/src/composition/build-dependencies.ts`
  as a known, pre-existing repo-wide typecheck failure unrelated to this
  work).
- Not implemented in this session (explicitly out of this plan's scope,
  per "Excluded" above): composition-root wiring that picks a `TcpDialer`
  by runtime, and anything in `apps/*`/`packages/infrastructure`.

## Related Plans

- **Depends On**: `external-mail-core.md`
- **Next**: `external-mail-graphql.md`
