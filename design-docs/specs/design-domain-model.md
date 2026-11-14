# Domain Model

Entities, branded value objects and invariants owned by `@mailcal/domain`.
The domain layer never generates IDs, timestamps or randomness -- those are
supplied by the caller (application layer) through the `Clock`/`RandomSource`
ports, keeping every entity factory pure and deterministic under test.

## Value objects

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

type DomainId       = Brand<string, "DomainId">;
type MessageId      = Brand<string, "MessageId">;
type AttachmentId   = Brand<string, "AttachmentId">;
type TagId          = Brand<string, "TagId">;
type ApiKeyId       = Brand<string, "ApiKeyId">;
type ApiKeyScopeId  = Brand<string, "ApiKeyScopeId">;
type FileLinkId     = Brand<string, "FileLinkId">;
type UserId         = Brand<string, "UserId">;
type SessionId      = Brand<string, "SessionId">;
type ThreadId       = Brand<string, "ThreadId">;
```

### `EmailAddress`

A normalized, lower-cased `local@domain` mailbox. Parsing rejects display-name
and address-list syntax; `parseEmailAddress` returns `null` for invalid input
while `createEmailAddress` throws `ValidationError`. Exposes `localPart` and
`domainName` so permission matching never re-splits the string.

### `DomainName`

A normalized, lower-cased FQDN with at least two labels, each matching
`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`.

### `AddressPattern`

The glob used by API key scopes. Grammar, deliberately minimal:

| Pattern | Matches |
|---------|---------|
| `*` | every address |
| `*@example.com` | every mailbox on `example.com` |
| `support@example.com` | exactly that mailbox |
| `support-*@example.com` | prefix wildcard on the local part |
| `*-noreply@example.com` | suffix wildcard on the local part |

At most one `*` is allowed in the local part and it may not appear in the
domain part except as the whole local part's `*@domain` form. Matching is
case-insensitive because both sides are normalized first.

## Domain

A mail domain under management.

```typescript
interface MailDomain {
  readonly id: DomainId;
  readonly name: DomainName;
  readonly status: DomainStatus;      // PENDING | ACTIVE | DISABLED
  readonly catchAll: boolean;         // accept mail for any local part
  readonly verificationToken: string; // DNS TXT value proving ownership
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Invariants: a domain may only move `PENDING -> ACTIVE` through
`verifyMailDomain`, which requires a non-null `verifiedAt`; a `DISABLED`
domain rejects both ingest and send.

## Message

The central entity. One row per received or sent message.

```typescript
interface Message {
  readonly id: MessageId;
  readonly domainId: DomainId;
  readonly direction: MessageDirection;      // INBOUND | OUTBOUND
  readonly threadId: ThreadId;
  readonly rfcMessageId: string | null;      // RFC 5322 Message-ID
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly fromAddress: EmailAddress;
  readonly fromName: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly snippet: string;                  // first ~200 chars, plain text
  readonly rawKey: string | null;            // R2 key of the .eml source
  readonly rawSize: number;
  readonly spamScore: number | null;         // 0..1, null when not scored
  readonly deliveryStatus: DeliveryStatus;   // RECEIVED | QUEUED | SENT | FAILED
  readonly deliveryError: string | null;
  readonly readAt: string | null;
  readonly occurredAt: string;               // received-at or sent-at
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Recipients live in their own table rather than a JSON column so that
permission filtering and mailbox listing are indexable:

```typescript
interface MessageRecipient {
  readonly messageId: MessageId;
  readonly kind: RecipientKind;   // TO | CC | BCC | ENVELOPE
  readonly address: EmailAddress;
  readonly name: string | null;
  readonly position: number;
}
```

`ENVELOPE` is the SMTP RCPT TO for inbound mail -- the address that actually
caused delivery, which is what API key scopes are matched against. `TO`/`CC`
are header-derived and may legitimately not contain the envelope recipient.

Invariants: `direction: INBOUND` implies `deliveryStatus: RECEIVED`;
`direction: OUTBOUND` starts `QUEUED` and moves to `SENT` or `FAILED`
exactly once (`markMessageSent` / `markMessageFailed`).

## Attachment

```typescript
interface Attachment {
  readonly id: AttachmentId;
  readonly messageId: MessageId | null; // null while staged, pre-send
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly blobKey: string;
  readonly contentId: string | null;   // for inline cid: references
  readonly inline: boolean;
  readonly kind: AttachmentKind;       // classified once at receive time
  readonly createdAt: string;
}

enum AttachmentKind {
  Image, Video, Audio, Pdf, Document, Spreadsheet,
  Presentation, Archive, Text, Calendar, Other
}
```

`kind` is decided by `classifyAttachmentKind(contentType, fileName)` at the
moment the attachment is stored -- content type first, extension as the
fallback for the ubiquitous `application/octet-stream` -- and never
re-derived afterwards, so a stored message's classification cannot change
under an operator when the rules evolve. The content type is
attacker-supplied: the kind drives search grouping only, never a security
decision (the download routes judge the stored content type independently).

```typescript
```

## Tags

```typescript
interface Tag {
  readonly id: TagId;
  readonly name: string;
  readonly color: string | null;
  readonly kind: TagKind;                 // USER | SYSTEM
  readonly systemSlug: SystemTagSlug | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

enum SystemTagSlug {
  Spam = "SPAM",
  Trash = "TRASH",
  Archived = "ARCHIVED",
  Starred = "STARRED",
}
```

Invariants enforced by the factories:

- `kind: SYSTEM` requires a non-null `systemSlug`; `kind: USER` requires it to
  be `null`.
- System tags cannot be renamed or deleted (`renameTag`/`deleteTag` throw
  `SystemTagImmutableError`), because clients and the ingest pipeline address
  them by slug.
- `SPAM` is the reserved junk tag. Default message listings exclude it unless
  the caller opts in with `includeSpam: true` or filters on it explicitly.

The four system tags are seeded by the initial migration so a fresh deployment
can classify mail before any user has created a tag.

## API keys

See `design-api-keys-and-permissions.md` for the scope semantics.

```typescript
interface ApiKey {
  readonly id: ApiKeyId;
  readonly name: string;
  readonly keyHash: string;       // SHA-256 of the full presented secret
  readonly keyPrefix: string;     // non-secret lookup/display prefix
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

interface ApiKeyScope {
  readonly id: ApiKeyScopeId;
  readonly apiKeyId: ApiKeyId;
  readonly capability: Capability;
  readonly domainId: DomainId | null;         // null = every managed domain
  readonly addressPattern: AddressPattern;    // "*" = every address
}
```

## Fetch state

Per `(message, consumer)` retrieval bookkeeping. The consumer is an API key,
so each agent tracks its own progress independently.

```typescript
interface MessageFetchState {
  readonly messageId: MessageId;
  readonly apiKeyId: ApiKeyId;
  readonly status: FetchStatus;    // NOT_FETCHED | FETCHED
  readonly fetchedAt: string | null;
  readonly updatedAt: string;
}
```

Absence of a row is equivalent to `NOT_FETCHED`; rows are only written when a
consumer acknowledges, which keeps the table proportional to acknowledged
work rather than to `messages x keys`.

## File links

Short-lived capability URLs for attachment bodies and raw `.eml` sources.

```typescript
interface FileLink {
  readonly id: FileLinkId;
  readonly tokenHash: string;
  readonly target: FileLinkTarget;      // ATTACHMENT | RAW_MESSAGE
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
```

Invariants: exactly one of `attachmentId`/`messageId` is non-null, matching
`target`; `consumeFileLink` rejects an expired, revoked or exhausted link and
otherwise returns the link with `downloadCount` incremented.

## Users and sessions

Mirrors the reference project: `User { id, email, name, role, createdAt,
updatedAt, deactivatedAt }` with `role: ADMIN | MEMBER`, opaque `Session`
rows keyed by a SHA-256 token hash, and single-use `EmailAuthChallenge` rows
backing the passwordless login links. Only `ADMIN` may manage domains and
issue API keys.

## Errors

`DomainError` subclasses: `ValidationError` (field-level),
`SystemTagImmutableError`, `InvalidStateTransitionError` (e.g. sending an
already-sent message), `DomainNotVerifiedError`.

## Spam as a verdict table, mail status, events, mailing lists and rules (2026-08-23)

### SpamMark (replaces the SPAM system tag)

Spam is no longer a tag. A verdict is a `message_spam` row keyed by
message id: presence is the verdict, absence means not spam.

```typescript
enum SpamMarkedBy { System, User, Rule }
interface SpamMark {
  readonly messageId: MessageId;
  readonly score: number | null;   // null for hand marks: no scorer ran
  readonly markedBy: SpamMarkedBy;
  readonly markedAt: string;
}
```

Why a table and not a tag: the verdict carries metadata a tag row cannot
(score at marking time, who decided, when), it must not be renamable or
deletable through the tag admin surface, and hand marks need to be
distinguishable from scorer and rule marks when tuning. `SystemTagSlug`
therefore lost `SPAM`; `TRASH`/`ARCHIVED`/`STARRED` remain tags because
they are pure user filing with no metadata.

### MailStatus

```typescript
enum MailStatus { Draft, Sent, Received }
```

`messages.status` is the coarse lifecycle a mailbox files by. Inbound mail
is always `RECEIVED`; outbound is `DRAFT` until dispatched, then `SENT`.
`DeliveryStatus` keeps carrying transport detail (QUEUED/SENT/FAILED) and
is only meaningful once a message leaves `DRAFT`. A draft is created by
`saveDraft`, edited in place (subject, bodies, recipients, attachments),
and `sendDraft` dispatches it -- the draft row *becomes* the sent message,
same id and thread.

### MessageEvent

```typescript
enum MessageEventKind { Deadline, Reminder, FollowUp, Other }
interface MessageEvent {
  readonly id: MessageEventId;
  readonly messageId: MessageId;
  readonly kind: MessageEventKind;
  readonly dueAt: string | null;     // required for Deadline
  readonly title: string;            // "reply"
  readonly note: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

The canonical example: mail that needs an answer by 10/1 carries
`(DEADLINE, 2026-10-01, "reply")`. A message may carry any number of
events (`message_events`, cascade on message delete). Writing an event
requires MAIL_MANAGE on the message; the agenda query (`messageEvents`)
is scoped through the owning message's address allowlist exactly like a
message listing.

### Mailing lists: a field, not a tag

`messages.list_id` (RFC 2919 `List-Id`, angle-bracket form stripped) and
`messages.is_mailing_list` are message fields, decided once at receive
time from the standard list headers (`List-Id`, `List-Unsubscribe`,
`List-Post`, `Precedence: list|bulk`) or asserted by a rule. A field
because list-ness is an intrinsic, deterministically-detected property
that carries data and must survive tag renames; user categorization on
top of it (which list goes to which folder) is what TAG rules are for.

### ClassificationRule

```typescript
enum RuleField   { SenderAddress, SenderDomain, Subject, ListId }
enum RuleMatcher { Exact, Contains, Regex }   // all case-insensitive
enum RuleAction  { Spam, MailingList, Tag }
interface ClassificationRule {
  readonly id: ClassificationRuleId;
  readonly domainId: DomainId | null;  // null = every receiving domain
  readonly field: RuleField;
  readonly matcher: RuleMatcher;
  readonly pattern: string;            // <= 512 chars; regex compile-checked
  readonly action: RuleAction;
  readonly tagId: TagId | null;        // required iff action = Tag
  readonly enabled: boolean;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Evaluated for every inbound message on the receiving domain. Rule
management requires DOMAIN_ADMIN (rules rewrite domain-wide ingest
behaviour). Safety properties: patterns are operator-authored, regexes are
compile-checked at creation, match inputs are truncated to 1024 chars, and
a rule that fails at match time matches nothing -- ingest must never lose
mail to a bad pattern. A rule-applied spam mark is attributed `RULE` and
wins attribution over the scorer; the score is stored either way.

## Fixes and additions (2026-08-23, second pass)

- **Trash lifecycle.** Trashed mail is hidden from every listing except
  the Trash view (or `includeTrashed`). `deleteMessages` is two-stage:
  the first delete tags TRASH, deleting an already-trashed message purges
  it (rows and blobs). One misclick can no longer destroy mail.
- **Honest domain verification.** `verifyDomain` resolves
  `_mailcal.<domain>` TXT over DNS-over-HTTPS (the only DNS mechanism a
  Worker has) and refuses without the token: CONFLICT when the record is
  absent or wrong, SERVICE_UNAVAILABLE when the lookup itself failed. MX
  is deliberately unchecked -- wrong MX just means mail never arrives,
  while a false ownership claim is a security problem.
- **Draft threading.** `SaveDraftInput.inReplyToMessageId` resolves the
  thread context at save time (threadId, In-Reply-To, References), and
  `sendDraft` sends the stored context -- a reply drafted today and sent
  next week still threads.
- **Retroactive rules.** `applyClassificationRule(id)` runs one rule over
  stored inbound mail (newest first, 5000 messages per run, same matcher
  code as ingest) so "this sender is spam" can clean up the past.
- **Agenda.** `MessageEvent.message` field plus the scoped
  `messageEvents` query back the web client's "Upcoming" sidebar section
  (open events due in 30 days, click-through to the mail).

## MailAddress (mailbox provisioning)

A domain used to be either catch-all or reliant on `hasKnownLocalPart`, which
inferred that an address was real once it had *already* sent or received
something. That inference has no way to express a mailbox before its first
message, no way to list which mailboxes exist, and no way to close one.

`MailAddress` makes the set of real addresses something the operator states:

```typescript
enum MailAddressStatus { Active = "ACTIVE", Disabled = "DISABLED" }

interface MailAddress {
  readonly id: MailAddressId;
  readonly domainId: DomainId;
  readonly localPart: string;        // lower-cased, unique per domain
  readonly address: EmailAddress;    // denormalized localPart@domain
  readonly displayName: string | null;
  readonly status: MailAddressStatus;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

The mint-time local-part grammar is deliberately narrower than what
`EmailAddress` parses inbound: mail from the outside world may carry
exotic-but-legal local parts and must still be delivered, whereas an address
an operator creates should need no quoting anywhere.

The local part is immutable. Changing it would silently redirect mail already
addressed to the old one; the honest expression of that intent is a new
address plus a disabled old one.

### Delivery precedence

Evaluated in `resolveRecipient` on the ingest path:

1. An `ACTIVE` row accepts.
2. A `DISABLED` row rejects -- **even on a catch-all domain**, which is the
   only way to close a single mailbox without closing the domain. It is
   reported distinctly from "never existed", because the sender's mistake is
   a different one.
3. No row at all falls back to the previous catch-all / `hasKnownLocalPart`
   behaviour, so a domain that predates the feature delivers exactly as before.

### Administration

Managing mailboxes requires `DOMAIN_ADMIN` -- the credential that may add a
domain is the one that may say which mailboxes exist on it. No separate
capability: there is no distinct threat model to justify the extra knob.

Deleting is refused once the mailbox has carried mail, mirroring
`deleteDomain`; disabling is the reversible way to close an address with
history.

