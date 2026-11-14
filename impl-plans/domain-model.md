# Domain Model Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-domain-model.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

**Source**: design-docs/specs/design-domain-model.md

### Summary
`@mailcal/domain`: branded value objects, entity shapes, pure state-transition
factories, and the `DomainError` hierarchy. No IO, no ID generation, no clock.

### Scope
**Included**: everything under `packages/domain/src`.
**Excluded**: repositories, use cases, persistence, GraphQL mapping.

---

## Modules

### 1. Errors

#### packages/domain/src/errors.ts

**Status**: NOT_STARTED

```typescript
abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string, readonly cause?: unknown);
}

class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string, readonly field: string);
}

class SystemTagImmutableError extends DomainError {
  readonly code = "SYSTEM_TAG_IMMUTABLE";
  constructor(message: string, readonly tagId: string);
}

class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";
  constructor(message: string, readonly from: string, readonly to: string);
}

class DomainNotVerifiedError extends DomainError {
  readonly code = "DOMAIN_NOT_VERIFIED";
  constructor(message: string, readonly domainName: string);
}
```

**Checklist**:
- [ ] All four subclasses with `name = this.constructor.name`
- [ ] Unit tests asserting `code`, `name`, `instanceof DomainError`

---

### 2. Value objects

#### packages/domain/src/value-objects/ids.ts

**Status**: NOT_STARTED

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

type DomainId = Brand<string, "DomainId">;
type MessageId = Brand<string, "MessageId">;
type ThreadId = Brand<string, "ThreadId">;
type AttachmentId = Brand<string, "AttachmentId">;
type TagId = Brand<string, "TagId">;
type ApiKeyId = Brand<string, "ApiKeyId">;
type ApiKeyScopeId = Brand<string, "ApiKeyScopeId">;
type FileLinkId = Brand<string, "FileLinkId">;
type UserId = Brand<string, "UserId">;
type SessionId = Brand<string, "SessionId">;
type EmailAuthChallengeId = Brand<string, "EmailAuthChallengeId">;

// One `create<X>Id(value: string): XId` per brand; each rejects a
// blank/whitespace-only value with ValidationError(field).
```

**Checklist**:
- [ ] All brands and constructors
- [ ] Shared `requireNonEmptyId` helper
- [ ] Unit tests for blank rejection

#### packages/domain/src/value-objects/email-address.ts

**Status**: NOT_STARTED

```typescript
type EmailAddress = Brand<string, "EmailAddress">;

/** Normalized lower-case `local@domain`; null on invalid input. */
function parseEmailAddress(value: string): EmailAddress | null;
/** Same, but throws ValidationError(field) instead of returning null. */
function createEmailAddress(value: string, field?: string): EmailAddress;
function emailLocalPart(address: EmailAddress): string;
function emailDomainName(address: EmailAddress): DomainName;
```

Rules: single `@`; local part 1..64 chars matching
`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+$`, no leading/trailing/double dot; domain
part validated by `parseDomainName`; total length <= 254; ASCII only.

**Checklist**:
- [ ] parse/create/localPart/domainName
- [ ] Unit tests: valid, uppercase normalization, missing `@`, double `@`,
      leading dot, over-length, non-ASCII

#### packages/domain/src/value-objects/domain-name.ts

**Status**: NOT_STARTED

```typescript
type DomainName = Brand<string, "DomainName">;

function parseDomainName(value: string): DomainName | null;
function createDomainName(value: string, field?: string): DomainName;
```

Rules: lower-cased; total <= 253; at least two labels; each label
`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.

**Checklist**:
- [ ] parse/create
- [ ] Unit tests: valid, single label, leading hyphen, over-length label

#### packages/domain/src/value-objects/address-pattern.ts

**Status**: NOT_STARTED

```typescript
type AddressPattern = Brand<string, "AddressPattern">;

function parseAddressPattern(value: string): AddressPattern | null;
function createAddressPattern(value: string, field?: string): AddressPattern;
/** True when `address` falls inside `pattern`. Both are pre-normalized. */
function matchAddressPattern(
  pattern: AddressPattern,
  address: EmailAddress,
): boolean;
```

Accepted forms (see design doc table): `*`, `*@domain`, `local@domain`,
`prefix-*@domain`, `*-suffix@domain`. At most one `*`, only in the local part
(or as the whole pattern). Matching is linear-time string comparison; never a
constructed `RegExp`.

**Checklist**:
- [ ] parse/create/match
- [ ] Unit tests covering every row of the design doc's grammar table, plus
      rejection of `**@d`, `a@*`, empty, and pattern/address domain mismatch

---

### 3. Entities

#### packages/domain/src/entities/mail-domain.ts

