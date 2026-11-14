# Application Ports and Policies Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-storage-and-file-links.md,
design-docs/specs/design-api-keys-and-permissions.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
`@mailcal/application`'s outward-facing contracts: infrastructure ports,
repository ports, the `AppDependencies` bundle, `ApplicationError`, the
`Viewer` union, and the single authorization policy module every use case
delegates to.

### Scope
**Included**: `packages/application/src/{errors.ts,dependencies.ts,ports/*,policies/*,test-support/*}`
**Excluded**: use cases (separate plans), concrete adapters.

---

## Modules

### 1. Errors

#### packages/application/src/errors.ts

**Status**: NOT_STARTED

```typescript
type ApplicationErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND"
  | "BAD_USER_INPUT" | "CONFLICT" | "SERVICE_UNAVAILABLE";

abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;
  constructor(message: string, readonly cause?: unknown);
}

class UnauthenticatedError extends ApplicationError {}   // UNAUTHENTICATED
class ForbiddenError extends ApplicationError {}         // FORBIDDEN
class NotFoundError extends ApplicationError {           // NOT_FOUND
  constructor(entity: string, id: string);
}
class BadUserInputError extends ApplicationError {       // BAD_USER_INPUT
  constructor(message: string, readonly field?: string);
}
class ConflictError extends ApplicationError {}          // CONFLICT
class ServiceUnavailableError extends ApplicationError {} // SERVICE_UNAVAILABLE
```

**Checklist**:
- [ ] Six subclasses, `code` 1:1 with GraphQL `extensions.code`
- [ ] Unit tests

---

### 2. Infrastructure ports

#### packages/application/src/ports/sql-database.ts

**Status**: NOT_STARTED

```typescript
type SqlValue = string | number | null | Uint8Array;
interface SqlStatement { readonly sql: string; readonly params?: readonly SqlValue[]; }
interface SqlDatabase {
  query<T>(sql: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>;
  batch(statements: readonly SqlStatement[]): Promise<void>;
}
```

Document why there is no `transaction(fn)`: D1 has no interactive
transactions; `batch()` is the atomic primitive on both D1 and SQLite.

#### packages/application/src/ports/blob-store.ts

**Status**: NOT_STARTED

```typescript
interface BlobObject {
  readonly body: ReadableStream;
  readonly contentType: string | null;
  readonly size: number;
}
interface BlobStore {
  put(key: string, body: Uint8Array | ReadableStream,
      opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}
```

#### packages/application/src/ports/runtime-ports.ts

**Status**: NOT_STARTED

```typescript
interface Clock { now(): Date; }
interface RandomSource { uuid(): string; tokenBytes(length: number): Uint8Array; }
interface TokenHasher { hash(value: string): Promise<string>; }
```

#### packages/application/src/ports/mime.ts

**Status**: NOT_STARTED

```typescript
interface ParsedMimeAddress { readonly address: string; readonly name: string | null; }

interface ParsedMimeAttachment {
  readonly fileName: string | null;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly contentId: string | null;
  readonly inline: boolean;
}

interface ParsedMime {
  readonly from: ParsedMimeAddress | null;
  readonly to: readonly ParsedMimeAddress[];
  readonly cc: readonly ParsedMimeAddress[];
  readonly bcc: readonly ParsedMimeAddress[];
  readonly replyTo: readonly ParsedMimeAddress[];
  readonly subject: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly date: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly ParsedMimeAttachment[];
  readonly headers: ReadonlyMap<string, string>;
}

interface MimeParser {
  parse(raw: ReadableStream | Uint8Array): Promise<ParsedMime>;
}

interface BuildMimeInput {
  readonly from: ParsedMimeAddress;
  readonly to: readonly ParsedMimeAddress[];
  readonly cc?: readonly ParsedMimeAddress[];
  readonly bcc?: readonly ParsedMimeAddress[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly date: string;
  readonly headers?: ReadonlyMap<string, string>;
  readonly attachments?: readonly BuildMimeAttachment[];
}

interface MimeBuilder { build(input: BuildMimeInput): string; }
```

