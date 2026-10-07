# External Mail Core (Domain + Application) Implementation Plan

**Status**: Ready
**Design Reference**: design-docs/specs/design-external-mail.md
**Created**: 2026-08-24
**Last Updated**: 2026-08-24

---

## Design Document Reference

**Source**: design-docs/specs/design-external-mail.md (binding model, domain
model, storage, use cases). Also read design-docs/specs/design-mail-pipeline.md
(`receiveMessage`/`sendMessage`, which this feature branches into).

### Summary
`ExternalMailAccount` binds one provisioned `mail_addresses` row to a remote
JMAP or POP3 mailbox for fetch, plus an optional SMTP submission config for
send. This plan adds the domain entities, the application-layer ports
(repositories + protocol clients + `TcpDialer`), the account CRUD and
fetch-orchestration use cases, the SMTP branch in `sendMessage`, and
in-memory test fakes. No adapter code, no D1, no sockets here.

### Scope
**Included**: `packages/domain` entities and id brand; `packages/application`
ports, use cases, `AppDependencies` extension, `UseCases` aggregation hook,
and test-support fakes.
**Excluded**: concrete adapters (`external-mail-adapter.md`), GraphQL and
composition wiring of concrete adapters (`external-mail-graphql.md`). No
new `Capability` enum value and no `api_key_scopes` change: TASK-004 reuses
`Capability.DomainAdmin`, TASK-005 reuses `Capability.MailRead`.

**Divergence from the assignment brief**: the brief listed `usecases.ts` and
`dependencies.ts` as `external-mail-graphql.md` deliverables. This plan
declares the `AppDependencies` fields and the `usecases.ts` "small hook"
instead, keeping dependency contracts with the core feature and avoiding a
real cross-plan cycle: TASK-004/005/006 reference
`deps.externalMailAccountRepository`,
which cannot type-check unless `AppDependencies` already declares it.

---

## Tasks

### TASK-001: Domain entities
**Status**: Completed · **Parallelizable**: Yes
**Deliverables**: `packages/domain/src/value-objects/ids.ts` (extend):
`ExternalAccountId` brand + `createExternalAccountId`. Plus
`packages/domain/src/entities/external-mail-account.ts`:

```typescript
export enum ExternalAccountStatus { Active = "ACTIVE", Disabled = "DISABLED" }

export type ExternalFetchConfig =
  | { readonly kind: "JMAP"; readonly sessionUrl: string; readonly username: string; readonly passwordCiphertext: string }
  | { readonly kind: "POP3"; readonly host: string; readonly port: number; readonly username: string; readonly passwordCiphertext: string };
// JMAP.sessionUrl: absolute https (http allowed for localhost only).
// POP3.port: 995 only -- see validatePop3Endpoint.

export type SmtpSecurity = "IMPLICIT_TLS" | "STARTTLS";

export interface SmtpSubmissionConfig {
  readonly host: string;
  readonly port: number; // 465 | 587
  readonly security: SmtpSecurity; // 465<->IMPLICIT_TLS, 587<->STARTTLS
  readonly username: string;
  readonly passwordCiphertext: string;
}

export interface ExternalMailAccount {
  readonly id: ExternalAccountId;
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: EmailAddress;
  readonly displayName: string | null;
  readonly fetch: ExternalFetchConfig;
  readonly smtp: SmtpSubmissionConfig | null;
  readonly status: ExternalAccountStatus;
  readonly lastFetchedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateExternalMailAccountInput {
  readonly id: ExternalAccountId;
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: EmailAddress;
  readonly displayName?: string | null;
  readonly fetch: ExternalFetchConfig;
  readonly smtp?: SmtpSubmissionConfig | null;
  readonly createdAt: string;
}

export function normalizeJmapSessionUrl(value: string): string; // HTTPS, with localhost HTTP exception
export function validatePop3Endpoint(host: string, port: number): void; // throws unless port === 995
export function validateSmtpSubmissionConfig(config: SmtpSubmissionConfig): void; // throws unless port/security agree

export function createExternalMailAccount(input: CreateExternalMailAccountInput): ExternalMailAccount;
export function replaceExternalMailAccountFetch(account: ExternalMailAccount, fetch: ExternalFetchConfig, now: string): ExternalMailAccount;
export function replaceExternalMailAccountSmtp(account: ExternalMailAccount, smtp: SmtpSubmissionConfig | null, now: string): ExternalMailAccount;
export function renameExternalMailAccount(account: ExternalMailAccount, displayName: string | null, now: string): ExternalMailAccount;
export function setExternalMailAccountStatus(account: ExternalMailAccount, status: ExternalAccountStatus, now: string): ExternalMailAccount;
export function markExternalMailAccountFetched(account: ExternalMailAccount, now: string): ExternalMailAccount;
export function isExternalAccountActive(account: ExternalMailAccount): boolean;
```

