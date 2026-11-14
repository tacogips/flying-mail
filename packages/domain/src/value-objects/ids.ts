import { ValidationError } from "../errors";

/** Nominal-typing helper: attaches a phantom `__brand` tag to a primitive so
 * distinct entity IDs cannot be accidentally interchanged. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type DomainId = Brand<string, "DomainId">;
export type MessageId = Brand<string, "MessageId">;
export type ThreadId = Brand<string, "ThreadId">;
export type AttachmentId = Brand<string, "AttachmentId">;
export type TagId = Brand<string, "TagId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;
export type ApiKeyScopeId = Brand<string, "ApiKeyScopeId">;
export type FileLinkId = Brand<string, "FileLinkId">;
export type UserId = Brand<string, "UserId">;
export type UserMailPermissionId = Brand<string, "UserMailPermissionId">;
export type SessionId = Brand<string, "SessionId">;
export type EmailAuthChallengeId = Brand<string, "EmailAuthChallengeId">;
export type MessageEventId = Brand<string, "MessageEventId">;
export type ClassificationRuleId = Brand<string, "ClassificationRuleId">;
export type MailAddressId = Brand<string, "MailAddressId">;
export type MailTemplateId = Brand<string, "MailTemplateId">;
export type UserTemplatePermissionId = Brand<
  string,
  "UserTemplatePermissionId"
>;

// Contacts + CardDAV client (design-docs/specs/design-contacts.md) and the
// sibling external-mail-account feature, added together, alphabetically
// ordered within this block.
export type AddressBookId = Brand<string, "AddressBookId">;
export type CarddavAccountId = Brand<string, "CarddavAccountId">;
export type CarddavBookId = Brand<string, "CarddavBookId">;
export type ContactId = Brand<string, "ContactId">;
export type ExternalAccountId = Brand<string, "ExternalAccountId">;

/** Shared validation for every branded ID constructor below. IDs are always
 * caller-supplied: the domain layer never generates them, so that entity
 * factories stay pure and deterministic under test. */
function requireNonEmptyId(value: string, fieldName: string): string {
  if (value.trim().length === 0) {
    throw new ValidationError(`${fieldName} must not be empty`, fieldName);
  }
  return value;
}

export function createDomainId(value: string): DomainId {
  return requireNonEmptyId(value, "domainId") as DomainId;
}

export function createMessageId(value: string): MessageId {
  return requireNonEmptyId(value, "messageId") as MessageId;
}

export function createThreadId(value: string): ThreadId {
  return requireNonEmptyId(value, "threadId") as ThreadId;
}

export function createAttachmentId(value: string): AttachmentId {
  return requireNonEmptyId(value, "attachmentId") as AttachmentId;
}

export function createTagId(value: string): TagId {
  return requireNonEmptyId(value, "tagId") as TagId;
}

export function createApiKeyId(value: string): ApiKeyId {
  return requireNonEmptyId(value, "apiKeyId") as ApiKeyId;
}

export function createApiKeyScopeId(value: string): ApiKeyScopeId {
  return requireNonEmptyId(value, "apiKeyScopeId") as ApiKeyScopeId;
}

export function createFileLinkId(value: string): FileLinkId {
  return requireNonEmptyId(value, "fileLinkId") as FileLinkId;
}

export function createUserId(value: string): UserId {
  return requireNonEmptyId(value, "userId") as UserId;
}

export function createUserMailPermissionId(
  value: string,
): UserMailPermissionId {
  return requireNonEmptyId(
    value,
    "userMailPermissionId",
  ) as UserMailPermissionId;
}

export function createSessionId(value: string): SessionId {
  return requireNonEmptyId(value, "sessionId") as SessionId;
}

export function createEmailAuthChallengeId(
  value: string,
): EmailAuthChallengeId {
  return requireNonEmptyId(
    value,
    "emailAuthChallengeId",
  ) as EmailAuthChallengeId;
}

export function createMessageEventId(value: string): MessageEventId {
  return requireNonEmptyId(value, "messageEventId") as MessageEventId;
}

export function createClassificationRuleId(
  value: string,
): ClassificationRuleId {
  return requireNonEmptyId(
    value,
    "classificationRuleId",
  ) as ClassificationRuleId;
}

export function createMailTemplateId(value: string): MailTemplateId {
  return requireNonEmptyId(value, "mailTemplateId") as MailTemplateId;
}

export function createUserTemplatePermissionId(
  value: string,
): UserTemplatePermissionId {
  return requireNonEmptyId(
    value,
    "userTemplatePermissionId",
  ) as UserTemplatePermissionId;
}

export function createMailAddressId(value: string): MailAddressId {
  return requireNonEmptyId(value, "mailAddressId") as MailAddressId;
}

export function createAddressBookId(value: string): AddressBookId {
  return requireNonEmptyId(value, "addressBookId") as AddressBookId;
}

export function createCarddavAccountId(value: string): CarddavAccountId {
  return requireNonEmptyId(value, "carddavAccountId") as CarddavAccountId;
}

export function createCarddavBookId(value: string): CarddavBookId {
  return requireNonEmptyId(value, "carddavBookId") as CarddavBookId;
}

export function createContactId(value: string): ContactId {
  return requireNonEmptyId(value, "contactId") as ContactId;
}

export function createExternalAccountId(value: string): ExternalAccountId {
  return requireNonEmptyId(value, "externalAccountId") as ExternalAccountId;
}
