# Admin Use Cases Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-api-keys-and-permissions.md,
design-docs/specs/design-storage-and-file-links.md#temp-file-links
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
Domain management, API key issuance, tag CRUD, temp file links, viewer
resolution and passwordless session auth, plus the `UseCases` facade that
binds every use case to `AppDependencies` once at composition time.

### Scope
**Included**: `packages/application/src/usecases/{domains,api-keys,tags,file-links,auth,email-auth,translate-domain-error}.ts`
and `packages/application/src/usecases.ts`.
**Excluded**: mail-path use cases (separate plan).

---

## Modules

### 1. Domain error translation

#### packages/application/src/usecases/translate-domain-error.ts

**Status**: NOT_STARTED

```typescript
/** Maps a @mailcal/domain DomainError onto the matching ApplicationError. */
function translateDomainError(error: unknown): never;
/** Runs `fn`, translating any DomainError it throws. */
function withDomainErrorTranslation<T>(fn: () => T): T;
function withAsyncDomainErrorTranslation<T>(fn: () => Promise<T>): Promise<T>;
```

`ValidationError -> BadUserInputError(field)`,
`SystemTagImmutableError -> ConflictError`,
`InvalidStateTransitionError -> ConflictError`,
`DomainNotVerifiedError -> ConflictError`, any other `DomainError ->
BadUserInputError`, non-domain errors rethrown untouched.

**Checklist**:
- [ ] Three helpers, unit tested per mapping

---

### 2. Domains

#### packages/application/src/usecases/domains.ts

**Status**: NOT_STARTED

```typescript
function createListDomainsUseCase(deps: AppDependencies):
  (viewer: Viewer) => Promise<readonly MailDomain[]>;
function createGetDomainUseCase(deps: AppDependencies):
  (viewer: Viewer, id: DomainId) => Promise<MailDomain | null>;
function createCreateDomainUseCase(deps: AppDependencies):
  (viewer: Viewer, name: string, catchAll: boolean) => Promise<MailDomain>;
function createVerifyDomainUseCase(deps: AppDependencies):
  (viewer: Viewer, id: DomainId) => Promise<MailDomain>;
function createSetDomainStatusUseCase(deps: AppDependencies):
  (viewer: Viewer, id: DomainId, status: DomainStatus) => Promise<MailDomain>;
function createDeleteDomainUseCase(deps: AppDependencies):
  (viewer: Viewer, id: DomainId) => Promise<boolean>;

interface DnsRecord {
  readonly type: "TXT" | "MX" | "CNAME";
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
  readonly purpose: string;
}
/** The records an operator must publish: the ownership TXT, Cloudflare
 *  Email Routing MX records, and an SPF include. */
function buildDomainDnsRecords(domain: MailDomain): readonly DnsRecord[];
```

`createDomain` requires `DOMAIN_ADMIN`, rejects a duplicate name with
`ConflictError`, and mints a 32-byte verification token. `verifyDomain` marks
it verified and `ACTIVE` -- **actual DNS lookup is out of scope for the
Worker runtime**, so verification is an explicit operator assertion; the use
case records who asserted it and when. `deleteDomain` refuses while the
domain still has messages (`ConflictError`), so mail is never orphaned by a
config change.

Listing is scoped: an API key sees only domains reachable through its scopes;
a user sees all.

**Checklist**:
- [ ] Six use cases plus `buildDomainDnsRecords`
- [ ] Unit tests: non-admin rejection, duplicate name, unverified-to-active
      guard, delete-with-messages refusal, scoped listing

---

### 3. API keys

#### packages/application/src/usecases/api-keys.ts

**Status**: NOT_STARTED

```typescript
const API_KEY_PREFIX = "ybm";

interface GeneratedApiKey {
  readonly secret: string;     // ybm_<prefix>_<random>; returned once
  readonly keyPrefix: string;
  readonly keyHash: string;
}
function generateApiKeySecret(deps: AppDependencies): Promise<GeneratedApiKey>;

interface CreateApiKeyUseCaseInput {
  readonly name: string;
  readonly scopes: readonly {
    readonly capability: Capability;
    readonly domainId: DomainId | null;
    readonly addressPattern: string;
  }[];
  readonly expiresAt: string | null;
}

interface ApiKeyWithSecret { readonly apiKey: ApiKey; readonly secret: string; }

function createCreateApiKeyUseCase(deps: AppDependencies):
  (viewer: Viewer, input: CreateApiKeyUseCaseInput) => Promise<ApiKeyWithSecret>;
function createRevokeApiKeyUseCase(deps: AppDependencies):
  (viewer: Viewer, id: ApiKeyId) => Promise<ApiKey>;
function createListApiKeysUseCase(deps: AppDependencies):
  (viewer: Viewer) => Promise<readonly ApiKey[]>;
function createAddApiKeyScopeUseCase(deps: AppDependencies): /* ... */;
function createRemoveApiKeyScopeUseCase(deps: AppDependencies): /* ... */;
```

