# GraphQL API

One endpoint, `POST /graphql` (plus `GET /graphql` for GraphiQL in local dev),
served by graphql-yoga on hono. It is the *only* way to read or change state,
apart from two binary REST routes that GraphQL is a poor fit for
(`/api/attachments` upload and `/files/:token` download).

## Authentication

| Header | Meaning |
|--------|---------|
| `Authorization: Bearer ybm_...` | API key (agents, programmatic clients) |
| `Cookie: mailcal_session=...` | Browser session |

The hono auth middleware resolves either to a `Viewer` and puts it on the
GraphQL context. Unauthenticated requests are not rejected at the middleware:
resolvers decide, so that a future public field needs no middleware change.

## Errors

Every error carries `extensions.code`:

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | No credential, or it did not resolve |
| `FORBIDDEN` | Authenticated but the scope does not permit this |
| `NOT_FOUND` | No such entity, or it is outside the viewer's scope |
| `BAD_USER_INPUT` | Field-level validation failure; carries `field` |
| `CONFLICT` | Conflicts with current state (duplicate, bad transition) |
| `SERVICE_UNAVAILABLE` | Outbound mail is not configured on this instance |
| `INTERNAL_SERVER_ERROR` | Masked; the original message never reaches clients |

Depth and selection-count limit plugins reject pathological documents before
execution, since the endpoint is exposed to untrusted agents.

## Schema

### Scalars and enums

```graphql
scalar DateTime

enum MessageDirection { INBOUND OUTBOUND }
enum DeliveryStatus   { RECEIVED QUEUED SENT FAILED }
enum RecipientKind    { TO CC BCC ENVELOPE }
enum FetchStatus      { NOT_FETCHED FETCHED }
enum TagKind          { USER SYSTEM }
enum SystemTagSlug    { SPAM TRASH ARCHIVED STARRED }
enum DomainStatus     { PENDING ACTIVE DISABLED }
enum Capability       { MAIL_READ MAIL_SEND MAIL_MANAGE FILE_LINK DOMAIN_ADMIN KEY_ADMIN }
enum FileLinkTarget   { ATTACHMENT RAW_MESSAGE }
enum AttachmentKind   { IMAGE VIDEO AUDIO PDF DOCUMENT SPREADSHEET
                        PRESENTATION ARCHIVE TEXT CALENDAR OTHER }
enum UserRole         { ADMIN MEMBER }
```

### Core types

```graphql
type MailDomain {
  id: ID!
  name: String!
  status: DomainStatus!
  catchAll: Boolean!
  verificationToken: String!     # ADMIN / DOMAIN_ADMIN only, else null
  verifiedAt: DateTime
  dnsRecords: [DnsRecord!]!      # what the operator must publish
  messageCount: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Message {
  id: ID!
  domain: MailDomain!
  direction: MessageDirection!
  threadId: ID!
  rfcMessageId: String
  subject: String!
  from: MailboxAddress!
  recipients(kind: RecipientKind): [MailboxAddress!]!
  snippet: String!
  textBody: String
  htmlBody: String
  bodyTruncated: Boolean!
  attachments: [Attachment!]!
  tags: [Tag!]!
  spamScore: Float
  isSpam: Boolean!
  deliveryStatus: DeliveryStatus!
  deliveryError: String
  readAt: DateTime
  # Fetch state for the *calling* API key; a user viewer always sees FETCHED.
  fetchStatus: FetchStatus!
  fetchedAt: DateTime
  rawSize: Int!
  occurredAt: DateTime!
  createdAt: DateTime!
}

type MailboxAddress { address: String!  name: String  kind: RecipientKind! }

type Attachment {
  id: ID!
  message: Message!
  fileName: String!
  contentType: String!
  size: Int!
  inline: Boolean!
  # Classified once at receive time and stored, so filtering is stable even
  # if the classification rules later change. Derived from the declared
  # content type with an extension fallback; drives search grouping only,
  # never a security decision.
  kind: AttachmentKind!
  contentId: String
  createdAt: DateTime!
}

type Tag {
  id: ID!
  name: String!
  color: String
  kind: TagKind!
  systemSlug: SystemTagSlug
  messageCount: Int!
}

type Thread {
  id: ID!
  subject: String!
  messages: [Message!]!
  messageCount: Int!
  lastMessageAt: DateTime!
  participants: [MailboxAddress!]!
}

type ApiKey {
  id: ID!
  name: String!
  keyPrefix: String!
  scopes: [ApiKeyScope!]!
  createdAt: DateTime!
  lastUsedAt: DateTime
  expiresAt: DateTime
  revokedAt: DateTime
}

type ApiKeyScope {
  id: ID!
  capability: Capability!
  domain: MailDomain          # null = every managed domain
  addressPattern: String!
}

# The plaintext secret is returned exactly once, here, and never again.
type ApiKeyWithSecret { apiKey: ApiKey!  secret: String! }

enum UserRole { ADMIN MEMBER VIEWER }
enum UserPermissionEffect { ALLOW DENY }

type UserMailPermission {
  id: ID!
  effect: UserPermissionEffect!
  domain: MailDomain
  addressPattern: String!
  createdAt: DateTime!
}

type User {
  id: ID!
  email: String!
  name: String!
  role: UserRole!
  active: Boolean!
  permissions: [UserMailPermission!]!
}

type FileLink {
  id: ID!
  url: String!                # absolute, /files/<token>
  target: FileLinkTarget!
  attachment: Attachment
  message: Message
  expiresAt: DateTime!
  maxDownloads: Int
  downloadCount: Int!
  createdAt: DateTime!
}

type MessagePage {
  nodes: [Message!]!
  nextCursor: String          # null when exhausted
  totalCount: Int!
}
```

