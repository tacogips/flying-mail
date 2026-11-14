# Adapter Layer Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-storage-and-file-links.md,
design-docs/specs/design-mail-pipeline.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
`@mailcal/adapter`: every concrete port implementation -- D1/libsql SQL, R2/S3/
memory blobs, WebCrypto, postal-mime parsing, mimetext building, the
Cloudflare mail sender, the SQL-backed repositories, and the migration runner.

### Scope
**Included**: `packages/adapter/src/**`.
**Excluded**: GraphQL, HTTP, composition (infrastructure plan).

---

## Modules

### 1. SQL adapters

#### packages/adapter/src/sql/d1.ts, libsql.ts

**Status**: NOT_STARTED

```typescript
/** Local structural surfaces so `@cloudflare/workers-types`' ambient globals
 *  never merge into this package's global scope (they collide with Bun's). */
interface D1PreparedStatementLike {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<{ readonly meta: { readonly changes: number } }>;
}
interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T>(statements: readonly D1PreparedStatementLike[]):
    Promise<readonly { readonly results: readonly T[] }[]>;
}
function createD1Database(d1: D1DatabaseLike): SqlDatabase;

/** libsql: `file:` URL or `:memory:`; runs `PRAGMA foreign_keys = ON` and
 *  maps libsql's batch onto the port's atomic `batch()`. */
function createLibsqlDatabase(url: string): SqlDatabase;
function createInMemoryDatabase(): SqlDatabase;
```

**Checklist**:
- [ ] Both adapters with structural binding types
- [ ] Unit tests against hand-rolled fakes (D1) and `:memory:` (libsql)

#### packages/adapter/src/blob/{r2,s3,memory}.ts

**Status**: NOT_STARTED

```typescript
interface R2BucketLike { /* put/get/delete, structural */ }
function createR2BlobStore(r2: R2BucketLike): BlobStore;

interface S3Config {
  readonly endpoint: string; readonly bucket: string;
  readonly accessKeyId: string; readonly secretAccessKey: string;
  readonly region: string; readonly forcePathStyle?: boolean;
}
function createS3BlobStore(config: S3Config): BlobStore;   // via aws4fetch
function createMemoryBlobStore(): BlobStore;
```

**Checklist**:
- [ ] Three blob stores
- [ ] Unit tests with fakes / `fetch` stub

#### packages/adapter/src/crypto.ts

**Status**: NOT_STARTED

```typescript
function createCryptoRandomSource(): RandomSource;   // crypto.randomUUID / getRandomValues
function createSha256TokenHasher(): TokenHasher;     // WebCrypto SHA-256, hex
function toBase64Url(bytes: Uint8Array): string;
function fromBase64Url(value: string): Uint8Array;
```

**Checklist**:
- [ ] Random source, hasher, base64url helpers
- [ ] Unit tests including a known-answer SHA-256 vector and base64url
      round-trip with padding-sensitive lengths

---

### 2. MIME adapters

#### packages/adapter/src/mime/postal-mime-parser.ts

**Status**: NOT_STARTED

```typescript
/** Wraps `postal-mime` behind the MimeParser port. */
function createPostalMimeParser(options?: {
  readonly maxNestingDepth?: number;
  readonly maxHeadersSize?: number;
}): MimeParser;
```

Maps `postal-mime`'s `Email` onto `ParsedMime`: flattens group addresses to
their member mailboxes, splits the space-separated `references` string into an
array, normalizes `Message-ID`/`In-Reply-To` by stripping `<`/`>`, converts
each attachment's `content` to a `Uint8Array`, derives `inline` from
`disposition === "inline"` or a present `contentId`, and lower-cases every
header key into the returned map.

**Checklist**:
- [ ] Adapter with the mapping above
- [ ] Unit tests parsing fixture `.eml` sources: plain text, multipart
      alternative, one with an attachment, one with an inline image (`cid:`),
      one with a group address, one with folded/encoded-word headers

#### packages/adapter/src/mime/mime-builder.ts

**Status**: NOT_STARTED

```typescript
/** Wraps `mimetext` (browser entrypoint -- Workers-safe) behind MimeBuilder. */
function createMimeTextBuilder(): MimeBuilder;
```

Sets sender, recipients, subject, both bodies when present, `Message-ID`,
`Date`, and `In-Reply-To`/`References` when supplied. Custom headers are
applied only after a CR/LF check; a violating value throws rather than
emitting a header the caller did not intend. Attachments are added base64.