**Status**: NOT_STARTED

```typescript
enum DomainStatus { Pending = "PENDING", Active = "ACTIVE", Disabled = "DISABLED" }

interface MailDomain {
  readonly id: DomainId;
  readonly name: DomainName;
  readonly status: DomainStatus;
  readonly catchAll: boolean;
  readonly verificationToken: string;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CreateMailDomainInput {
  readonly id: DomainId;
  readonly name: DomainName;
  readonly catchAll: boolean;
  readonly verificationToken: string;
  readonly createdAt: string;
}

function createMailDomain(input: CreateMailDomainInput): MailDomain;
function verifyMailDomain(d: MailDomain, verifiedAt: string): MailDomain;
function setMailDomainStatus(
  d: MailDomain, status: DomainStatus, updatedAt: string,
): MailDomain;
function canReceiveMail(d: MailDomain): boolean;
function canSendMail(d: MailDomain): boolean;
```

`createMailDomain` starts `PENDING`/`verifiedAt: null`. `verifyMailDomain`
sets `verifiedAt` and moves to `ACTIVE`. `setMailDomainStatus` throws
`InvalidStateTransitionError` when moving to `ACTIVE` while `verifiedAt` is
null. `canReceiveMail`/`canSendMail` are `status === ACTIVE`.

**Checklist**:
- [ ] Entity + factories + predicates
- [ ] Unit tests including the unverified-to-active rejection

#### packages/domain/src/entities/message.ts

**Status**: NOT_STARTED

```typescript
enum MessageDirection { Inbound = "INBOUND", Outbound = "OUTBOUND" }
enum DeliveryStatus {
  Received = "RECEIVED", Queued = "QUEUED", Sent = "SENT", Failed = "FAILED",
}
enum RecipientKind {
  To = "TO", Cc = "CC", Bcc = "BCC", Envelope = "ENVELOPE",
}

interface MessageRecipient {
  readonly kind: RecipientKind;
  readonly address: EmailAddress;
  readonly name: string | null;
  readonly position: number;
}

interface Message {
  readonly id: MessageId;
  readonly domainId: DomainId;
  readonly direction: MessageDirection;
  readonly threadId: ThreadId;
  readonly rfcMessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly fromAddress: EmailAddress;
  readonly fromName: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly bodyTruncated: boolean;
  readonly snippet: string;
  readonly rawKey: string | null;
  readonly rawSize: number;
  readonly spamScore: number | null;
  readonly deliveryStatus: DeliveryStatus;
  readonly deliveryError: string | null;
  readonly readAt: string | null;
  readonly occurredAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function createInboundMessage(input: CreateInboundMessageInput): Message;
function createOutboundMessage(input: CreateOutboundMessageInput): Message;
function markMessageSent(m: Message, sentAt: string): Message;
function markMessageFailed(m: Message, error: string, at: string): Message;
function markMessageRead(m: Message, readAt: string | null): Message;
/** First 200 chars of plain text, whitespace-collapsed. */
function buildSnippet(text: string | null, html: string | null): string;
```

`createInboundMessage` forces `deliveryStatus: RECEIVED`;
`createOutboundMessage` forces `QUEUED`. `markMessageSent`/`markMessageFailed`
throw `InvalidStateTransitionError` unless the current status is `QUEUED`.
`buildSnippet` strips tags when only HTML is present.

**Checklist**:
- [ ] Entity, enums, factories, transitions, `buildSnippet`
- [ ] Unit tests for each transition guard and snippet derivation
- [ ] Keep the file under 1000 lines; split helpers into
      `message-snippet.ts` if needed

#### packages/domain/src/entities/attachment.ts

**Status**: NOT_STARTED

```typescript
interface Attachment {
  readonly id: AttachmentId;
  readonly messageId: MessageId;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly blobKey: string;
  readonly contentId: string | null;
  readonly inline: boolean;
  readonly createdAt: string;
}

function createAttachment(input: CreateAttachmentInput): Attachment;
/** Strips path separators, control chars and leading dots; caps at 255. */
function sanitizeFileName(fileName: string): string;
/** `att/<attachmentId>/<sanitizedFileName>` */
function buildAttachmentBlobKey(id: AttachmentId, fileName: string): string;
/** `raw/<messageId>.eml` */
function buildRawMessageBlobKey(id: MessageId): string;
```

`createAttachment` rejects a negative or non-finite `size`.

**Checklist**:
- [ ] Entity, factory, key builders, filename sanitizer
- [ ] Unit tests: traversal attempt `../../etc/passwd`, empty name fallback,
      over-length truncation

#### packages/domain/src/entities/tag.ts

**Status**: NOT_STARTED