### Queries

```graphql
type Query {
  viewer: Viewer

  domains: [MailDomain!]!
  domain(id: ID!): MailDomain

  messages(filter: MessageFilter, first: Int = 50, after: String): MessagePage!
  message(id: ID!): Message
  thread(id: ID!): Thread

  tags: [Tag!]!
  apiKeys: [ApiKey!]!                 # KEY_ADMIN / ADMIN only
  users: [User!]!                     # ADMIN user only
  user(id: ID!): User                 # ADMIN user only
  fileLinks(messageId: ID): [FileLink!]!
}

input UserMailPermissionInput {
  effect: UserPermissionEffect!
  domainId: ID
  addressPattern: String = "*"
}

input CreateUserInput { email: String! name: String! role: UserRole! }

type Mutation {
  createUser(input: CreateUserInput!): User!
  setUserRole(id: ID!, role: UserRole!): User!
  setUserActive(id: ID!, active: Boolean!): User!
  addUserMailPermission(userId: ID!, permission: UserMailPermissionInput!): User!
  removeUserMailPermission(permissionId: ID!): Boolean!
}

input MessageFilter {
  domainId: ID
  direction: MessageDirection
  address: String            # any recipient or the sender matches
  toAddress: String          # recipient WITHOUT cc: envelope/To only
  recipientAddress: String   # recipient WITH cc: any kind incl. Cc/Bcc
  fromAddress: String
  threadId: ID
  tagIds: [ID!]
  systemSlugs: [SystemTagSlug!]
  includeSpam: Boolean = false
  fetchStatus: FetchStatus   # relative to the calling API key
  unreadOnly: Boolean
  search: String             # full text: subject + snippet + text body
  hasAttachment: Boolean     # true = with attachments, false = without
  attachmentKinds: [AttachmentKind!]  # any listed kind matches
  since: DateTime
  until: DateTime
}

# Search note: full-text is a LIKE scan over subject, snippet and the
# stored text body (capped at 256 KiB per message at ingest). An FTS5
# index was deliberately rejected: its shadow-table triggers contain `;`
# inside CREATE TRIGGER bodies, which the migration runner's statement
# splitter would corrupt. At self-hosted volume the scan is honest work;
# revisit alongside a real SQL splitter if it ever isn't.
```

Results are always intersected with the viewer's scopes, newest first, keyset
paginated on `(occurred_at DESC, id DESC)` with an opaque base64 cursor.

### Mutations