And `packages/domain/src/entities/external-message-state.ts`:

```typescript
/** One row per fetched remote message -- the dedupe ledger. Recorded in the
 * same batch as the ingested message so a crash between the two cannot
 * double-ingest. */
export interface ExternalMessageState {
  readonly accountId: ExternalAccountId;
  readonly remoteId: string; // JMAP Email id, or POP3 UIDL
  readonly messageId: MessageId;
  readonly fetchedAt: string;
}

export function createExternalMessageState(input: {
  readonly accountId: ExternalAccountId;
  readonly remoteId: string;
  readonly messageId: MessageId;
  readonly fetchedAt: string;
}): ExternalMessageState;
```

**Completion Criteria**:
- [x] Rejects: non-https/non-localhost JMAP session URL; POP3 port != 995;
      SMTP port/security mismatch
- [x] Unit tests for every validator, both `ExternalFetchConfig` branches

### TASK-002: Application ports + `AppDependencies`
**Status**: Completed · **Parallelizable**: No (needs TASK-001)
**Deliverables**: `packages/application/src/ports/external-mail.ts`:

```typescript
export interface ExternalMailAccountRepository {
  findById(id: ExternalAccountId): Promise<ExternalMailAccount | null>;
  findByMailAddress(mailAddressId: MailAddressId): Promise<ExternalMailAccount | null>;
  list(): Promise<readonly ExternalMailAccount[]>;
  save(account: ExternalMailAccount): Promise<void>;
  delete(id: ExternalAccountId): Promise<void>;
}

export interface ExternalMessageStateRepository {
  find(accountId: ExternalAccountId, remoteId: string): Promise<ExternalMessageState | null>;
  /** For a POP3 UIDL diff or a JMAP "already ingested" filter without one
   * round trip per id. */
  listRemoteIds(accountId: ExternalAccountId): Promise<ReadonlySet<string>>;
  save(state: ExternalMessageState): Promise<void>;
  /** Builds, without executing, the same upsert `save()` would run -- so
   * TASK-005 can append it to `receiveMessage`'s own `db.batch()` call. D1
   * has no transactions; `batch()` is the atomicity primitive. */
  buildSaveStatement(state: ExternalMessageState): SqlStatement;
}

export type TlsMode = "implicit" | "starttls-ready" | "none";
export interface TcpDialOptions { readonly host: string; readonly port: number; readonly tls: TlsMode }

/** Line/chunk read-write socket over one TCP connection. Implementations:
 * `cloudflare-tcp-dialer.ts` (Workers), `node-tcp-dialer.ts` (Bun/Node,
 * used by tests too). */
export interface TextSocket {
  readLine(): Promise<string | null>; // null on EOF
  readBytes(length: number): Promise<Uint8Array>;
  write(data: string | Uint8Array): Promise<void>;
  /** Upgrades an open plaintext connection (587 EHLO/STARTTLS/EHLO). Throws
   * unless dialed with `tls: "starttls-ready"`. */
  startTls(): Promise<void>;
  close(): Promise<void>;
}

export interface TcpDialer { dial(opts: TcpDialOptions): Promise<TextSocket> }

export interface JmapCredentials { readonly sessionUrl: string; readonly username: string; readonly password: string }
export interface JmapFetchedMessage { readonly remoteId: string; readonly raw: Uint8Array }
export interface JmapFetchResult { readonly messages: readonly JmapFetchedMessage[]; readonly hasMore: boolean }

export interface JmapClient {
  testConnection(credentials: JmapCredentials): Promise<void>;
  /** Session -> Mailbox/get(inbox) -> Email/query (ascending receivedAt,
   * bounded by max) -> Email/get + blob download for ids not in
   * knownRemoteIds. */
  fetchSince(credentials: JmapCredentials, knownRemoteIds: ReadonlySet<string>, max: number): Promise<JmapFetchResult>;
}

export interface Pop3Credentials { readonly host: string; readonly port: number; readonly username: string; readonly password: string }
export interface Pop3FetchedMessage { readonly remoteId: string; readonly raw: Uint8Array } // remoteId = UIDL

export interface Pop3Client {
  testConnection(credentials: Pop3Credentials): Promise<void>;
  listUidls(credentials: Pop3Credentials): Promise<readonly string[]>;
  /** RETR each id in one session; never sends DELE. */
  fetchByUidl(credentials: Pop3Credentials, uidls: readonly string[]): Promise<readonly Pop3FetchedMessage[]>;
}

export interface SmtpCredentials { readonly host: string; readonly port: number; readonly security: SmtpSecurity; readonly username: string; readonly password: string }
export interface SmtpEnvelope { readonly from: string; readonly to: readonly string[]; readonly raw: string } // client dot-stuffs raw itself

export interface SmtpSubmissionClient {
  testConnection(credentials: SmtpCredentials): Promise<void>;
  send(credentials: SmtpCredentials, envelope: SmtpEnvelope): Promise<void>; // non-2xx/3xx throws ExternalMailTransportError
}

/** Rejected credential -> BAD_USER_INPUT. */
export class ExternalMailAuthError extends Error {
  constructor(message: string) { super(message); this.name = "ExternalMailAuthError"; }
}
/** Unreachable host, malformed reply, or non-2xx response. */
export class ExternalMailTransportError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message); this.name = "ExternalMailTransportError";
  }
}
```