```typescript
enum TagKind { User = "USER", System = "SYSTEM" }
enum SystemTagSlug {
  Spam = "SPAM", Trash = "TRASH", Archived = "ARCHIVED", Starred = "STARRED",
}

interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color: string | null;
  readonly kind: TagKind;
  readonly systemSlug: SystemTagSlug | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function createUserTag(input: CreateUserTagInput): Tag;
function createSystemTag(input: CreateSystemTagInput): Tag;
function renameTag(tag: Tag, name: string, color: string | null,
                   updatedAt: string): Tag;
function assertTagDeletable(tag: Tag): void;
function isSpamTag(tag: Tag): boolean;
```

`createUserTag` rejects a blank name and any name colliding with a
`SystemTagSlug` value. `renameTag`/`assertTagDeletable` throw
`SystemTagImmutableError` for `kind: SYSTEM`. Color, when present, must match
`^#[0-9a-f]{6}$` after lower-casing.

**Checklist**:
- [ ] Entity, enums, factories, guards
- [ ] Unit tests for system-tag immutability and color validation

#### packages/domain/src/entities/api-key.ts

**Status**: NOT_STARTED

```typescript
enum Capability {
  MailRead = "MAIL_READ", MailSend = "MAIL_SEND", MailManage = "MAIL_MANAGE",
  FileLink = "FILE_LINK", DomainAdmin = "DOMAIN_ADMIN", KeyAdmin = "KEY_ADMIN",
}

interface ApiKeyScope {
  readonly id: ApiKeyScopeId;
  readonly apiKeyId: ApiKeyId;
  readonly capability: Capability;
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
}

interface ApiKey {
  readonly id: ApiKeyId;
  readonly name: string;
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

function createApiKey(input: CreateApiKeyInput): ApiKey;
function createApiKeyScope(input: CreateApiKeyScopeInput): ApiKeyScope;
function revokeApiKey(key: ApiKey, revokedAt: string): ApiKey;
function recordApiKeyUsage(key: ApiKey, usedAt: string): ApiKey;
function isApiKeyUsable(key: ApiKey, now: string): boolean;
/** True when the scope authorizes (capability, domainId, address). */
function scopeMatches(scope: ApiKeyScope, input: ScopeMatchInput): boolean;
/** True when any scope in the list matches. */
function scopesAuthorize(
  scopes: readonly ApiKeyScope[], input: ScopeMatchInput,
): boolean;
/** Instance-wide capabilities: capability alone, ignoring domain/address. */
function scopesAuthorizeGlobal(
  scopes: readonly ApiKeyScope[], capability: Capability,
): boolean;
```

`isApiKeyUsable` is `revokedAt === null && (expiresAt === null || expiresAt > now)`.

**Checklist**:
- [ ] Entities, enum, factories, scope matching
- [ ] Unit tests: revoked, expired, wildcard domain, pattern match/mismatch,
      global capability ignoring domain

#### packages/domain/src/entities/fetch-state.ts

**Status**: NOT_STARTED

```typescript
enum FetchStatus { NotFetched = "NOT_FETCHED", Fetched = "FETCHED" }

interface MessageFetchState {
  readonly messageId: MessageId;
  readonly apiKeyId: ApiKeyId;
  readonly status: FetchStatus;
  readonly fetchedAt: string | null;
  readonly updatedAt: string;
}

function markFetched(state: MessageFetchState | null, messageId: MessageId,
                     apiKeyId: ApiKeyId, at: string): MessageFetchState;
function markNotFetched(state: MessageFetchState | null, messageId: MessageId,
                        apiKeyId: ApiKeyId, at: string): MessageFetchState;
```

`markFetched` on an already-`FETCHED` state preserves the original
`fetchedAt` (idempotent acknowledgment).

**Checklist**:
- [ ] Entity, enum, idempotent transitions
- [ ] Unit tests for the idempotency guarantee

#### packages/domain/src/entities/file-link.ts

**Status**: NOT_STARTED

```typescript
enum FileLinkTarget { Attachment = "ATTACHMENT", RawMessage = "RAW_MESSAGE" }

interface FileLink {
  readonly id: FileLinkId;
  readonly tokenHash: string;
  readonly target: FileLinkTarget;
  readonly attachmentId: AttachmentId | null;
  readonly messageId: MessageId | null;
  readonly expiresAt: string;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
  readonly createdByApiKeyId: ApiKeyId | null;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

function createAttachmentFileLink(input: CreateAttachmentLinkInput): FileLink;
function createRawMessageFileLink(input: CreateRawMessageLinkInput): FileLink;
function isFileLinkUsable(link: FileLink, now: string): boolean;
/** Returns the link with `downloadCount + 1`; throws when not usable. */
function consumeFileLink(link: FileLink, now: string): FileLink;
function revokeFileLink(link: FileLink, at: string): FileLink;
```