#### packages/application/src/ports/mail-sender.ts

**Status**: NOT_STARTED

```typescript
interface OutboundMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers?: ReadonlyMap<string, string>;
  readonly raw?: string;
}
interface MailSender { send(mail: OutboundMail): Promise<void>; }
```

**Checklist** (ports):
- [ ] Five port files, types only, no logic
- [ ] Doc comments naming each concrete implementation

---

### 3. Repository ports

#### packages/application/src/ports/mail-domain-repository.ts
#### packages/application/src/ports/message-repository.ts
#### packages/application/src/ports/tag-repository.ts
#### packages/application/src/ports/api-key-repository.ts
#### packages/application/src/ports/file-link-repository.ts
#### packages/application/src/ports/auth-repository.ts

**Status**: NOT_STARTED

```typescript
interface MailDomainRepository {
  findById(id: DomainId): Promise<MailDomain | null>;
  findByName(name: DomainName): Promise<MailDomain | null>;
  list(): Promise<readonly MailDomain[]>;
  save(domain: MailDomain): Promise<void>;
  delete(id: DomainId): Promise<void>;
  countMessages(id: DomainId): Promise<number>;
}

interface MessageListFilter {
  readonly domainIds?: readonly DomainId[];
  readonly direction?: MessageDirection;
  readonly address?: EmailAddress;
  readonly toAddress?: EmailAddress;
  readonly fromAddress?: EmailAddress;
  readonly threadId?: ThreadId;
  readonly tagIds?: readonly TagId[];
  readonly excludeTagIds?: readonly TagId[];
  readonly unreadOnly?: boolean;
  readonly search?: string;
  readonly since?: string;
  readonly until?: string;
  /** Address-pattern allowlist derived from the viewer's scopes; `null`
   *  means unrestricted (admin/user viewer). */
  readonly allowedPatterns: readonly AddressPattern[] | null;
  /** Restrict to rows whose fetch state for this key is NOT_FETCHED / FETCHED. */
  readonly fetchStatus?: { readonly apiKeyId: ApiKeyId; readonly status: FetchStatus };
}

interface MessagePage {
  readonly nodes: readonly Message[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

interface MessageRepository {
  findById(id: MessageId): Promise<Message | null>;
  findByRfcMessageId(rfcMessageId: string): Promise<Message | null>;
  findThreadIdByReferences(refs: readonly string[]): Promise<ThreadId | null>;
  list(filter: MessageListFilter, limit: number,
       cursor: string | null): Promise<MessagePage>;
  listByThread(threadId: ThreadId): Promise<readonly Message[]>;
  listRecipients(ids: readonly MessageId[]):
    Promise<ReadonlyMap<string, readonly MessageRecipient[]>>;
  /** Atomic insert of message + recipients + attachments + tag rows. */
  insertWithRelations(input: InsertMessageInput): Promise<void>;
  save(message: Message): Promise<void>;
  delete(ids: readonly MessageId[]): Promise<number>;
  setRead(ids: readonly MessageId[], readAt: string | null): Promise<void>;

  listAttachments(ids: readonly MessageId[]):
    Promise<ReadonlyMap<string, readonly Attachment[]>>;
  findAttachmentById(id: AttachmentId): Promise<Attachment | null>;
  saveAttachment(attachment: Attachment): Promise<void>;

  listTagIds(ids: readonly MessageId[]):
    Promise<ReadonlyMap<string, readonly TagId[]>>;
  addTags(messageIds: readonly MessageId[], tagIds: readonly TagId[],
          taggedAt: string): Promise<void>;
  removeTags(messageIds: readonly MessageId[],
             tagIds: readonly TagId[]): Promise<void>;

  findFetchStates(apiKeyId: ApiKeyId, ids: readonly MessageId[]):
    Promise<ReadonlyMap<string, MessageFetchState>>;
  saveFetchStates(states: readonly MessageFetchState[]): Promise<void>;
}

interface TagRepository {
  findById(id: TagId): Promise<Tag | null>;
  findByName(name: string): Promise<Tag | null>;
  findBySystemSlug(slug: SystemTagSlug): Promise<Tag | null>;
  list(): Promise<readonly Tag[]>;
  countMessages(ids: readonly TagId[]): Promise<ReadonlyMap<string, number>>;
  save(tag: Tag): Promise<void>;
  delete(id: TagId): Promise<void>;
}

interface ApiKeyRepository {
  findByKeyHash(keyHash: string): Promise<ApiKey | null>;
  findById(id: ApiKeyId): Promise<ApiKey | null>;
  list(): Promise<readonly ApiKey[]>;
  save(key: ApiKey): Promise<void>;
  listScopes(ids: readonly ApiKeyId[]):
    Promise<ReadonlyMap<string, readonly ApiKeyScope[]>>;
  findScopeById(id: ApiKeyScopeId): Promise<ApiKeyScope | null>;
  saveScope(scope: ApiKeyScope): Promise<void>;
  deleteScope(id: ApiKeyScopeId): Promise<void>;
}

interface FileLinkRepository {
  findById(id: FileLinkId): Promise<FileLink | null>;
  findByTokenHash(tokenHash: string): Promise<FileLink | null>;
  listByMessage(messageId: MessageId): Promise<readonly FileLink[]>;
  save(link: FileLink): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}

// auth-repository.ts exports UserRepository, SessionRepository and
// EmailAuthChallengeRepository with the same shapes as the reference project.
```