Also extend `packages/application/src/dependencies.ts`: add
`externalMailAccountRepository`, `externalMessageStateRepository`,
`jmapClient`, `pop3Client`, `smtpSubmissionClient`, `tcpDialer` (ports only,
no adapter imports). For
TASK-005's atomic ledger write, also extend
`ports/message-repository.ts`'s `InsertMessageInput` with
`readonly extraStatements?: readonly SqlStatement[]` (appended to
`insertWithRelations`'s own `db.batch()` call; default empty, no behavior
change for existing callers) and `usecases/ingest.ts`'s
`ReceiveMessageInput` with the same field, threaded through unchanged.

**Completion Criteria**:
- [x] Ports contain no adapter imports; `tsc --noEmit` passes
- [x] `AppDependencies` compiles with the six new fields; nothing else changes
- [x] `extraStatements` is additive and optional; existing `receiveMessage`
      callers (the Worker's `email()` handler, dev ingest route) are unaffected

**Deviation**: `ReceiveMessageInput` also gained an optional `messageId?:
MessageId` field, beyond the plan's literal `extraStatements`-only bullet.
It is required for TASK-005's crash-safety design to actually work: the
dedupe ledger's `SqlStatement` must reference the *exact* id `receiveMessage`
will assign a `STORED` message, and that id previously could not be known
until the internal `deps.random.uuid()` call inside `receiveMessage`
returned -- after `insertWithRelations` (and therefore the batch) had
already run. `messageId` lets a caller pre-generate the id, build the ledger
statement against it, and pass both in together; `receiveMessage` uses
`input.messageId ?? createMessageId(deps.random.uuid())`, so every existing
caller (Worker `email()` handler, dev ingest route) is unaffected.

### TASK-003: Test-support fakes
**Status**: Completed · **Parallelizable**: No (needs TASK-002)
**Deliverables**: `packages/application/src/test-support/external-mail-fakes.ts`: in-memory `fakeExternalMailAccountRepository()`,
`fakeExternalMessageStateRepository()`, `scriptedJmapClient(script)`,
`scriptedPop3Client(script)`, `scriptedSmtpSubmissionClient(script)` (canned
results/errors per call, mirroring `recordingMailSender`), and
`recordingTcpDialer()` sufficient to satisfy `AppDependencies` where no real
socket is exercised (scripted `TextSocket` fixtures for protocol-client
tests belong to `external-mail-adapter.md` TASK-002). Extend `fakes.ts`'
`createFakeDependencies()` with all six new fields.

**Completion Criteria**:
- [x] Fakes cover TASK-004/005/006 unit tests without a concrete adapter
- [x] Existing `createFakeDependencies()` consumers unaffected

**Note**: the fake ledger's `buildSaveStatement` returns a `SqlStatement`
carrying an extra, fake-only `apply` callback; `fakeMessageRepository.
insertWithRelations` invokes it only when the statement actually rides
`extraStatements` on that call, reproducing -- for tests -- what a real
`db.batch()` would do. `FakeMessageStores` also grew an `insertCalls` log so
a test can assert *what* rode a given insert rather than inferring it
indirectly. Both are additive; no existing fake consumer is affected.

### TASK-004: External account CRUD use cases
**Status**: Completed · **Parallelizable**: Yes (parallel with 005, 006)
**Deliverables**: `packages/application/src/usecases/external-accounts.ts`:

```typescript
export type ExternalFetchInput =
  | { readonly kind: "JMAP"; readonly sessionUrl: string; readonly username: string; readonly password: string }
  | { readonly kind: "POP3"; readonly host: string; readonly port?: number; readonly username: string; readonly password: string };

export interface SmtpSubmissionInput { readonly host: string; readonly port: number; readonly security: SmtpSecurity; readonly username: string; readonly password: string }

export interface CreateExternalAccountInput {
  readonly mailAddressId: MailAddressId;
  readonly externalAddress: string;
  readonly displayName?: string | null;
  readonly fetch: ExternalFetchInput;
  readonly smtp?: SmtpSubmissionInput | null;
}

/** An omitted `password` re-uses the stored ciphertext; `smtp: null` clears
 * the relay config. */
export interface UpdateExternalAccountInput {
  readonly displayName?: string | null;
  readonly fetch?: Partial<ExternalFetchInput> & Pick<ExternalFetchInput, "kind">;
  readonly smtp?: (Partial<SmtpSubmissionInput> & { readonly host: string; readonly port: number; readonly security: SmtpSecurity }) | null;
  readonly status?: ExternalAccountStatus;
}

export interface ExternalAccountTestResult {
  readonly fetchOk: boolean; readonly fetchError: string | null;
  readonly smtpOk: boolean | null; readonly smtpError: string | null; // smtpOk null when unconfigured
}

// All admin-only: requireGlobalCapability(viewer, Capability.DomainAdmin),
// as usecases/domains.ts. Every one calls requireCipher(deps) first:
// unset FLYING_MAIL_CREDENTIAL_KEY -> SERVICE_UNAVAILABLE.
export function createListExternalAccountsUseCase(deps: AppDependencies): (viewer: Viewer) => Promise<readonly ExternalMailAccount[]>;
export function createCreateExternalAccountUseCase(deps: AppDependencies): (viewer: Viewer, input: CreateExternalAccountInput) => Promise<ExternalMailAccount>;
// ConflictError if mailAddressId already has an ExternalMailAccount (unique index: one account per managed address).
export function createUpdateExternalAccountUseCase(deps: AppDependencies): (viewer: Viewer, id: ExternalAccountId, input: UpdateExternalAccountInput) => Promise<ExternalMailAccount>;
export function createDeleteExternalAccountUseCase(deps: AppDependencies): (viewer: Viewer, id: ExternalAccountId) => Promise<boolean>;
export function createTestExternalAccountUseCase(deps: AppDependencies): (viewer: Viewer, id: ExternalAccountId) => Promise<ExternalAccountTestResult>;
// Connect + authenticate only (fetch + smtp testConnection when configured), no fetch/send; errors caught per-leg.
```

**Completion Criteria**:
- [x] Ciphertext produced once via `deps.credentialCipher.encrypt`, never
      logged/returned; an omitted `password` on `update` keeps it byte-for-byte
- [x] `ConflictError` for a second account on one `mailAddressId`;
      `ForbiddenError` for a non-admin on every mutation and `list`
- [x] Unit tests over TASK-003 fakes for every validation and auth branch

**Deviation**: `UpdateExternalAccountInput.fetch` uses a locally declared
`UpdateExternalFetchInput` discriminated union instead of the plan's literal
`Partial<ExternalFetchInput> & Pick<ExternalFetchInput, "kind">`. `keyof` a
union type is the *intersection* of its members' keys, so that expression
would type-check but silently collapse to only the fields common to both
branches (`kind`, `username`, `password`) -- `sessionUrl`, `host` and `port`
would be inaccessible. The SMTP update type is unchanged from the plan since
`SmtpSubmissionInput` is a plain interface, where `Partial<...>` behaves as
expected.

### TASK-005: Fetch orchestration use case
**Status**: Completed · **Parallelizable**: Yes (parallel with 004, 006)
**Deliverables**: `packages/application/src/usecases/external-fetch.ts`:

```typescript
export const DEFAULT_EXTERNAL_FETCH_MAX = 50;
export interface FetchExternalMailInput { readonly max?: number }
export interface FetchExternalMailSummary { readonly fetched: number; readonly skipped: number; readonly hasMore: boolean }

export function createFetchExternalMailUseCase(
  deps: AppDependencies,
  receiveMessage: (input: ReceiveMessageInput) => Promise<ReceiveMessageResult>,
): (viewer: Viewer, accountId: ExternalAccountId, input?: FetchExternalMailInput) => Promise<FetchExternalMailSummary>;
```

Requires `Capability.MailRead` on the bound address (any authorized reader
may poll -- not admin-only). `DISABLED` -> `ConflictError`; unauthorized
viewer -> `NotFoundError` (probe-resistant). Per fetched message: build a
synthetic `ReceiveMessageInput` (envelope-to = bound address, envelope-from
= `externalAddress` as fallback) via an exported
`buildExternalFetchIngestInput` helper mirroring `buildDevIngestInput`; skip
a remote id already in `ExternalMessageStateRepository`; otherwise pass
`extraStatements: [externalMessageStateRepository.buildSaveStatement(state)]`
into `receiveMessage`, so a `STORED` result writes the ledger row in the
*same* `db.batch()` call as the message insert -- D1 has no transactions,
so this is what actually makes a crash mid-ingest unable to double-ingest,
not just sequencing. A `DUPLICATE` result (the message already existed via
`receiveMessage`'s own `rfc_message_id` dedupe -- no `insertWithRelations`
call happened) has no batch to join, so the use case calls
`externalMessageStateRepository.save(state)` directly; both outcomes count
as fetched. Caps at `input.max ?? DEFAULT_EXTERNAL_FETCH_MAX`, returns
`hasMore`. JMAP calls `jmapClient.fetchSince`; POP3 calls `listUidls`,
diffs against `listRemoteIds`, then `fetchByUidl` on new ids.

**Completion Criteria**:
- [x] Dedupe test: a remote id already in the ledger is never re-ingested
- [x] `STORED` path: assert the ledger `SqlStatement` is passed as
      `extraStatements` into the same `receiveMessage`/`insertWithRelations`
      call, not a separate write after it
- [x] Cap/`hasMore` test for both JMAP and POP3 branches

### TASK-006: `sendMessage` external SMTP branch
**Status**: Completed · **Parallelizable**: Yes (parallel with 004, 005)
**Deliverables**: `packages/application/src/usecases/send.ts` (extend, stays under 1000 lines):

```typescript
// Exported for fetch/send-branch unit tests:
export async function resolveExternalSmtpAccount(
  deps: AppDependencies,
  mailAddressId: MailAddressId,
): Promise<ExternalMailAccount | null>; // non-null only when ACTIVE and smtp !== null
```

`deliver()`'s signature is unchanged; internally, after resolving `mail.from`
to a `MailAddress` row, it calls `resolveExternalSmtpAccount` *before*
touching `deps.mailSender` at all. Non-null: decrypt
`account.smtp.passwordCiphertext`, build an `SmtpEnvelope` from `mail.raw`
(or a rebuilt raw source when undefined, as `retrySend` already does) with
`from`/`to` from `account.externalAddress` and the message's recipients,
call `smtpSubmissionClient.send`. Otherwise unchanged: `mailSender.send(mail)`.
This composes with, rather than replaces, the existing fallback chain in
`composition/build-dependencies.ts`'s `resolveMailSender` (Email Sending
REST API -> `send_email` binding -> unavailable sender): that chain already
resolved to one `MailSender` instance by the time `deliver()` runs, so the
external-account check is a branch *in front of* it, not a change to it.
Both branches flow through the existing `markMessageSent`/`markMessageFailed`
bookkeeping and message-event recording; no duplicated logic.