Every operation requires `KEY_ADMIN`. `createApiKey` rejects an empty scope
list (`BadUserInputError`) -- an unscoped key is useless and its existence
would be a trap. Each scope's `addressPattern` is validated through
`createAddressPattern`, and a non-null `domainId` must resolve.

**Privilege guard**: a key-issuing *API key* viewer may only grant scopes it
itself holds, so `KEY_ADMIN` cannot be used to escalate beyond the issuing
key's own reach. An `ADMIN` user viewer may grant anything.

The plaintext secret exists only in the returned value; it is never logged and
never stored.

**Checklist**:
- [ ] Five use cases plus `generateApiKeySecret`
- [ ] Unit tests: empty scope rejection, invalid pattern, unknown domain,
      escalation guard, revoke idempotency, secret returned exactly once

---

### 4. Tags

#### packages/application/src/usecases/tags.ts

**Status**: NOT_STARTED

```typescript
function createListTagsUseCase(deps: AppDependencies):
  (viewer: Viewer) => Promise<readonly Tag[]>;
function createCreateTagUseCase(deps: AppDependencies):
  (viewer: Viewer, name: string, color: string | null) => Promise<Tag>;
function createRenameTagUseCase(deps: AppDependencies):
  (viewer: Viewer, id: TagId, name: string, color: string | null) => Promise<Tag>;
function createDeleteTagUseCase(deps: AppDependencies):
  (viewer: Viewer, id: TagId) => Promise<boolean>;
/** Seeds SPAM/TRASH/ARCHIVED/STARRED when absent; safe to call repeatedly. */
function createEnsureSystemTagsUseCase(deps: AppDependencies):
  () => Promise<readonly Tag[]>;
```

`MAIL_MANAGE` (global form) is required for mutations. Duplicate names raise
`ConflictError`; system tags reject rename/delete via the domain guard,
translated to `CONFLICT`.

**Checklist**:
- [ ] Five use cases
- [ ] Unit tests: duplicate name, system-tag immutability, idempotent seeding

---

### 5. File links

#### packages/application/src/usecases/file-links.ts

**Status**: NOT_STARTED

```typescript
interface CreatedFileLink {
  readonly link: FileLink;
  readonly token: string;   // returned once; only its hash is stored
  readonly url: string;     // absolute when publicOrigin is set, else /files/<token>
}

function createCreateAttachmentLinkUseCase(deps: AppDependencies):
  (viewer: Viewer, attachmentId: AttachmentId,
   ttlSeconds: number, maxDownloads: number | null) => Promise<CreatedFileLink>;

function createCreateRawMessageLinkUseCase(deps: AppDependencies):
  (viewer: Viewer, messageId: MessageId,
   ttlSeconds: number, maxDownloads: number | null) => Promise<CreatedFileLink>;

function createRevokeFileLinkUseCase(deps: AppDependencies):
  (viewer: Viewer, id: FileLinkId) => Promise<boolean>;

function createListFileLinksUseCase(deps: AppDependencies):
  (viewer: Viewer, messageId: MessageId | null) => Promise<readonly FileLink[]>;

interface FileLinkDownload {
  readonly link: FileLink;
  readonly blob: BlobObject;
  readonly fileName: string;
  readonly contentType: string;
}
/** Unauthenticated: the token IS the credential. Returns null for every
 *  failure mode so the caller can answer a uniform 404. */
function createResolveFileLinkUseCase(deps: AppDependencies):
  (token: string) => Promise<FileLinkDownload | null>;
```

Minting requires `FILE_LINK` **and** read authorization on the owning message,
so a link never widens its creator's reach. `ttlSeconds` is clamped to
`[60, instanceConfig.fileLinkMaxTtlSeconds]`; `maxDownloads`, when given, must
be >= 1. The token is 32 random bytes base64url-encoded; only its SHA-256 hash
is persisted.

`resolveFileLink` hashes the presented token, loads by hash, checks
usability, increments the download count **before** streaming, then fetches
the blob. Any failure -- unknown, expired, revoked, exhausted, missing blob,
or an unexpected repository error -- returns `null`.

**Checklist**:
- [ ] Five use cases
- [ ] Unit tests: TTL clamping, scope requirement, expired/revoked/exhausted
      all returning null, download counter increments, missing blob returns null

---

### 6. Viewer resolution and auth

#### packages/application/src/usecases/auth.ts

**Status**: NOT_STARTED

```typescript
/** Resolves a presented bearer/cookie token to a Viewer: session first,
 *  then API key. Returns null for anything unusable; never throws. */
function createResolveViewerFromTokenUseCase(deps: AppDependencies):
  (token: string) => Promise<Viewer | null>;

function createLogoutUseCase(deps: AppDependencies):
  (token: string) => Promise<boolean>;

function createGetViewerUserUseCase(deps: AppDependencies):
  (viewer: Viewer) => Promise<User | null>;
```