**Checklist**:
- [ ] Six repository port files
- [ ] `MessageListFilter.allowedPatterns` documented as the scope-derived filter

---

### 4. Dependencies bundle

#### packages/application/src/dependencies.ts

**Status**: NOT_STARTED

```typescript
type SignupMode = "open" | "closed";

interface InstanceConfig {
  readonly signupMode: SignupMode;
  readonly publicOrigin: string | null;
  readonly spamThreshold: number;
  readonly fileLinkMaxTtlSeconds: number;
}

interface AppDependencies {
  readonly db: SqlDatabase;
  readonly blobs: BlobStore;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly tokenHasher: TokenHasher;
  readonly mimeParser: MimeParser;
  readonly mimeBuilder: MimeBuilder;
  readonly mailSender: MailSender;

  readonly mailDomainRepository: MailDomainRepository;
  readonly messageRepository: MessageRepository;
  readonly tagRepository: TagRepository;
  readonly apiKeyRepository: ApiKeyRepository;
  readonly fileLinkRepository: FileLinkRepository;
  readonly userRepository: UserRepository;
  readonly sessionRepository: SessionRepository;
  readonly emailAuthChallengeRepository: EmailAuthChallengeRepository;

  readonly instanceConfig: InstanceConfig;
}
```

---

### 5. Viewer and authorization policy

#### packages/application/src/policies/viewer.ts

**Status**: NOT_STARTED

```typescript
type Viewer =
  | { readonly kind: "USER"; readonly userId: UserId; readonly role: UserRole }
  | { readonly kind: "API_KEY"; readonly apiKeyId: ApiKeyId;
      readonly scopes: readonly ApiKeyScope[] };

function isAdminViewer(viewer: Viewer): boolean;
function viewerApiKeyId(viewer: Viewer): ApiKeyId | null;
```

#### packages/application/src/policies/authorization.ts

**Status**: NOT_STARTED

```typescript
/** Throws UnauthenticatedError when viewer is null. */
function requireViewer(viewer: Viewer | null): Viewer;

/** Instance-wide capability (DOMAIN_ADMIN / KEY_ADMIN). ADMIN users pass;
 *  MEMBER users never do; API keys need a matching scope. */
function requireGlobalCapability(viewer: Viewer, capability: Capability): void;

/** Per-address capability. ADMIN and MEMBER users pass for every active
 *  domain; API keys need a scope matching (capability, domainId, address). */
function requireAddressCapability(
  viewer: Viewer,
  capability: Capability,
  domainId: DomainId,
  addresses: readonly EmailAddress[],
): void;

/** Non-throwing form used by listing code. */
function authorizesAnyAddress(
  viewer: Viewer, capability: Capability,
  domainId: DomainId, addresses: readonly EmailAddress[],
): boolean;

/** Address patterns the viewer may read, for MessageListFilter;
 *  `null` for user viewers (unrestricted). */
function readableAddressPatterns(
  viewer: Viewer, capability: Capability,
): readonly AddressPattern[] | null;

/** Domain ids the viewer's scopes are limited to, or null for unrestricted. */
function scopedDomainIds(
  viewer: Viewer, capability: Capability,
): readonly DomainId[] | null;
```