`isFileLinkUsable`: not revoked, `expiresAt > now`, and
`maxDownloads === null || downloadCount < maxDownloads`.

**Checklist**:
- [ ] Entity, enum, factories, consume/revoke
- [ ] Unit tests: expired, revoked, exhausted, happy path increments

#### packages/domain/src/entities/user.ts, session.ts, email-auth-challenge.ts

**Status**: NOT_STARTED

```typescript
enum UserRole { Admin = "ADMIN", Member = "MEMBER" }

interface User {
  readonly id: UserId; readonly email: EmailAddress; readonly name: string;
  readonly role: UserRole; readonly createdAt: string;
  readonly updatedAt: string; readonly deactivatedAt: string | null;
}

interface Session {
  readonly id: SessionId; readonly tokenHash: string;
  readonly userId: UserId; readonly expiresAt: string;
  readonly createdAt: string;
}

interface EmailAuthChallenge {
  readonly id: EmailAuthChallengeId; readonly email: EmailAddress;
  readonly tokenHash: string; readonly expiresAt: string;
  readonly consumedAt: string | null; readonly createdAt: string;
}
```

With `createUser`, `deactivateUser`, `isUserActive`, `createSession`,
`isSessionExpired`, `createEmailAuthChallenge`, `consumeEmailAuthChallenge`
(throws when already consumed or expired), `isChallengeUsable`.

**Checklist**:
- [ ] Three entity files with factories and guards
- [ ] Unit tests for expiry and single-use consumption

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Errors | `packages/domain/src/errors.ts` | NOT_STARTED | - |
| IDs | `packages/domain/src/value-objects/ids.ts` | NOT_STARTED | - |
| EmailAddress | `packages/domain/src/value-objects/email-address.ts` | NOT_STARTED | - |
| DomainName | `packages/domain/src/value-objects/domain-name.ts` | NOT_STARTED | - |
| AddressPattern | `packages/domain/src/value-objects/address-pattern.ts` | NOT_STARTED | - |
| MailDomain | `packages/domain/src/entities/mail-domain.ts` | NOT_STARTED | - |
| Message | `packages/domain/src/entities/message.ts` | NOT_STARTED | - |
| Attachment | `packages/domain/src/entities/attachment.ts` | NOT_STARTED | - |
| Tag | `packages/domain/src/entities/tag.ts` | NOT_STARTED | - |
| ApiKey | `packages/domain/src/entities/api-key.ts` | NOT_STARTED | - |
| FetchState | `packages/domain/src/entities/fetch-state.ts` | NOT_STARTED | - |
| FileLink | `packages/domain/src/entities/file-link.ts` | NOT_STARTED | - |
| User/Session/Challenge | `packages/domain/src/entities/{user,session,email-auth-challenge}.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Errors and value objects

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/domain/src/errors.ts`,
`packages/domain/src/value-objects/{ids,email-address,domain-name,address-pattern}.ts`
**Dependencies**: None

**Completion Criteria**:
- [ ] All four error subclasses implemented
- [ ] All branded IDs and their constructors
- [ ] EmailAddress / DomainName / AddressPattern parse, create and match
- [ ] Unit tests for every rejection path listed above
- [ ] `bun run typecheck` and `biome check` clean

### TASK-002: Mail, message and attachment entities

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/domain/src/entities/{mail-domain,message,attachment}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] MailDomain with verification and status transitions
- [ ] Message with inbound/outbound factories and delivery transitions
- [ ] Attachment with blob-key builders and filename sanitization
- [ ] Unit tests including transition guards and path-traversal sanitization

### TASK-003: Tag, api-key, fetch-state and file-link entities

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/domain/src/entities/{tag,api-key,fetch-state,file-link}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] Tag with system-tag immutability
- [ ] ApiKey with scope matching (`scopeMatches`, `scopesAuthorize`,
      `scopesAuthorizeGlobal`) and usability checks
- [ ] MessageFetchState with idempotent acknowledgment
- [ ] FileLink with expiry, revocation and download-count enforcement
- [ ] Unit tests for every guard

### TASK-004: User, session and email-auth-challenge entities

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/domain/src/entities/{user,session,email-auth-challenge}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] Three entities with factories and guards
- [ ] Unit tests for expiry and single-use consumption

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| TASK-002, TASK-003, TASK-004 | TASK-001 | BLOCKED until TASK-001 |

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
**Notes**: Initial plan from design-domain-model.md

## Related Plans

- **Next**: `impl-plans/application-ports-and-policies.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
