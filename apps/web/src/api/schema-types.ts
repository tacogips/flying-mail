/**
 * Hand-written mirrors of the GraphQL types this client selects.
 *
 * Deliberately not generated: the surface is small, and a codegen step would
 * add a build dependency plus a drift-detection problem of its own. The
 * `schema.graphql.ts` SDL in `@mailcal/infrastructure` is the source of
 * truth; these are the projections the UI actually reads.
 */

export type MessageDirection = "INBOUND" | "OUTBOUND";
export type DeliveryStatus = "RECEIVED" | "QUEUED" | "SENT" | "FAILED";
export type RecipientKind = "TO" | "CC" | "BCC" | "ENVELOPE";
export type FetchStatus = "NOT_FETCHED" | "FETCHED";
export type TagKind = "USER" | "SYSTEM";
export type SystemTagSlug = "TRASH" | "ARCHIVED" | "STARRED";
export type MailStatus = "DRAFT" | "SENT" | "RECEIVED";
export type MessageEventKind = "DEADLINE" | "REMINDER" | "FOLLOW_UP" | "OTHER";
export type SpamMarkedBy = "SYSTEM" | "USER" | "RULE";
export type DomainStatus = "PENDING" | "ACTIVE" | "DISABLED";
export type UserRole = "ADMIN" | "MEMBER" | "VIEWER";
export type MailAddressStatus = "ACTIVE" | "DISABLED";
export type UserPermissionEffect = "ALLOW" | "DENY";
export type AttachmentKind =
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "PDF"
  | "DOCUMENT"
  | "SPREADSHEET"
  | "PRESENTATION"
  | "ARCHIVE"
  | "TEXT"
  | "CALENDAR"
  | "OTHER";
export type Capability =
  | "MAIL_READ"
  | "MAIL_SEND"
  | "MAIL_MANAGE"
  | "FILE_LINK"
  | "DOMAIN_ADMIN"
  | "KEY_ADMIN"
  | "TEMPLATE_READ"
  | "TEMPLATE_CREATE"
  | "TEMPLATE_UPDATE"
  | "TEMPLATE_DELETE"
  | "CALENDAR_READ"
  | "CALENDAR_WRITE";

export type TemplateCapability =
  | "TEMPLATE_READ"
  | "TEMPLATE_CREATE"
  | "TEMPLATE_UPDATE"
  | "TEMPLATE_DELETE";

export type CalendarCapability = "CALENDAR_READ" | "CALENDAR_WRITE";

export type TemplateVariableType =
  | "TEXT"
  | "MULTILINE_TEXT"
  | "NUMBER"
  | "BOOLEAN"
  | "DATE"
  | "EMAIL";

export interface TemplateVariableView {
  readonly key: string;
  readonly label: string;
  readonly type: TemplateVariableType;
  readonly required: boolean;
  readonly defaultValue: string | null;
  readonly description: string | null;
}

export interface MailTemplateView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly variables: readonly TemplateVariableView[];
  readonly referencedVariableKeys: readonly string[];
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateValueInput {
  readonly key: string;
  readonly value: string;
}

export interface TemplateValueProblemView {
  readonly key: string;
  readonly reason: string;
}

export interface TemplateValidationView {
  readonly valid: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly TemplateValueProblemView[];
  readonly unknown: readonly string[];
}

export interface RenderedTemplateView {
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly validation: TemplateValidationView;
}

export interface TemplateVariableInputVariables {
  readonly key: string;
  readonly label: string | null;
  readonly type: TemplateVariableType;
  readonly required: boolean;
  readonly defaultValue: string | null;
  readonly description: string | null;
}

export interface MailTemplateInputVariables {
  readonly name: string;
  readonly description: string | null;
  readonly subject: string;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly variables: readonly TemplateVariableInputVariables[];
}

export interface SendTemplatedMessageVariables {
  readonly templateId: string;
  readonly values: readonly TemplateValueInput[];
  readonly from?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly inReplyToMessageId?: string;
  readonly attachmentIds?: readonly string[];
  readonly tagIds?: readonly string[];
}

