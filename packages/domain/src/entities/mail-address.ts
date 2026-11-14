import { ValidationError } from "../errors";
import type { DomainName } from "../value-objects/domain-name";
import {
  createEmailAddress,
  type EmailAddress,
} from "../value-objects/email-address";
import type { DomainId, MailAddressId, UserId } from "../value-objects/ids";

/** Whether a provisioned mailbox currently accepts mail.
 *
 * `DISABLED` is not the same as deleting the row: a disabled address keeps
 * its history and its permission grants, and starts accepting again the
 * moment it is re-enabled. It also rejects **even on a catch-all domain**,
 * which is the only way to close one address on an otherwise open domain. */
export enum MailAddressStatus {
  Active = "ACTIVE",
  Disabled = "DISABLED",
}

/** An explicitly provisioned mailbox on a managed domain.
 *
 * Before this existed, a domain was either catch-all or accepted only local
 * parts it could infer from message history -- so a mailbox could not be
 * created ahead of its first message, listed, or closed. An explicit row
 * makes the set of real addresses a fact the operator states rather than a
 * side effect of traffic. */
export interface MailAddress {
  readonly id: MailAddressId;
  readonly domainId: DomainId;
  /** Normalized to lower case; unique per domain. */
  readonly localPart: string;
  /** `localPart@domain`, denormalized so ingest can match on one column. */
  readonly address: EmailAddress;
  /** Human label for pickers, e.g. "Support desk". */
  readonly displayName: string | null;
  readonly status: MailAddressStatus;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMailAddressInput {
  readonly id: MailAddressId;
  readonly domainId: DomainId;
  readonly domainName: DomainName;
  readonly localPart: string;
  readonly displayName?: string | null;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
}

export const MAX_LOCAL_PART_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 128;

/** The local-part grammar mailcal accepts when *minting* an address.
 *
 * Deliberately narrower than what `EmailAddress` will parse on the inbound
 * path: mail from the outside world may carry exotic-but-legal local parts
 * and must still be delivered, whereas an address an operator creates here
 * should be one every mail client, DNS panel and support agent can handle
 * without quoting. Leading, trailing and doubled dots are rejected for the
 * same reason. */
const LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/;

function normalizeLocalPart(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    throw new ValidationError("local part must not be empty", "localPart");
  }
  if (value.length > MAX_LOCAL_PART_LENGTH) {
    throw new ValidationError(
      `local part must be at most ${MAX_LOCAL_PART_LENGTH} characters`,
      "localPart",
    );
  }
  if (value.includes("..")) {
    throw new ValidationError(
      "local part must not contain consecutive dots",
      "localPart",
    );
  }
  if (!LOCAL_PART_PATTERN.test(value)) {
    throw new ValidationError(
      `"${raw}" is not a valid local part: use letters, digits, and . _ + - starting and ending with a letter or digit`,
      "localPart",
    );
  }
  return value;
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ValidationError(
      `display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
      "displayName",
    );
  }
  return trimmed;
}

export function createMailAddress(input: CreateMailAddressInput): MailAddress {
  const localPart = normalizeLocalPart(input.localPart);
  return {
    id: input.id,
    domainId: input.domainId,
    localPart,
    // Round-tripped through the value object so a local part that passes the
    // mint grammar but somehow fails full address validation (an overlong
    // domain, say) is caught here rather than at send time.
    address: createEmailAddress(`${localPart}@${input.domainName}`, "address"),
    displayName: normalizeDisplayName(input.displayName),
    status: MailAddressStatus.Active,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** Renames the label only. The local part is immutable: changing it would
 * silently redirect mail already addressed to the old one, and the honest
 * way to express that is a new address plus a disabled old one. */
export function renameMailAddress(
  address: MailAddress,
  displayName: string | null,
  now: string,
): MailAddress {
  return {
    ...address,
    displayName: normalizeDisplayName(displayName),
    updatedAt: now,
  };
}

export function setMailAddressStatus(
  address: MailAddress,
  status: MailAddressStatus,
  now: string,
): MailAddress {
  return address.status === status
    ? address
    : { ...address, status, updatedAt: now };
}

export function isMailAddressActive(address: MailAddress): boolean {
  return address.status === MailAddressStatus.Active;
}