**Checklist**:
- [ ] Builder
- [ ] Unit tests: text-only, text+html, threading headers present, attachment
      encoded, CR/LF header value rejected

#### packages/adapter/src/mail/cloudflare-email.ts

**Status**: NOT_STARTED

```typescript
type CloudflareSenderAddress = string & { readonly __brand: unique symbol };
function parseCloudflareSenderAddress(value: string): CloudflareSenderAddress | null;

interface CloudflareSendEmailBinding {
  send(message: {
    readonly from: string; readonly to: string; readonly subject: string;
    readonly text: string; readonly html?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<{ readonly messageId?: string }>;
}

class MailDeliveryError extends Error {}   // intentionally detail-free
function createCloudflareMailSender(binding: CloudflareSendEmailBinding): MailSender;
function createUnavailableMailSender(): MailSender;
```

The sender fans a multi-recipient `OutboundMail` out into one binding call per
recipient, because the binding takes a single `to`. A failure on any recipient
throws `MailDeliveryError`, which carries no provider detail or message
content -- error text from a mail provider routinely echoes addresses and
subjects, and this error reaches clients.

**Checklist**:
- [ ] Sender, unavailable sender, address parser
- [ ] Unit tests: per-recipient fan-out, failure masking, address validation

---

### 3. Repositories

#### packages/adapter/src/repositories/sql-helpers.ts

**Status**: NOT_STARTED

```typescript
function buildInPlaceholders(count: number): string;       // "?,?,?" or "NULL"
function assertEnumValue<T extends string>(
  enumObject: Record<string, T>, value: string, label: string): T;
function isUniqueConstraintViolation(error: unknown): boolean;
function isForeignKeyConstraintViolation(error: unknown): boolean;
function escapeLikePattern(value: string): string;         // pairs with ESCAPE '\'
function encodeCursor(occurredAt: string, id: string): string;
function decodeCursor(cursor: string): { occurredAt: string; id: string } | null;
function boolToSql(value: boolean): number;
function sqlToBool(value: number): boolean;
```

**Checklist**:
- [ ] All helpers, unit tested (including a malformed cursor returning null)

#### packages/adapter/src/repositories/mail-domain-repository.ts
#### packages/adapter/src/repositories/message-repository.ts (+ `-queries.ts`)
#### packages/adapter/src/repositories/tag-repository.ts
#### packages/adapter/src/repositories/api-key-repository.ts
#### packages/adapter/src/repositories/file-link-repository.ts
#### packages/adapter/src/repositories/{user,session,email-auth-challenge}-repository.ts

**Status**: NOT_STARTED

Each exports `create<X>Repository(db: SqlDatabase): XRepository`, maps
snake_case rows onto entities through a private `rowTo<X>` function, and uses
`assertEnumValue` instead of an unchecked cast for every `TEXT`-backed enum.

`message-repository.ts` is the largest and must stay under 1000 lines: put the
`MessageListFilter` -> SQL construction in a sibling
`message-repository-queries.ts` and re-export through the main file.

Key behaviors:
- `insertWithRelations` issues exactly one `batch()` covering the message row,
  every recipient, every attachment and every tag row.
- `list` builds a keyset-paginated query ordered by `(occurred_at DESC, id
  DESC)`, joins `message_recipients` for address filters, applies
  `allowedPatterns` as a generated `OR` of `address = ?` / `address LIKE ?
  ESCAPE '\'` conditions (patterns converted with `escapeLikePattern`, `*`
  becoming `%`), applies `tagIds`/`excludeTagIds` via `EXISTS`/`NOT EXISTS`,
  and joins `message_fetch_states` for the `fetchStatus` filter (a
  `NOT_FETCHED` filter must also match rows with **no** state row).
- `listRecipients`/`listAttachments`/`listTagIds` are batch lookups keyed by
  message id, so GraphQL resolvers never issue N+1 queries.

**Checklist**:
- [ ] Nine repository files
- [ ] Integration tests against `createInMemoryDatabase()` with the real
      migrations applied, covering: insert-with-relations atomicity, keyset
      pagination across a page boundary, address-pattern filtering,
      `NOT_FETCHED` matching absent state rows, tag include/exclude, LIKE
      escaping of a literal `%` in a search term

#### packages/adapter/src/migrations/runner.ts

**Status**: NOT_STARTED