`requireAddressCapability` passes when **any** supplied address is
authorized -- a message with several envelope recipients is readable if the
key covers one of them. Reads that fail authorization are reported by callers
as `NotFoundError`, never `ForbiddenError`, so a key cannot probe for
addresses outside its scope (see the design doc).

#### packages/application/src/policies/index.ts

Re-exports both modules.

**Checklist**:
- [ ] Viewer union and helpers
- [ ] Six authorization functions
- [ ] Unit tests: admin user, member user, scoped key hit/miss, global
      capability, wildcard domain, multi-address any-match

---

### 6. Test support

#### packages/application/src/test-support/fakes.ts

**Status**: NOT_STARTED

In-memory fakes for every port plus `createFakeDependencies(overrides)`,
`fixedClock(iso)`, `sequenceRandom(prefix)` and `plainTokenHasher()` so use
case tests need no adapter. Also `viewer-fixtures.ts` with `adminViewer()`,
`memberViewer()` and `scopedKeyViewer(scopes)`.

**Checklist**:
- [ ] Fakes for all ports and repositories
- [ ] Deterministic clock/random/hasher
- [ ] Viewer fixtures

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Errors | `packages/application/src/errors.ts` | NOT_STARTED | - |
| Infra ports | `packages/application/src/ports/{sql-database,blob-store,runtime-ports,mime,mail-sender}.ts` | NOT_STARTED | - |
| Repository ports | `packages/application/src/ports/*-repository.ts` | NOT_STARTED | - |
| Dependencies | `packages/application/src/dependencies.ts` | NOT_STARTED | - |
| Policies | `packages/application/src/policies/{viewer,authorization,index}.ts` | NOT_STARTED | - |
| Test support | `packages/application/src/test-support/{fakes,viewer-fixtures}.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Application errors and infrastructure ports

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/errors.ts`,
`packages/application/src/ports/{sql-database,blob-store,runtime-ports,mime,mail-sender}.ts`
**Dependencies**: domain-model:TASK-001

**Completion Criteria**:
- [ ] Six ApplicationError subclasses
- [ ] Five infrastructure ports with doc comments
- [ ] Typecheck and lint clean

### TASK-002: Repository ports and the dependencies bundle

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/ports/*-repository.ts`,
`packages/application/src/dependencies.ts`
**Dependencies**: TASK-001, domain-model:TASK-002, domain-model:TASK-003, domain-model:TASK-004

**Completion Criteria**:
- [ ] Six repository ports matching the shapes above
- [ ] `AppDependencies` and `InstanceConfig`
- [ ] Typecheck clean

### TASK-003: Viewer and authorization policy

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/policies/{viewer,authorization,index}.ts`
**Dependencies**: TASK-002

**Completion Criteria**:
- [ ] All policy functions implemented
- [ ] Unit tests for admin, member, scoped-key hit and miss
- [ ] `readableAddressPatterns` returns null for user viewers

### TASK-004: In-memory test support

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/test-support/{fakes,viewer-fixtures}.ts`
**Dependencies**: TASK-002

**Completion Criteria**:
- [ ] Fakes for every port
- [ ] Deterministic clock/random/hasher
- [ ] A smoke test proving `createFakeDependencies()` satisfies `AppDependencies`

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `domain-model.md` | BLOCKED until Phase 1 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: Initial plan

## Related Plans

- **Previous**: `impl-plans/domain-model.md`
- **Next**: `impl-plans/application-usecases-mail.md`, `impl-plans/application-usecases-admin.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