export interface UserTemplatePermissionView {
  readonly id: string;
  readonly capability: TemplateCapability;
  readonly effect: "ALLOW" | "DENY";
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface UserCalendarPermissionView {
  readonly id: string;
  readonly capability: CalendarCapability;
  readonly effect: "ALLOW" | "DENY";
  readonly ownerUserId: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface MailboxAddressView {
  readonly address: string;
  readonly name: string | null;
  readonly kind: RecipientKind;
}

export interface AttachmentView {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly inline: boolean;
  readonly kind: AttachmentKind;
  readonly url: string;
}

export interface TagView {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly kind: TagKind;
  readonly systemSlug: SystemTagSlug | null;
  readonly messageCount: number;
}

export interface SpamMarkView {
  readonly score: number | null;
  readonly markedBy: SpamMarkedBy;
  readonly markedAt: string;
}

export interface MessageEventView {
  readonly id: string;
  readonly messageId: string;
  readonly kind: MessageEventKind;
  readonly dueAt: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly completedAt: string | null;
  /** Present on agenda queries that select it. */
  readonly message?: { readonly id: string; readonly subject: string } | null;
}

export interface MessageView {
  readonly id: string;
  readonly threadId: string;
  readonly direction: MessageDirection;
  readonly subject: string;
  readonly snippet: string;
  readonly from: MailboxAddressView;
  readonly recipients: readonly MailboxAddressView[];
  readonly tags: readonly TagView[];
  readonly attachments: readonly AttachmentView[];
  readonly isSpam: boolean;
  readonly spam: SpamMarkView | null;
  readonly spamScore: number | null;
  readonly status: MailStatus;
  readonly deliveryStatus: DeliveryStatus;
  readonly listId: string | null;
  readonly isMailingList: boolean;
  readonly deliveryError: string | null;
  readonly readAt: string | null;
  readonly fetchStatus: FetchStatus;
  readonly occurredAt: string;
  readonly domain: { readonly id: string; readonly name: string };
}

export interface MessageDetailView extends MessageView {
  readonly events: readonly MessageEventView[];
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly bodyTruncated: boolean;
  readonly rfcMessageId: string | null;
  readonly rawSize: number;
}

export interface MessagePageView {
  readonly nodes: readonly MessageView[];
  readonly nextCursor: string | null;
  readonly totalCount: number;
}

export interface ThreadView {
  readonly id: string;
  readonly subject: string;
  readonly messageCount: number;
  readonly lastMessageAt: string;
  readonly participants: readonly MailboxAddressView[];
  readonly messages: readonly MessageDetailView[];
}

export interface DnsRecordView {
  readonly type: "TXT" | "MX" | "CNAME";
  readonly name: string;
  readonly value: string;
  readonly priority: number | null;
  readonly purpose: string;
}

export interface MailDomainView {
  readonly id: string;
  readonly name: string;
  readonly status: DomainStatus;
  readonly catchAll: boolean;
  readonly verificationToken: string | null;
  readonly verifiedAt: string | null;
  readonly messageCount: number;
  readonly dnsRecords: readonly DnsRecordView[];
}

export interface ApiKeyScopeView {
  readonly id: string;
  readonly capability: Capability;
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly addressPattern: string;
}

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly ApiKeyScopeView[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface UserMailPermissionView {
  readonly id: string;
  readonly effect: UserPermissionEffect;
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly addressPattern: string;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly active: boolean;
  readonly permissions: readonly UserMailPermissionView[];
  readonly templatePermissions: readonly UserTemplatePermissionView[];
  readonly calendarPermissions: readonly UserCalendarPermissionView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ViewerView {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly role: UserRole;
  } | null;
  readonly apiKey: { readonly id: string; readonly keyPrefix: string } | null;
  readonly capabilities: readonly Capability[];
  readonly sendableAddresses: readonly string[];
}

export interface CreatedFileLinkView {
  readonly token: string;
  readonly url: string;
  readonly link: {
    readonly id: string;
    readonly expiresAt: string;
    readonly maxDownloads: number | null;
    readonly downloadCount: number;
  };
}

export interface MessageFilterVariables {
  readonly domainId?: string;
  readonly direction?: MessageDirection;
  readonly address?: string;
  readonly toAddress?: string;
  readonly recipientAddress?: string;
  readonly fromAddress?: string;
  readonly tagIds?: readonly string[];
  readonly systemSlugs?: readonly SystemTagSlug[];
  readonly includeSpam?: boolean;
  readonly unreadOnly?: boolean;
  readonly search?: string;
  readonly hasAttachment?: boolean;
  readonly attachmentKinds?: readonly AttachmentKind[];
  readonly spamOnly?: boolean;
  readonly statuses?: readonly MailStatus[];
  readonly mailingList?: boolean;
  readonly listId?: string;
}

export interface SendMessageVariables {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly inReplyToMessageId?: string;
  readonly attachmentIds?: readonly string[];
}

export type RuleField =
  | "SENDER_ADDRESS"
  | "SENDER_DOMAIN"
  | "SUBJECT"
  | "LIST_ID";
export type RuleMatcher = "EXACT" | "CONTAINS" | "REGEX";
export type RuleAction = "SPAM" | "MAILING_LIST" | "TAG";

export interface ClassificationRuleView {
  readonly id: string;
  readonly domain: { readonly id: string; readonly name: string } | null;
  readonly field: RuleField;
  readonly matcher: RuleMatcher;
  readonly pattern: string;
  readonly action: RuleAction;
  readonly tag: TagView | null;
  readonly enabled: boolean;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface MailAddressView {
  readonly id: string;
  readonly localPart: string;
  readonly address: string;
  readonly displayName: string | null;
  readonly status: MailAddressStatus;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly domain: { readonly id: string; readonly name: string };
}
