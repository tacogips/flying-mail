import { InvalidStateTransitionError, ValidationError } from "../errors";
import type {
  ApiKeyId,
  AttachmentId,
  FileLinkId,
  MessageId,
  UserId,
} from "../value-objects/ids";

export enum FileLinkTarget {
  Attachment = "ATTACHMENT",
  RawMessage = "RAW_MESSAGE",
}

/** A short-lived bearer capability URL over one stored object. It exists so
 * an agent can hand a plain HTTPS link to a tool, a person, or another
 * service without also handing over its API key -- and so that link stops
 * working shortly afterwards.
 *
 * Only the token's SHA-256 hash is stored, so reading this row never yields
 * a working URL. */
export interface FileLink {
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

interface CommonFileLinkInput {
  readonly id: FileLinkId;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly maxDownloads: number | null;
  readonly createdByApiKeyId: ApiKeyId | null;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
}

export interface CreateAttachmentLinkInput extends CommonFileLinkInput {
  readonly attachmentId: AttachmentId;
}

export interface CreateRawMessageLinkInput extends CommonFileLinkInput {
  readonly messageId: MessageId;
}

function assertMaxDownloads(maxDownloads: number | null): void {
  if (maxDownloads === null) {
    return;
  }
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1) {
    throw new ValidationError(
      "maxDownloads must be a positive integer when set",
      "maxDownloads",
    );
  }
}

function assertExpiry(expiresAt: string, createdAt: string): void {
  if (expiresAt <= createdAt) {
    throw new ValidationError("expiresAt must be after createdAt", "expiresAt");
  }
}

export function createAttachmentFileLink(
  input: CreateAttachmentLinkInput,
): FileLink {
  assertMaxDownloads(input.maxDownloads);
  assertExpiry(input.expiresAt, input.createdAt);
  return {
    id: input.id,
    tokenHash: input.tokenHash,
    target: FileLinkTarget.Attachment,
    attachmentId: input.attachmentId,
    messageId: null,
    expiresAt: input.expiresAt,
    maxDownloads: input.maxDownloads,
    downloadCount: 0,
    createdByApiKeyId: input.createdByApiKeyId,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
    revokedAt: null,
  };
}

export function createRawMessageFileLink(
  input: CreateRawMessageLinkInput,
): FileLink {
  assertMaxDownloads(input.maxDownloads);
  assertExpiry(input.expiresAt, input.createdAt);
  return {
    id: input.id,
    tokenHash: input.tokenHash,
    target: FileLinkTarget.RawMessage,
    attachmentId: null,
    messageId: input.messageId,
    expiresAt: input.expiresAt,
    maxDownloads: input.maxDownloads,
    downloadCount: 0,
    createdByApiKeyId: input.createdByApiKeyId,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
    revokedAt: null,
  };
}

export function isFileLinkUsable(link: FileLink, now: string): boolean {
  if (link.revokedAt !== null) {
    return false;
  }
  if (link.expiresAt <= now) {
    return false;
  }
  return link.maxDownloads === null || link.downloadCount < link.maxDownloads;
}

/** Records one download. The caller persists the result *before* streaming
 * bytes, so a client that disconnects mid-transfer still consumes its
 * allowance -- the alternative would let an attacker replay an exhausted
 * link indefinitely by aborting each request. */
export function consumeFileLink(link: FileLink, now: string): FileLink {
  if (!isFileLinkUsable(link, now)) {
    throw new InvalidStateTransitionError(
      "File link is expired, revoked or exhausted",
      "USABLE",
      "CONSUMED",
    );
  }
  return { ...link, downloadCount: link.downloadCount + 1 };
}

export function revokeFileLink(link: FileLink, at: string): FileLink {
  return link.revokedAt === null ? { ...link, revokedAt: at } : link;
}