**Completion Criteria**:
- [x] `from` with an ACTIVE external account + SMTP config routes through
      `SmtpSubmissionClient`, never `MailSender`; no account, DISABLED, or
      `smtp: null` is unchanged (still governed by `resolveMailSender`'s
      existing chain)
- [x] SMTP failure marks the message `FAILED` exactly as a `MailSender`
      failure does today, via the same code path
- [x] `retrySend` picks the same branch a fresh send would

### TASK-007: `usecases.ts` wiring
**Status**: Completed · **Parallelizable**: No (depends on 004, 005, 006)
**Deliverables**:
- `packages/application/src/usecases/external-mail-usecases.ts`: new
  `ExternalMailUseCases` interface + `createExternalMailUseCases(deps)`,
  bundling all six use cases.
  `fetchExternalMail` is wired as
  `createFetchExternalMailUseCase(deps, receiveMessage)`, reusing the
  `receiveMessage` instance already built in `createUseCases`.
- `packages/application/src/usecases.ts` (extend, small hook only): add
  `ExternalMailUseCases` to `UseCases`'s existing `extends` clause and spread
  `...createExternalMailUseCases(deps)` into
  `createUseCases`'s return object.

**Completion Criteria**:
- [x] `usecases.ts` grows by an import, an `extends`, and one spread only
- [x] `@flying-mail/application` typecheck passes