```graphql
type Mutation {
  # --- domains (DOMAIN_ADMIN) ---
  createDomain(name: String!, catchAll: Boolean = true): MailDomain!
  verifyDomain(id: ID!): MailDomain!
  setDomainStatus(id: ID!, status: DomainStatus!): MailDomain!
  deleteDomain(id: ID!): Boolean!

  # --- api keys (KEY_ADMIN) ---
  createApiKey(input: CreateApiKeyInput!): ApiKeyWithSecret!
  revokeApiKey(id: ID!): ApiKey!
  addApiKeyScope(apiKeyId: ID!, scope: ApiKeyScopeInput!): ApiKey!
  removeApiKeyScope(scopeId: ID!): ApiKey!

  # --- sending (MAIL_SEND) ---
  sendMessage(input: SendMessageInput!): Message!
  retrySend(messageId: ID!): Message!

  # --- fetch state (MAIL_MANAGE) ---
  markMessagesFetched(messageIds: [ID!]!): [Message!]!
  markMessagesNotFetched(messageIds: [ID!]!): [Message!]!

  # --- tagging (MAIL_MANAGE) ---
  createTag(name: String!, color: String): Tag!
  renameTag(id: ID!, name: String!, color: String): Tag!
  deleteTag(id: ID!): Boolean!
  tagMessages(messageIds: [ID!]!, tagIds: [ID!]!): [Message!]!
  untagMessages(messageIds: [ID!]!, tagIds: [ID!]!): [Message!]!
  markSpam(messageIds: [ID!]!): [Message!]!
  markNotSpam(messageIds: [ID!]!): [Message!]!
  markRead(messageIds: [ID!]!, read: Boolean! = true): [Message!]!
  deleteMessages(messageIds: [ID!]!): Int!

  # --- file links (FILE_LINK) ---
  createAttachmentLink(attachmentId: ID!, ttlSeconds: Int = 3600,
                       maxDownloads: Int): FileLink!
  createRawMessageLink(messageId: ID!, ttlSeconds: Int = 3600,
                       maxDownloads: Int): FileLink!
  revokeFileLink(id: ID!): Boolean!

  # --- browser session auth ---
  requestEmailAuth(email: String!): Boolean!
  verifyEmailAuthToken(token: String!): AuthPayload!
  logout: Boolean!
}

input SendMessageInput {
  from: String!
  to: [String!]!
  cc: [String!]
  bcc: [String!]
  subject: String!
  text: String
  html: String
  inReplyToMessageId: ID
  attachmentIds: [ID!]
  headers: [HeaderInput!]      # X--prefixed custom headers only
  tagIds: [ID!]
}

input CreateApiKeyInput {
  name: String!
  scopes: [ApiKeyScopeInput!]!
  expiresAt: DateTime
}

input ApiKeyScopeInput {
  capability: Capability!
  domainId: ID                 # null = every managed domain
  addressPattern: String = "*"
}
```

## Fetch state

The agent consumption loop, which is the reason this API exists:

```graphql
query Poll {
  messages(filter: { fetchStatus: NOT_FETCHED, direction: INBOUND }, first: 20) {
    nodes { id subject from { address } snippet attachments { id fileName } }
    nextCursor
  }
}

mutation Ack($ids: [ID!]!) {
  markMessagesFetched(messageIds: $ids) { id fetchStatus fetchedAt }
}
```

`fetchStatus` is evaluated **per calling API key**. Two agents polling the same
mailbox each see every message once. A `USER` viewer has no fetch state of its
own and always reads `FETCHED`, so the browser client is never affected by --
and never disturbs -- an agent's progress.

`markMessagesFetched` is idempotent: re-acknowledging an already-fetched
message succeeds and leaves `fetchedAt` at its original value.

## Binary REST routes

GraphQL carries metadata; bytes go over plain HTTP.

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/attachments` (multipart, field `file`) | viewer | Upload a body for a later `sendMessage` |
| `GET /api/attachments/:id` | viewer | Download an attachment |
| `GET /files/:token` | the token itself | Temp file link; see `design-storage-and-file-links.md` |

Downloads always set `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`, and force `Content-Disposition: attachment`
for anything outside a small inline-safe content-type allowlist -- mail
attachments are attacker-controlled by definition, so this is the stored-XSS
boundary.

## Additions 2026-08-23: status, spam verdicts, events, rules

```graphql
enum MailStatus        { DRAFT SENT RECEIVED }
enum MessageEventKind  { DEADLINE REMINDER FOLLOW_UP OTHER }
enum SpamMarkedBy      { SYSTEM USER RULE }
enum RuleField         { SENDER_ADDRESS SENDER_DOMAIN SUBJECT LIST_ID }
enum RuleMatcher       { EXACT CONTAINS REGEX }
enum RuleAction        { SPAM MAILING_LIST TAG }

# Message gains:
#   status: MailStatus!            spam: SpamMark (null = not spam)
#   listId: String                 isMailingList: Boolean!
#   events: [MessageEvent!]!
# MessageFilter gains:
#   spamOnly, statuses, mailingList, listId
# SystemTagSlug lost SPAM (spam is a verdict table now).

type Query {
  messageEvents(dueBefore, dueAfter, includeCompleted, limit): [MessageEvent!]!
  classificationRules: [ClassificationRule!]!   # DOMAIN_ADMIN
}

type Mutation {
  saveDraft(input: SaveDraftInput!): Message!
  sendDraft(id: ID!): Message!
  createMessageEvent(input: CreateMessageEventInput!): MessageEvent!
  updateMessageEvent(id: ID!, input: UpdateMessageEventInput!): MessageEvent!
  deleteMessageEvent(id: ID!): Boolean!
  createClassificationRule(input: CreateClassificationRuleInput!): ClassificationRule!
  setClassificationRuleEnabled(id: ID!, enabled: Boolean!): ClassificationRule!
  deleteClassificationRule(id: ID!): Boolean!
}
```

`markSpam`/`markNotSpam` keep their signatures but now write/delete
`message_spam` rows (hand marks are `USER`, score null).
