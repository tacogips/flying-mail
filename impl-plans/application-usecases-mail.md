# Mail Use Cases Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-mail-pipeline.md,
design-docs/specs/design-graphql-api.md#fetch-state
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
The mail-path use cases: inbound ingest, outbound send, message listing and
reading, per-consumer fetch state, tagging and spam.

### Scope
**Included**: `packages/application/src/usecases/{ingest,spam,send,messages,fetch-state,tagging}.ts`
**Excluded**: domain/API-key/file-link/auth use cases (see the admin plan).

---

## Modules

### 1. Spam scoring

#### packages/application/src/usecases/spam.ts

**Status**: NOT_STARTED

```typescript
interface SpamSignalInput {
  readonly authenticationResults: string | null;
  readonly envelopeFrom: EmailAddress;
  readonly headerFrom: EmailAddress;
  readonly subject: string;
  readonly bodyText: string | null;
  readonly blockedAddresses: ReadonlySet<string>;
  readonly blockedDomains: ReadonlySet<string>;
  readonly phrases: readonly string[];
}

interface SpamScore {
  readonly score: number;                 // 0..1
  readonly reasons: readonly string[];    // human-readable, stored for display
}

function scoreSpam(input: SpamSignalInput): SpamScore;
function isSpam(score: SpamScore, threshold: number): boolean;
```

Weights per the design doc: SPF/DKIM failure 0.4, DMARC failure 0.3, envelope
vs header From domain mismatch 0.15, each matched phrase 0.15 (capped so
phrases alone cannot exceed 0.45), blocklist hit 1.0. Total is clamped to
`[0, 1]`. Parsing `Authentication-Results` is a plain substring scan for
`spf=fail`/`softfail`, `dkim=fail`, `dmarc=fail`; anything unparseable
contributes nothing rather than guessing.

**Checklist**:
- [ ] `scoreSpam`, `isSpam`, `parseAuthenticationResults`
- [ ] Unit tests for every signal in isolation, the phrase cap, the blocklist
      short-circuit, and clamping

---

### 2. Inbound ingest

#### packages/application/src/usecases/ingest.ts

**Status**: NOT_STARTED

```typescript
interface ReceiveMessageInput {
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly raw: ReadableStream | Uint8Array;
  readonly rawSize: number;
  readonly headers: ReadonlyMap<string, string>;
}

type ReceiveMessageResult =
  | { readonly kind: "STORED"; readonly message: Message }
  | { readonly kind: "REJECTED"; readonly reason: string };

function createReceiveMessageUseCase(deps: AppDependencies):
  (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>;
```