## Module Status

| Module | File Path | Status |
|--------|-----------|--------|
| Domain entities | `packages/domain/src/entities/{external-mail-account,external-message-state}.ts`, `value-objects/ids.ts` | DONE |
| Ports + AppDependencies | `packages/application/src/ports/external-mail.ts`, `dependencies.ts` | DONE |
| Fakes | `packages/application/src/test-support/external-mail-fakes.ts` | DONE |
| Account CRUD use cases | `packages/application/src/usecases/external-accounts.ts` | DONE |
| Fetch use case | `packages/application/src/usecases/external-fetch.ts` | DONE |
| Send branch | `packages/application/src/usecases/send.ts` | DONE |
| Wiring | `packages/application/src/usecases/external-mail-usecases.ts`, `usecases.ts` | DONE |

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | migration `0009_mail_addresses.sql` | Available |
| `external-mail-adapter.md` | TASK-001, TASK-002 | Blocks adapter |
| `external-mail-graphql.md` | TASK-007 | Blocks graphql |

## Completion Criteria

- [x] All tasks complete; vitest run green; typecheck + biome pass
- [x] No touched file at 1000+ lines; export map needs no changes (already wildcards)

## Progress Log

### Session: 2026-08-24
**Tasks Completed**: None yet
**Notes**: Plan created from design-docs/specs/design-external-mail.md.

