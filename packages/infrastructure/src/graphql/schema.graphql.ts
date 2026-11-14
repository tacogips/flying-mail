/**
 * The mail and admin half of the mailcal GraphQL schema, mirroring
 * `design-docs/specs/design-graphql-api.md#schema`.
 *
 * This document owns `Query` and `Mutation`; the feature modules
 * (`schema-calendar.graphql.ts`, `schema-templates.graphql.ts`) `extend`
 * them, and `schema.ts` merges all three through `createSchema`. The split
 * exists because a single document had reached the repository's 1000-line
 * ceiling -- see `.agents/skills/ts-coding-standards`.
 *
 * The admin user-management surface stays here in full, feature capabilities
 * included: `Capability`, `CalendarCapability`, `TemplateCapability`, the
 * three `User*Permission` types and their mutations belong to user
 * administration rather than to the features they name.
 */
export const typeDefs = /* GraphQL */ `
  """
  An ISO 8601 timestamp in UTC, e.g. "2026-08-23T00:00:00.000Z".
  """
  scalar DateTime

  enum MessageDirection {
    INBOUND
    OUTBOUND
  }

  enum DeliveryStatus {
    RECEIVED
    QUEUED
    SENT
    FAILED
  }

  """
  ENVELOPE is the SMTP RCPT TO -- the address that actually caused delivery,
  and the one API key scopes are matched against.
  """
  enum RecipientKind {
    TO
    CC
    BCC
    ENVELOPE
  }

  """
  Retrieval state for the *calling* API key. A user session always reads
  FETCHED, since fetch state is per-consumer.
  """
  enum FetchStatus {
    NOT_FETCHED
    FETCHED
  }

  enum TagKind {
    USER
    SYSTEM
  }

  """
  SPAM is deliberately absent: spam is a verdict with metadata, held in its
  own table and exposed via Message.isSpam / Message.spam.
  """
  enum SystemTagSlug {
    TRASH
    ARCHIVED
    STARRED
  }

  enum DomainStatus {
    PENDING
    ACTIVE
    DISABLED
  }

  """
  Whether a provisioned mailbox accepts mail. DISABLED rejects even on a
  catch-all domain, which is the only way to close one address without
  closing the domain, and it keeps the mailbox's history and grants.
  """
  enum MailAddressStatus {
    ACTIVE
    DISABLED
  }

  enum Capability {
    MAIL_READ
    MAIL_SEND
    MAIL_MANAGE
    FILE_LINK
    DOMAIN_ADMIN
    KEY_ADMIN
    TEMPLATE_READ
    TEMPLATE_CREATE
    TEMPLATE_UPDATE
    TEMPLATE_DELETE
    CALENDAR_READ
    CALENDAR_WRITE
  }

  """
  The two calendar capabilities, as a per-user rule may name them. A
  narrowed enum rather than Capability, so a rule cannot name a mail
  capability through the calendar permission surface.
  """
  enum CalendarCapability {
    CALENDAR_READ
    CALENDAR_WRITE
  }

  "The mail-template capabilities, narrowed the same way."
  enum TemplateCapability {
    TEMPLATE_READ
    TEMPLATE_CREATE
    TEMPLATE_UPDATE
    TEMPLATE_DELETE
  }

  """
  Coarse file-type grouping, classified once at receive time and stored, so
  filtering is stable even if classification rules later change.
  """
  enum AttachmentKind {
    IMAGE
    VIDEO
    AUDIO
    PDF
    DOCUMENT
    SPREADSHEET
    PRESENTATION
    ARCHIVE
    TEXT
    CALENDAR
    OTHER
  }

  """
  Coarse mail lifecycle. DRAFT exists only for outbound mail that has not
  been dispatched. Transport detail stays in DeliveryStatus, which is only
  meaningful once a message leaves DRAFT.
  """
  enum MailStatus {
    DRAFT
    SENT
    RECEIVED
  }

  enum MessageEventKind {
    DEADLINE
    REMINDER
    FOLLOW_UP
    OTHER
  }

  enum SpamMarkedBy {
    SYSTEM
    USER
    RULE
  }

  enum RuleField {
    SENDER_ADDRESS
    SENDER_DOMAIN
    SUBJECT
    LIST_ID
  }

  enum RuleMatcher {
    EXACT
    CONTAINS
    REGEX
  }

  enum RuleAction {
    SPAM
    MAILING_LIST
    TAG
  }

  enum FileLinkTarget {
    ATTACHMENT
    RAW_MESSAGE
  }

  """
  ADMIN administers the instance and, by default, every managed mailbox.
  MEMBER may read/send/manage assigned mail. VIEWER may only read and open
  attachments on assigned mail. See UserMailPermission for how "assigned"
  is granted.
  """
  enum UserRole {
    ADMIN
    MEMBER
    VIEWER
  }

  """
  ALLOW grants a role's mail capabilities on the matching mailbox; DENY
  always wins over any overlapping ALLOW, including an ADMIN's default
  access to every mailbox.
  """
  enum UserPermissionEffect {
    ALLOW
    DENY
  }

  enum DnsRecordType {
    TXT
    MX
    CNAME
  }

  type DnsRecord {
    type: DnsRecordType!
    name: String!
    value: String!
    priority: Int
    purpose: String!
  }

  type MailDomain {
    id: ID!
    name: String!
    status: DomainStatus!
    catchAll: Boolean!
    """
    Null unless the viewer holds DOMAIN_ADMIN.
    """
    verificationToken: String
    verifiedAt: DateTime
    dnsRecords: [DnsRecord!]!
    messageCount: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  An explicitly provisioned mailbox on a managed domain.

  Without one, a domain either accepts every local part (catch-all) or only
  the ones it can infer from message history -- so a mailbox could not be
  created ahead of its first message, listed, or closed. Managing these
  requires DOMAIN_ADMIN, the same credential that adds the domain.
  """
  type MailAddress {
    id: ID!
    domain: MailDomain!
    "Normalized to lower case, unique within the domain."
    localPart: String!
    "The full localPart@domain form."
    address: String!
    displayName: String
    status: MailAddressStatus!
    "Null when the mailbox was created by an API key rather than a user."
    createdByUserId: ID
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input CreateMailAddressInput {
    domainId: ID!
    """
    Letters, digits and . _ + - starting and ending with a letter or digit.
    Deliberately narrower than what inbound mail may carry.
    """
    localPart: String!
    displayName: String
  }

  type MailboxAddress {
    address: String!
    name: String
    kind: RecipientKind!
  }

  type Attachment {
    id: ID!
    """
    Null for a staged upload that has not yet been sent as part of a message.
    """
    messageId: ID
    fileName: String!
    contentType: String!
    size: Int!
    inline: Boolean!
    kind: AttachmentKind!
    contentId: String
    """
    Authenticated download path; use createAttachmentLink for a shareable,
    credential-free URL instead.
    """
    url: String!
    createdAt: DateTime!
  }

  """
  The spam verdict on a message. Presence is the verdict; absence means
  the message is not spam.
  """
  type SpamMark {
    "Score at marking time. Null for hand marks: no scorer ran."
    score: Float
    markedBy: SpamMarkedBy!
    markedAt: DateTime!
  }

  """
  An obligation or note attached to a message: mail that needs an answer
  by 10/1 carries a DEADLINE event with dueAt 10/1 and title "reply". A
  message can carry any number of events.
  """
  type MessageEvent {
    id: ID!
    messageId: ID!
    "The mail this event annotates, for agenda views."
    message: Message
    kind: MessageEventKind!
    "Null for undated notes. A DEADLINE always has one."
    dueAt: DateTime
    title: String!
    note: String
    completedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  "Outcome of running a rule over already-stored mail."
  type RuleApplication {
    "Messages inspected (bounded per run)."
    examined: Int!
    "Messages the rule matched and acted on."
    matched: Int!
  }

  """
  An operator-defined ingest rule: when field matches pattern, perform
  action on the incoming message. Evaluated for every inbound message on
  the rule's domain (all domains when domain is null).
  """
  type ClassificationRule {
    id: ID!
    domain: MailDomain
    field: RuleField!
    matcher: RuleMatcher!
    pattern: String!
    action: RuleAction!
    tag: Tag
    enabled: Boolean!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Tag {
    id: ID!
    name: String!
    color: String
    kind: TagKind!
    systemSlug: SystemTagSlug
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
    inReplyTo: String
    references: [String!]!
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
    "The verdict's metadata; null when the message is not spam."
    spam: SpamMark
    status: MailStatus!
    deliveryStatus: DeliveryStatus!
    "RFC 2919 List-Id, when the message came through a declaring list."
    listId: String
    isMailingList: Boolean!
    events: [MessageEvent!]!
    deliveryError: String
    readAt: DateTime
    fetchStatus: FetchStatus!
    fetchedAt: DateTime
    rawSize: Int!
    occurredAt: DateTime!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Thread {
    id: ID!
    subject: String!
    messages: [Message!]!
    messageCount: Int!
    lastMessageAt: DateTime!
    participants: [MailboxAddress!]!
  }

  type MessagePage {
    nodes: [Message!]!
    """
    Null once the result set is exhausted.
    """
    nextCursor: String
    totalCount: Int!
  }

  type ApiKeyScope {
    id: ID!
    capability: Capability!
    """
    Null means every managed domain.
    """
    domain: MailDomain
    addressPattern: String!
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

  """
  The plaintext secret is returned exactly once, here, and never again.
  """
  type ApiKeyWithSecret {
    apiKey: ApiKey!
    secret: String!
  }

  type FileLink {
    id: ID!
    url: String!
    target: FileLinkTarget!
    attachment: Attachment
    message: Message
    expiresAt: DateTime!
    maxDownloads: Int
    downloadCount: Int!
    createdAt: DateTime!
    revokedAt: DateTime
  }

  """
  Returned once from createAttachmentLink / createRawMessageLink. The token
  is the credential embedded in the url, and is never retrievable afterwards.
  """
  type CreatedFileLink {
    link: FileLink!
    token: String!
    url: String!
  }

  """
  A mailbox rule an admin grants (or denies) a user, scoped by domain and
  address pattern. Only meaningful for a MEMBER or VIEWER role's mail
  access, and for an ADMIN's self-imposed denies -- see User.role.
  """
  type UserMailPermission {
    id: ID!
    effect: UserPermissionEffect!
    """
    Null means every managed domain.
    """
    domain: MailDomain
    addressPattern: String!
    createdByUserId: ID!
    createdAt: DateTime!
  }

  """
  An admin-assigned grant or denial of one template capability. Templates
  are instance-wide, so there is no address axis here.
  """
  type UserTemplatePermission {
    id: ID!
    capability: TemplateCapability!
    effect: UserPermissionEffect!
    createdByUserId: ID!
    createdAt: DateTime!
  }

  input UserTemplatePermissionInput {
    capability: TemplateCapability!
    effect: UserPermissionEffect!
  }

  """
  An admin-assigned grant or denial of one calendar capability, scoped to a
  calendar owner.

  This is what makes an admin's default access to every calendar revocable:
  a DENY is consulted first, so an admin may administer permissions on a
  calendar it cannot itself read.
  """
  type UserCalendarPermission {
    id: ID!
    capability: CalendarCapability!
    effect: UserPermissionEffect!
    "Null means every calendar owner, the holder's own included."
    ownerUserId: ID
    createdByUserId: ID!
    createdAt: DateTime!
  }

  input UserCalendarPermissionInput {
    capability: CalendarCapability!
    effect: UserPermissionEffect!
    """
    Null means every calendar owner. A specific owner narrows the rule to
    that person's calendars.
    """
    ownerUserId: ID
  }

  type User {
    id: ID!
    email: String!
    name: String!
    role: UserRole!
    """
    False once deactivated; a deactivated user cannot sign in.
    """
    active: Boolean!
    """
    Empty for an ADMIN with no self-imposed denies, and for a MEMBER/VIEWER
    with no mailbox assigned yet.
    """
    permissions: [UserMailPermission!]!
    """
    Explicit template grants and denials. Empty means the role default
    applies.
    """
    templatePermissions: [UserTemplatePermission!]!
    """
    Explicit calendar grants and denials. Empty means the role default
    applies: an ADMIN reaches every calendar, everyone else only their own.
    """
    calendarPermissions: [UserCalendarPermission!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  The calling credential. user is null for an API key; apiKey is null for a
  session.
  """
  type Viewer {
    user: User
    apiKey: ApiKey
    capabilities: [Capability!]!
    sendableAddresses: [String!]!
  }

  type BootstrapPayload {
    user: User!
    apiKey: ApiKey!
    """
    Shown exactly once, here.
    """
    secret: String!
  }

  type AuthPayload {
    viewer: Viewer!
    expiresAt: DateTime!
  }

  input MessageFilter {
    domainId: ID
    direction: MessageDirection
    """
    Matches the sender or any recipient.
    """
    address: String
    """
    Recipient without cc: matches an ENVELOPE or TO recipient only.
    """
    toAddress: String
    """
    Recipient with cc: matches a recipient of any kind, CC and BCC included.
    """
    recipientAddress: String
    fromAddress: String
    threadId: ID
    tagIds: [ID!]
    systemSlugs: [SystemTagSlug!]
    includeSpam: Boolean = false
    """
    Relative to the calling API key; rejected for a user session.
    """
    fetchStatus: FetchStatus
    unreadOnly: Boolean
    """
    Case-insensitive full-text match over subject, snippet and text body.
    """
    search: String
    """
    True keeps only messages with attachments; false only those without.
    """
    hasAttachment: Boolean
    """
    Keeps messages carrying at least one attachment of any listed kind.
    """
    attachmentKinds: [AttachmentKind!]
    "Restrict to spam only -- the Spam folder view. Wins over includeSpam."
    spamOnly: Boolean
    "Trashed mail is hidden from every view except Trash unless set."
    includeTrashed: Boolean
    statuses: [MailStatus!]
    "True keeps only mailing-list messages, false only the rest."
    mailingList: Boolean
    "Exact match on the stored List-Id."
    listId: String
    since: DateTime
    until: DateTime
  }

  input HeaderInput {
    """
    Must match X-Name; values may not contain CR or LF.
    """
    name: String!
    value: String!
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
    headers: [HeaderInput!]
    tagIds: [ID!]
  }

  input SaveDraftInput {
    "Updates this draft when present, creates a new one otherwise."
    draftId: ID
    "Threads the draft as a reply to this message."
    inReplyToMessageId: ID
    from: String!
    to: [String!]
    cc: [String!]
    bcc: [String!]
    subject: String
    text: String
    html: String
    attachmentIds: [ID!]
  }

  input CreateMessageEventInput {
    messageId: ID!
    kind: MessageEventKind!
    "Required for DEADLINE, optional otherwise."
    dueAt: DateTime
    title: String!
    note: String
  }

  input UpdateMessageEventInput {
    kind: MessageEventKind
    dueAt: DateTime
    title: String
    note: String
    completed: Boolean
  }

  input CreateClassificationRuleInput {
    "Restrict to one receiving domain; null applies everywhere."
    domainId: ID
    field: RuleField!
    matcher: RuleMatcher!
    pattern: String!
    action: RuleAction!
    "Required exactly when action is TAG."
    tagId: ID
    description: String
  }

  input ApiKeyScopeInput {
    capability: Capability!
    """
    Null means every managed domain.
    """
    domainId: ID
    addressPattern: String = "*"
  }

  input CreateApiKeyInput {
    name: String!
    scopes: [ApiKeyScopeInput!]!
    expiresAt: DateTime
  }

  """
  No password: the created user signs in through the existing passwordless
  email flow.
  """
  input CreateUserInput {
    email: String!
    name: String!
    role: UserRole!
  }

  input UserMailPermissionInput {
    effect: UserPermissionEffect!
    """
    Null means every managed domain.
    """
    domainId: ID
    addressPattern: String = "*"
  }

  type Query {
    viewer: Viewer

    domains: [MailDomain!]!
    domain(id: ID!): MailDomain

    messages(filter: MessageFilter, first: Int = 50, after: String): MessagePage!
    message(id: ID!): Message
    thread(id: ID!): Thread

    """
    Provisioned mailboxes. Null domainId lists every domain's. Requires
    DOMAIN_ADMIN.
    """
    mailAddresses(domainId: ID): [MailAddress!]!

    tags: [Tag!]!
    apiKeys: [ApiKey!]!
    fileLinks(messageId: ID!): [FileLink!]!

    """
    Agenda across messages: soonest due first, undated last. Scoped to the
    caller's readable mail.
    """
    messageEvents(
      dueBefore: DateTime
      dueAfter: DateTime
      includeCompleted: Boolean = false
      limit: Int = 100
    ): [MessageEvent!]!

    "Requires DOMAIN_ADMIN."
    classificationRules: [ClassificationRule!]!

    "Admin only."
    users: [User!]!
    "Admin only."
    user(id: ID!): User
  }

  type Mutation {
    createDomain(name: String!, catchAll: Boolean = true): MailDomain!
    verifyDomain(id: ID!): MailDomain!
    setDomainStatus(id: ID!, status: DomainStatus!): MailDomain!
    deleteDomain(id: ID!): Boolean!

    "Requires DOMAIN_ADMIN."
    createMailAddress(input: CreateMailAddressInput!): MailAddress!
    "Changes the label only. The local part is immutable."
    renameMailAddress(id: ID!, displayName: String): MailAddress!
    setMailAddressStatus(id: ID!, status: MailAddressStatus!): MailAddress!
    """
    Refused once the mailbox has carried mail -- disable it instead, so
    stored messages are never orphaned.
    """
    deleteMailAddress(id: ID!): Boolean!

    createApiKey(input: CreateApiKeyInput!): ApiKeyWithSecret!
    revokeApiKey(id: ID!): ApiKey!
    addApiKeyScope(apiKeyId: ID!, scope: ApiKeyScopeInput!): ApiKey!
    removeApiKeyScope(scopeId: ID!): Boolean!

    sendMessage(input: SendMessageInput!): Message!
    retrySend(messageId: ID!): Message!
    saveDraft(input: SaveDraftInput!): Message!
    "Dispatches a draft. The draft row becomes the sent message."
    sendDraft(id: ID!): Message!

    markMessagesFetched(messageIds: [ID!]!): [Message!]!
    markMessagesNotFetched(messageIds: [ID!]!): [Message!]!

    createTag(name: String!, color: String): Tag!
    renameTag(id: ID!, name: String!, color: String): Tag!
    deleteTag(id: ID!): Boolean!
    tagMessages(messageIds: [ID!]!, tagIds: [ID!]!): [Message!]!
    untagMessages(messageIds: [ID!]!, tagIds: [ID!]!): [Message!]!
    markSpam(messageIds: [ID!]!): [Message!]!
    markNotSpam(messageIds: [ID!]!): [Message!]!
    markRead(messageIds: [ID!]!, read: Boolean! = true): [Message!]!
    """
    Two-stage: first delete moves a message to Trash; deleting an
    already-trashed message removes it permanently.
    """
    deleteMessages(messageIds: [ID!]!): Int!

    createMessageEvent(input: CreateMessageEventInput!): MessageEvent!
    updateMessageEvent(id: ID!, input: UpdateMessageEventInput!): MessageEvent!
    deleteMessageEvent(id: ID!): Boolean!

    createClassificationRule(
      input: CreateClassificationRuleInput!
    ): ClassificationRule!
    setClassificationRuleEnabled(id: ID!, enabled: Boolean!): ClassificationRule!
    deleteClassificationRule(id: ID!): Boolean!
    """
    Runs the rule over mail that already arrived (inbound, newest first,
    bounded per run). Re-run to continue on very large mailboxes.
    """
    applyClassificationRule(id: ID!): RuleApplication!

    createAttachmentLink(
      attachmentId: ID!
      ttlSeconds: Int = 3600
      maxDownloads: Int
    ): CreatedFileLink!
    createRawMessageLink(
      messageId: ID!
      ttlSeconds: Int = 3600
      maxDownloads: Int
    ): CreatedFileLink!
    revokeFileLink(id: ID!): Boolean!

    """
    Creates the first ADMIN user together with a full-capability API key.
    Succeeds only while the instance has no users at all, so this is a
    one-shot door on a fresh deployment and is permanently closed afterwards.

    The key is returned because a deployed Worker has no shell, and
    passwordless login needs a verified sending domain that only an
    authenticated admin can add. Store the secret: it is shown once.
    """
    bootstrapAdmin(email: String!, name: String!): BootstrapPayload!

    requestEmailAuth(email: String!): Boolean!
    verifyEmailAuthToken(token: String!): AuthPayload!
    logout: Boolean!

    "Admin only. Creates a user with no password; see CreateUserInput."
    createUser(input: CreateUserInput!): User!
    "Admin only. Rejected if it would demote the last active admin."
    setUserRole(id: ID!, role: UserRole!): User!
    "Admin only. Rejected if it would deactivate the last active admin."
    setUserActive(id: ID!, active: Boolean!): User!
    "Admin only."
    addUserMailPermission(
      userId: ID!
      input: UserMailPermissionInput!
    ): UserMailPermission!
    "Admin only."
    removeUserMailPermission(id: ID!): Boolean!

    "Admin only."
    addUserTemplatePermission(
      userId: ID!
      input: UserTemplatePermissionInput!
    ): UserTemplatePermission!
    "Admin only."
    removeUserTemplatePermission(id: ID!): Boolean!
    """
    Admin only. Gated on the ADMIN role and never on whether the granting
    admin can itself read the calendar: an admin denied access to a
    calendar keeps the power to grant that calendar to somebody else.
    """
    addUserCalendarPermission(
      userId: ID!
      input: UserCalendarPermissionInput!
    ): UserCalendarPermission!
    "Admin only."
    removeUserCalendarPermission(id: ID!): Boolean!
  }
`;