API key resolution loads the key by hash, checks `isApiKeyUsable`, loads its
scopes, and records `lastUsedAt` as fire-and-forget work that never blocks or
fails the request.

#### packages/application/src/usecases/email-auth.ts

**Status**: NOT_STARTED

```typescript
function createRequestEmailAuthUseCase(deps: AppDependencies):
  (email: string) => Promise<boolean>;
function createVerifyEmailAuthTokenUseCase(deps: AppDependencies):
  (token: string) => Promise<{ readonly session: Session;
                               readonly token: string;
                               readonly user: User }>;
function createBootstrapAdminUseCase(deps: AppDependencies):
  (email: string, name: string) => Promise<User>;
```

`requestEmailAuth` always returns `true`, whether or not the address is known,
so the endpoint cannot enumerate users. It requires
`instanceConfig.publicOrigin` and a configured `mailSender`; without them it
raises `ServiceUnavailableError` rather than mailing a broken link.
Challenges are single-use and expire in 15 minutes.
`bootstrapAdmin` succeeds only while no user exists, and returns a
full-capability API key alongside the user: a deployed Worker has no shell,
and login needs a verified sending domain that only an authenticated admin
can add, so without a credential the instance would be unreachable.

**Checklist**:
- [ ] Both modules
- [ ] Unit tests: unknown-email non-enumeration, expired challenge,
      replayed challenge, session issuance, bootstrap-once guard

---

### 7. UseCases facade

#### packages/application/src/usecases.ts

**Status**: NOT_STARTED

```typescript
interface UseCases {
  readonly resolveViewerFromToken: (token: string) => Promise<Viewer | null>;
  readonly receiveMessage: (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>;
  readonly sendMessage: (viewer: Viewer, input: SendMessageInput) => Promise<Message>;
  // ...one bound function per use case in this plan and the mail plan
}

function createUseCases(deps: AppDependencies): UseCases;
```

One flat object of pre-bound functions, constructed once per isolate. Keep
this file under 1000 lines; if it grows, split the construction into
`usecases-mail.ts` / `usecases-admin.ts` helpers re-exported from here.

**Checklist**:
- [ ] Facade covering every use case
- [ ] A test asserting every declared member is a function

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Error translation | `packages/application/src/usecases/translate-domain-error.ts` | NOT_STARTED | - |
| Domains | `packages/application/src/usecases/domains.ts` | NOT_STARTED | - |
| API keys | `packages/application/src/usecases/api-keys.ts` | NOT_STARTED | - |
| Tags | `packages/application/src/usecases/tags.ts` | NOT_STARTED | - |
| File links | `packages/application/src/usecases/file-links.ts` | NOT_STARTED | - |
| Auth | `packages/application/src/usecases/auth.ts` | NOT_STARTED | - |
| Email auth | `packages/application/src/usecases/email-auth.ts` | NOT_STARTED | - |
| Facade | `packages/application/src/usecases.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Domain error translation

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/application/src/usecases/translate-domain-error.ts`
**Dependencies**: application-ports-and-policies:TASK-001

**Completion Criteria**:
- [ ] Every `DomainError` subtype mapped
- [ ] Non-domain errors rethrown untouched
- [ ] Unit tests per mapping

### TASK-002: Domain and tag use cases

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/application/src/usecases/{domains,tags}.ts`
**Dependencies**: TASK-001, application-ports-and-policies:TASK-004

**Completion Criteria**:
- [ ] Six domain use cases plus `buildDomainDnsRecords`
- [ ] Five tag use cases with idempotent system-tag seeding
- [ ] Unit tests as listed

### TASK-003: API key use cases

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/application/src/usecases/api-keys.ts`
**Dependencies**: TASK-001, application-ports-and-policies:TASK-004

**Completion Criteria**:
- [ ] Key generation, issuance, revocation, scope add/remove
- [ ] Empty-scope rejection and the escalation guard
- [ ] Unit tests as listed

### TASK-004: File link use cases

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/file-links.ts`
**Dependencies**: application-usecases-mail:TASK-004

**Completion Criteria**:
- [ ] Mint requires FILE_LINK plus message read authorization
- [ ] TTL clamped; `maxDownloads >= 1` validated
- [ ] `resolveFileLink` returns null for every failure mode
- [ ] Unit tests as listed

### TASK-005: Auth, email auth and the UseCases facade

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/{auth,email-auth}.ts`,
`packages/application/src/usecases.ts`
**Dependencies**: TASK-002, TASK-003, TASK-004, application-usecases-mail:TASK-005

**Completion Criteria**:
- [ ] Viewer resolution for both credential kinds
- [ ] Passwordless flow with non-enumerating request
- [ ] Facade binds every use case
- [ ] Unit tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `application-ports-and-policies.md`, `application-usecases-mail.md` | BLOCKED until Phase 2 |

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

- **Previous**: `impl-plans/application-ports-and-policies.md`
- **Next**: `impl-plans/infrastructure-graphql.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