### Session: 2026-08-24 (TASK-001)
**Tasks Completed**: TASK-001 (Domain entities)
**Notes**: Added `packages/domain/src/entities/external-mail-account.ts`
(`ExternalAccountStatus`, `ExternalFetchConfig` JMAP/POP3 union,
`SmtpSecurity`, `SmtpSubmissionConfig`, `ExternalMailAccount`, smart
constructors/mutators, `normalizeJmapSessionUrl`, `validatePop3Endpoint`,
`validateSmtpSubmissionConfig`) and
`packages/domain/src/entities/external-message-state.ts`
(`ExternalMessageState`, `createExternalMessageState`), each with a colocated
`*.test.ts`. `ExternalAccountId`/`createExternalAccountId` in
`value-objects/ids.ts` were already present (added by a sibling agent) and
were not touched. `biome check . --diagnostic-level=warn` clean, `bun run
typecheck` clean across all packages, `bunx vitest run packages/domain`
green (33 files / 523 tests).

### Session: 2026-08-24 (TASK-002..007)
**Tasks Completed**: TASK-002 (ports + `AppDependencies`), TASK-003
(test-support fakes), TASK-004 (account CRUD use cases), TASK-005 (fetch
orchestration), TASK-006 (`sendMessage` SMTP branch), TASK-007 (`usecases.ts`
wiring) -- this plan's full scope.
**Notes**: Created `packages/application/src/ports/external-mail.ts`
(`ExternalMailAccountRepository`, `ExternalMessageStateRepository`,
`TcpDialer`/`TextSocket`, `JmapClient`, `Pop3Client`, `SmtpSubmissionClient`,
`ExternalMailAuthError`, `ExternalMailTransportError`); extended
`dependencies.ts` with the six new `AppDependencies` fields;
extended `ports/message-repository.ts`'s `InsertMessageInput` and
`usecases/ingest.ts`'s `ReceiveMessageInput` with `extraStatements` (plus a
`messageId` override -- see TASK-002's Deviation note above, required for
the crash-safety design to be implementable at all).
Created `test-support/external-mail-fakes.ts` (in-memory account/ledger
repositories, `scriptedJmapClient`/`scriptedPop3Client`/
`scriptedSmtpSubmissionClient`, `recordingTcpDialer`) and wired it into
`test-support/fakes.ts`'s `createFakeDependencies()`; extended
`test-support/message-repository-fake.ts` with an `insertCalls` log and
fake-only `extraStatements` application (see TASK-003's note above).
Created `usecases/external-accounts.ts` (admin-gated CRUD +
`testExternalAccount`, `requireCipher`, ciphertext re-encipher-or-keep
semantics) and `usecases/external-fetch.ts` (`fetchExternalMail`: MAIL_READ
gated, JMAP/POP3 branches, ledger dedupe, per-run cap with `hasMore`,
`STORED`-via-`extraStatements`/`DUPLICATE`-via-direct-`save` split). Added
the external SMTP branch to `usecases/send.ts` (`resolveExternalSmtpAccount`
exported; `deliver()` split into itself plus a new `deliverMail()` that
picks the transport before `mailSender` is touched at all; a raw-source
fallback via `mimeBuilder` for the rare `retrySend` case where `mail.raw` is
absent). Created `usecases/external-mail-usecases.ts`
(`ExternalMailUseCases` + `createExternalMailUseCases(deps, receiveMessage)`,
reusing the `receiveMessage` instance `createUseCases` already builds) and
wired it into `usecases.ts` (one import, one `extends` member, one spread,
plus hoisting the previously-inline `receiveMessage` into a local so both
`UseCases.receiveMessage` and the external-mail wiring share the same
instance).
Added `usecases/external-accounts.test.ts` (19 tests: admin gating,
`SERVICE_UNAVAILABLE` without a credential key, ciphertext round-tripping,
conflict on a second account per address, update merge semantics including
"first-time SMTP needs a password", delete, `testExternalAccount` per-leg
success/failure), `usecases/external-fetch.test.ts` (10 tests: JMAP/POP3
ingest, the `STORED`-rides-the-batch and `DUPLICATE`-writes-directly
assertions, dedupe across runs, cap/`hasMore` for both protocols, DISABLED
-> `CONFLICT`, unauthorized -> `NOT_FOUND`), and 7 new tests appended to
`usecases/send.test.ts` (SMTP-vs-`mailSender` branch selection for every
combination of account/status/`smtp` config, failure mapping, `retrySend`
branch parity, `resolveExternalSmtpAccount` directly).
Touched only `packages/application` and this plan file, per the assignment's
scope restriction; `packages/infrastructure`'s known `build-dependencies.ts`
gap (missing the six new `AppDependencies` fields) was left as-is, as
expected -- it belongs to a later wiring task.
`bunx tsc --noEmit -p packages/application` clean; `biome check
packages/application --diagnostic-level=warn` clean; `bunx vitest run
packages/application` green (28 files / 524 tests, up from 26/488 at the
start of this session -- all pre-existing tests still pass unmodified). No
touched file reached 1000 lines (largest is `usecases.ts` at 699).

## Related Plans
**Next**: `external-mail-adapter.md`, `external-mail-graphql.md`