Steps, in order (see the design doc's diagram):

1. `parseEmailAddress(envelopeTo)`; unparseable -> `REJECTED`.
2. `mailDomainRepository.findByName(domainOf(envelopeTo))`; missing or
   `!canReceiveMail(domain)` -> `REJECTED` with a reason that does **not**
   disclose whether the domain is merely disabled versus unknown.
3. Non-catch-all domain: accept only when the local part already appears in
   `message_recipients` for that domain -> otherwise `REJECTED`.
4. `rawSize > MAX_INBOUND_RAW_BYTES` (25 MiB) -> `REJECTED`.
5. Generate `messageId`; `blobs.put(buildRawMessageBlobKey(id), raw)`.
6. `mimeParser.parse(...)`; cap attachments at 32 and total attachment bytes
   at 25 MiB, truncating bodies over 256 KiB and setting `bodyTruncated`.
7. Resolve `threadId`: `inReplyTo` lookup, then `references` lookup, else the
   new message's own id.
8. Store each attachment body under `buildAttachmentBlobKey(...)`.
9. `scoreSpam(...)`; at or above `instanceConfig.spamThreshold`, include the
   `SPAM` system tag id.
10. `messageRepository.insertWithRelations({ message, recipients,
    attachments, tagIds })` -- a single atomic `batch()`.

Recipients recorded: one `ENVELOPE` row for `envelopeTo`, plus `TO`/`CC`/`BCC`
rows from the parsed headers. Addresses that fail to parse are skipped rather
than failing the whole ingest -- a malformed `Cc:` must not cost us the
message.

Idempotency: the raw blob key and the message id are derived together, so a
retried delivery of the same envelope produces a fresh id and a second row.
Duplicate suppression is by `rfc_message_id`'s unique index: an insert that
violates it is treated as "already ingested" and returns the existing message.

**Checklist**:
- [ ] Use case factory with all ten steps
- [ ] Constants exported for the caps
- [ ] Unit tests: unknown domain, disabled domain, non-catch-all miss,
      oversized raw, attachment cap, body truncation, thread by `In-Reply-To`,
      thread by `References`, new thread, spam tagging, duplicate `Message-ID`

---

### 3. Outbound send

#### packages/application/src/usecases/send.ts

**Status**: NOT_STARTED

```typescript
interface SendMessageInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly inReplyToMessageId?: MessageId;
  readonly attachmentIds?: readonly AttachmentId[];
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly tagIds?: readonly TagId[];
}

function createSendMessageUseCase(deps: AppDependencies):
  (viewer: Viewer, input: SendMessageInput) => Promise<Message>;

function createRetrySendUseCase(deps: AppDependencies):
  (viewer: Viewer, messageId: MessageId) => Promise<Message>;
```

Validation, all raised as `BadUserInputError` naming the field:
- `from` parses and its domain is a managed, `ACTIVE`, verified domain
  (otherwise `DomainNotVerifiedError` translated to `CONFLICT`).
- at least one recipient; total recipients <= 50.
- at least one of `text`/`html`.
- attachments: <= 32, total size <= 5 MiB.
- custom header names must match `^X-[A-Za-z0-9-]+$` and values must contain
  no CR/LF -- this is the header-injection guard and is non-negotiable.

Authorization: `requireAddressCapability(viewer, MAIL_SEND, domainId, [from])`.

Order: authorize, validate, build the MIME source, persist as
`OUTBOUND`/`QUEUED` **before** calling `mailSender.send`, store the raw source
in R2, then `markMessageSent` or `markMessageFailed` with a masked error
string. `retrySend` requires the message to be `FAILED` and re-runs the send.

Threading: when `inReplyToMessageId` is given, the new message joins that
message's thread and copies its `rfcMessageId` into `In-Reply-To` and appends
it to `References`.

**Checklist**:
- [ ] Both use cases
- [ ] Header-injection rejection test (CR, LF, non-`X-` name)
- [ ] Unit tests: unverified domain, recipient cap, size cap, scope denial,
      persisted-before-send ordering, failure marking, retry guard

---

### 4. Message reading and listing

#### packages/application/src/usecases/messages.ts

**Status**: NOT_STARTED

```typescript
interface ListMessagesInput {
  readonly filter?: MessageFilterInput;
  readonly first: number;
  readonly after: string | null;
}

function createListMessagesUseCase(deps: AppDependencies):
  (viewer: Viewer, input: ListMessagesInput) => Promise<MessagePage>;

function createGetMessageUseCase(deps: AppDependencies):
  (viewer: Viewer, id: MessageId) => Promise<Message | null>;

function createGetThreadUseCase(deps: AppDependencies):
  (viewer: Viewer, id: ThreadId) => Promise<ThreadView | null>;

function createDeleteMessagesUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[]) => Promise<number>;

function createMarkReadUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[], read: boolean)
    => Promise<readonly Message[]>;

/** Shared read-authorization helper reused by every use case that must
 *  resolve a message the viewer is allowed to see; returns null (never
 *  throws Forbidden) so callers surface NOT_FOUND. */
function loadReadableMessage(
  deps: AppDependencies, viewer: Viewer, id: MessageId,
): Promise<Message | null>;
```

Listing always intersects the caller's filter with
`readableAddressPatterns(viewer, MAIL_READ)` and `scopedDomainIds(...)`.
`includeSpam: false` (the default) adds the `SPAM` tag id to
`excludeTagIds`. `first` is clamped to `[1, 200]`.

Deleting a message removes its D1 rows first, then best-effort deletes the raw
object and every attachment object; a blob failure is logged, not surfaced.

**Checklist**:
- [ ] Five use cases plus `loadReadableMessage`
- [ ] Unit tests: scope-filtered listing, spam exclusion by default, cursor
      round-trip, out-of-scope message reads as null, delete removes blobs

---

### 5. Fetch state

#### packages/application/src/usecases/fetch-state.ts

**Status**: NOT_STARTED

```typescript
function createMarkMessagesFetchedUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]>;

function createMarkMessagesNotFetchedUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]>;

/** FETCHED for user viewers (they have no per-key state); the stored
 *  status, defaulting to NOT_FETCHED, for API key viewers. */
function createResolveFetchStatusUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[])
    => Promise<ReadonlyMap<string, MessageFetchState>>;
```

Both mutations require `MAIL_MANAGE` on each message and are idempotent: a
re-acknowledged message keeps its original `fetchedAt`. A `USER` viewer gets
`BadUserInputError` -- fetch state is meaningful only for an API key
consumer, and silently no-oping would hide a client bug.

**Checklist**:
- [ ] Three use cases
- [ ] Unit tests: idempotent re-ack, per-key isolation (two keys, same
      message), user viewer rejection, unauthorized id skipped

---

### 6. Tagging and spam

#### packages/application/src/usecases/tagging.ts

**Status**: NOT_STARTED

```typescript
function createTagMessagesUseCase(deps: AppDependencies):
  (viewer: Viewer, messageIds: readonly MessageId[],
   tagIds: readonly TagId[]) => Promise<readonly Message[]>;

function createUntagMessagesUseCase(deps: AppDependencies): /* same shape */;

function createMarkSpamUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]>;

function createMarkNotSpamUseCase(deps: AppDependencies):
  (viewer: Viewer, ids: readonly MessageId[]) => Promise<readonly Message[]>;
```

All require `MAIL_MANAGE` per message. `markSpam`/`markNotSpam` resolve the
`SPAM` system tag by slug, never by name, so a renamed display label cannot
break classification. Unknown tag ids raise `NotFoundError`.

**Checklist**:
- [ ] Four use cases
- [ ] Unit tests: tag/untag round trip, spam by slug, unknown tag id,
      unauthorized message skipped

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Spam scoring | `packages/application/src/usecases/spam.ts` | NOT_STARTED | - |
| Ingest | `packages/application/src/usecases/ingest.ts` | NOT_STARTED | - |
| Send | `packages/application/src/usecases/send.ts` | NOT_STARTED | - |
| Messages | `packages/application/src/usecases/messages.ts` | NOT_STARTED | - |
| Fetch state | `packages/application/src/usecases/fetch-state.ts` | NOT_STARTED | - |
| Tagging | `packages/application/src/usecases/tagging.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Spam scoring

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/application/src/usecases/spam.ts`
**Dependencies**: application-ports-and-policies:TASK-002

**Completion Criteria**:
- [ ] `scoreSpam` implements every weighted signal
- [ ] Phrase contribution capped; blocklist short-circuits to 1.0
- [ ] Unit tests per signal

### TASK-002: Inbound ingest

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/ingest.ts`
**Dependencies**: TASK-001, application-ports-and-policies:TASK-004

**Completion Criteria**:
- [ ] All ten pipeline steps
- [ ] Caps enforced (raw size, attachment count, attachment bytes, body length)
- [ ] Thread resolution by `In-Reply-To` then `References`
- [ ] Duplicate `Message-ID` returns the existing message
- [ ] Unit tests for every rejection and each threading branch

### TASK-003: Outbound send

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/send.ts`
**Dependencies**: application-ports-and-policies:TASK-004

**Completion Criteria**:
- [ ] Validation, authorization, persist-before-send ordering
- [ ] Header-injection guard rejecting CR/LF and non-`X-` names
- [ ] `retrySend` guarded to `FAILED` messages
- [ ] Unit tests as listed

### TASK-004: Message reading, listing and deletion

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/messages.ts`
**Dependencies**: application-ports-and-policies:TASK-004

**Completion Criteria**:
- [ ] Listing intersects viewer scopes; spam excluded by default
- [ ] Out-of-scope reads return null (caller surfaces NOT_FOUND)
- [ ] Delete removes rows then blobs, tolerating blob failures
- [ ] Unit tests as listed

### TASK-005: Fetch state and tagging

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/application/src/usecases/{fetch-state,tagging}.ts`
**Dependencies**: TASK-004

**Completion Criteria**:
- [ ] Idempotent acknowledgment preserving `fetchedAt`
- [ ] Per-key isolation proven by test
- [ ] Spam tag resolved by slug
- [ ] Unit tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `application-ports-and-policies.md` | BLOCKED until Phase 2 |

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