```typescript
interface MigrationFile { readonly name: string; readonly sql: string; }
interface MigrationRunner {
  apply(migrations: readonly MigrationFile[]): Promise<{ applied: readonly string[] }>;
}
function createMigrationRunner(db: SqlDatabase): MigrationRunner;
```

Tracks applied names in a `schema_migrations` table, sorts by plain codepoint
comparison (never `localeCompare`, which is locale-dependent), and splits each
file on `;`.

Race handling uses a ground-truth re-check rather than error classification:
on **any** batch failure, the runner re-queries `schema_migrations` for that
name. Present means another process applied it and this one merely lost the
race (which surfaces either as a DDL collision or as a PRIMARY KEY conflict
on the tracking insert, depending on timing); absent means the failure is
real and is rethrown.

**Checklist**:
- [ ] Runner
- [ ] Unit tests: fresh apply, re-apply is a no-op, ordering, concurrent
      runners converging, a genuinely broken migration still throwing

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| SQL | `packages/adapter/src/sql/{d1,libsql}.ts` | NOT_STARTED | - |
| Blobs | `packages/adapter/src/blob/{r2,s3,memory}.ts` | NOT_STARTED | - |
| Crypto | `packages/adapter/src/crypto.ts` | NOT_STARTED | - |
| MIME parse | `packages/adapter/src/mime/postal-mime-parser.ts` | NOT_STARTED | - |
| MIME build | `packages/adapter/src/mime/mime-builder.ts` | NOT_STARTED | - |
| Mail sender | `packages/adapter/src/mail/cloudflare-email.ts` | NOT_STARTED | - |
| SQL helpers | `packages/adapter/src/repositories/sql-helpers.ts` | NOT_STARTED | - |
| Repositories | `packages/adapter/src/repositories/*-repository.ts` | NOT_STARTED | - |
| Migrations | `packages/adapter/src/migrations/runner.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: SQL, blob and crypto adapters

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/adapter/src/sql/*`, `packages/adapter/src/blob/*`,
`packages/adapter/src/crypto.ts`
**Dependencies**: application-ports-and-policies:TASK-001

**Completion Criteria**:
- [ ] D1, libsql, in-memory SQL
- [ ] R2, S3, memory blob stores
- [ ] Random source, SHA-256 hasher, base64url helpers
- [ ] Unit tests as listed

### TASK-002: MIME parser, builder and mail sender

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/adapter/src/mime/*`, `packages/adapter/src/mail/cloudflare-email.ts`
**Dependencies**: application-ports-and-policies:TASK-001

**Completion Criteria**:
- [ ] postal-mime wrapped behind `MimeParser` with the documented mapping
- [ ] mimetext wrapped behind `MimeBuilder`, CR/LF header guard included
- [ ] Cloudflare sender with per-recipient fan-out and masked failures
- [ ] Fixture-based parse tests covering six message shapes

### TASK-003: SQL helpers and migration runner

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/adapter/src/repositories/sql-helpers.ts`,
`packages/adapter/src/migrations/runner.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] All helpers including cursor encode/decode
- [ ] Migration runner with race tolerance
- [ ] Unit tests as listed

### TASK-004: Domain, tag, api-key and auth repositories

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/adapter/src/repositories/{mail-domain,tag,api-key,user,session,email-auth-challenge}-repository.ts`
**Dependencies**: TASK-003, app-api-migrations:TASK-001,
application-ports-and-policies:TASK-002

**Completion Criteria**:
- [ ] Six repositories with checked enum mapping
- [ ] Integration tests against in-memory libsql with real migrations

### TASK-005: Message and file-link repositories

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/adapter/src/repositories/{message-repository,message-repository-queries,file-link-repository}.ts`
**Dependencies**: TASK-004

**Completion Criteria**:
- [ ] `insertWithRelations` as a single `batch()`
- [ ] Keyset pagination, address-pattern filtering, tag include/exclude
- [ ] `NOT_FETCHED` matches messages with no fetch-state row
- [ ] Batch lookups for recipients/attachments/tags (no N+1)
- [ ] `message-repository.ts` under 1000 lines
- [ ] Integration tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `application-ports-and-policies.md`, `app-api-migrations.md` | BLOCKED until Phase 2 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes
- [ ] No file over 1000 lines

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: Initial plan

## Related Plans

- **Previous**: `impl-plans/application-ports-and-policies.md`
- **Next**: `impl-plans/infrastructure-graphql.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
