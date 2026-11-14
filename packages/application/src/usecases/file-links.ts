import { Capability } from "@mailcal/domain/entities/api-key";
import type { Attachment } from "@mailcal/domain/entities/attachment";
import { buildRawMessageBlobKey } from "@mailcal/domain/entities/attachment";
import {
  createAttachmentFileLink,
  createRawMessageFileLink,
  type FileLink,
  FileLinkTarget,
  revokeFileLink,
} from "@mailcal/domain/entities/file-link";
import {
  type AttachmentId,
  createFileLinkId,
  type FileLinkId,
  type MessageId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import {
  readableAddressPatterns,
  requireAddressCapability,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type { BlobObject } from "../ports/blob-store";
import { loadReadableEvent } from "./calendar-access";
import { loadReadableMessage } from "./messages";

const TOKEN_BYTES = 32;
export const MIN_FILE_LINK_TTL_SECONDS = 60;
export const DEFAULT_FILE_LINK_TTL_SECONDS = 3600;

export interface CreatedFileLink {
  readonly link: FileLink;
  /** Returned exactly once; only its hash is persisted. */
  readonly token: string;
  /** Absolute when `publicOrigin` is configured, else a site-relative path. */
  readonly url: string;
}

export interface FileLinkDownload {
  readonly link: FileLink;
  readonly blob: BlobObject;
  readonly fileName: string;
  readonly contentType: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function clampTtl(
  deps: AppDependencies,
  ttlSeconds: number | undefined,
): number {
  const requested = ttlSeconds ?? DEFAULT_FILE_LINK_TTL_SECONDS;
  if (!Number.isFinite(requested)) {
    return DEFAULT_FILE_LINK_TTL_SECONDS;
  }
  return Math.min(
    Math.max(Math.trunc(requested), MIN_FILE_LINK_TTL_SECONDS),
    deps.instanceConfig.fileLinkMaxTtlSeconds,
  );
}

function validateMaxDownloads(maxDownloads: number | null): void {
  if (maxDownloads === null) {
    return;
  }
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1) {
    throw new BadUserInputError(
      "maxDownloads must be a positive integer",
      "maxDownloads",
    );
  }
}

export function buildFileLinkUrl(deps: AppDependencies, token: string): string {
  const path = `/files/${token}`;
  const origin = deps.instanceConfig.publicOrigin;
  return origin === null ? path : `${origin}${path}`;
}

interface MintContext {
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly apiKeyId: FileLink["createdByApiKeyId"];
  readonly userId: FileLink["createdByUserId"];
}

async function prepareMint(
  deps: AppDependencies,
  viewer: Viewer,
  ttlSeconds: number | undefined,
  maxDownloads: number | null,
): Promise<MintContext> {
  validateMaxDownloads(maxDownloads);
  const token = toBase64Url(deps.random.tokenBytes(TOKEN_BYTES));
  const now = deps.clock.now();
  const expiresAt = new Date(
    now.getTime() + clampTtl(deps, ttlSeconds) * 1000,
  ).toISOString();
  return {
    token,
    tokenHash: await deps.tokenHasher.hash(token),
    expiresAt,
    now: now.toISOString(),
    apiKeyId: viewer.kind === "API_KEY" ? viewer.apiKeyId : null,
    userId: viewer.kind === "USER" ? viewer.userId : null,
  };
}

/** Minting requires `FILE_LINK` **and** read authorization on the owning
 * message, so a link can never reach further than its creator already
 * could. */
async function requireLinkableMessage(
  deps: AppDependencies,
  viewer: Viewer,
  messageId: MessageId,
): Promise<void> {
  const message = await loadReadableMessage(deps, viewer, messageId);
  if (message === null) {
    throw new NotFoundError("Message", messageId);
  }
  const recipients = await deps.messageRepository.listRecipients([messageId]);
  const addresses = [
    message.fromAddress,
    ...(recipients.get(messageId) ?? []).map((entry) => entry.address),
  ];
  requireAddressCapability(
    viewer,
    Capability.FileLink,
    message.domainId,
    addresses,
  );
}

/** An event attachment has no message, and therefore no address, to hang
 * the per-address `FILE_LINK` scope on. The capability is still required --
 * a key without it must not be able to mint anything -- so it is checked at
 * its coarsest form: does this viewer hold `FILE_LINK` on *any* scope. A
 * user viewer holds it unconditionally, which is the same latitude the mail
 * path gives them. */
function requireFileLinkCapability(viewer: Viewer): void {
  const patterns = readableAddressPatterns(viewer, Capability.FileLink);
  // `null` means unrestricted (a user viewer); an empty array means a key
  // that carries no `FILE_LINK` scope at all.
  if (patterns !== null && patterns.length === 0) {
    throw new ForbiddenError(
      `This credential is not permitted to perform ${Capability.FileLink} operations`,
    );
  }
}

/** Minting for an event attachment authorizes through the event that claimed
 * it, mirroring the download route's event branch: readable event plus
 * `FILE_LINK`. An attachment no event has claimed is a staged upload that
 * belongs to nothing yet, and reports as absent. */
async function requireLinkableEventAttachment(
  deps: AppDependencies,
  viewer: Viewer,
  attachmentId: AttachmentId,
): Promise<void> {
  const eventIds =
    await deps.calendarEventRepository.findEventIdsByAttachment(attachmentId);
  let readable = false;
  for (const eventId of eventIds) {
    if ((await loadReadableEvent(deps, viewer, eventId)) !== null) {
      readable = true;
      break;
    }
  }
  if (!readable) {
    throw new NotFoundError("Attachment", attachmentId);
  }
  requireFileLinkCapability(viewer);
}

export function createCreateAttachmentLinkUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  attachmentId: AttachmentId,
  ttlSeconds?: number,
  maxDownloads?: number | null,
) => Promise<CreatedFileLink> {
  return async (viewer, attachmentId, ttlSeconds, maxDownloads = null) => {
    const attachment =
      await deps.messageRepository.findAttachmentById(attachmentId);
    if (attachment === null) {
      throw new NotFoundError("Attachment", attachmentId);
    }
    if (attachment.messageId === null) {
      // Either an event attachment -- authorized through its event -- or a
      // staged upload that belongs to nothing yet, which reports as absent.
      await requireLinkableEventAttachment(deps, viewer, attachmentId);
    } else {
      await requireLinkableMessage(deps, viewer, attachment.messageId);
    }

    const context = await prepareMint(deps, viewer, ttlSeconds, maxDownloads);
    const link = createAttachmentFileLink({
      id: createFileLinkId(deps.random.uuid()),
      tokenHash: context.tokenHash,
      attachmentId,
      expiresAt: context.expiresAt,
      maxDownloads,
      createdByApiKeyId: context.apiKeyId,
      createdByUserId: context.userId,
      createdAt: context.now,
    });
    await deps.fileLinkRepository.save(link);
    return {
      link,
      token: context.token,
      url: buildFileLinkUrl(deps, context.token),
    };
  };
}

export function createCreateRawMessageLinkUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  messageId: MessageId,
  ttlSeconds?: number,
  maxDownloads?: number | null,
) => Promise<CreatedFileLink> {
  return async (viewer, messageId, ttlSeconds, maxDownloads = null) => {
    await requireLinkableMessage(deps, viewer, messageId);

    const context = await prepareMint(deps, viewer, ttlSeconds, maxDownloads);
    const link = createRawMessageFileLink({
      id: createFileLinkId(deps.random.uuid()),
      tokenHash: context.tokenHash,
      messageId,
      expiresAt: context.expiresAt,
      maxDownloads,
      createdByApiKeyId: context.apiKeyId,
      createdByUserId: context.userId,
      createdAt: context.now,
    });
    await deps.fileLinkRepository.save(link);
    return {
      link,
      token: context.token,
      url: buildFileLinkUrl(deps, context.token),
    };
  };
}

export function createRevokeFileLinkUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: FileLinkId) => Promise<boolean> {
  return async (viewer, id) => {
    const link = await deps.fileLinkRepository.findById(id);
    if (link === null) {
      throw new NotFoundError("FileLink", id);
    }
    const messageId =
      link.messageId ??
      (link.attachmentId === null
        ? null
        : ((await deps.messageRepository.findAttachmentById(link.attachmentId))
            ?.messageId ?? null));
    if (messageId === null) {
      // No owning message: revocable only when it is an event attachment
      // link and the viewer could have minted it in the first place.
      if (link.attachmentId === null) {
        throw new NotFoundError("FileLink", id);
      }
      try {
        await requireLinkableEventAttachment(deps, viewer, link.attachmentId);
      } catch (error) {
        // The link, not the attachment, is what the caller named.
        throw error instanceof NotFoundError
          ? new NotFoundError("FileLink", id)
          : error;
      }
    } else {
      await requireLinkableMessage(deps, viewer, messageId);
    }
    await deps.fileLinkRepository.save(
      revokeFileLink(link, deps.clock.now().toISOString()),
    );
    return true;
  };
}

export function createListFileLinksUseCase(
  deps: AppDependencies,
): (viewer: Viewer, messageId: MessageId) => Promise<readonly FileLink[]> {
  return async (viewer, messageId) => {
    const message = await loadReadableMessage(deps, viewer, messageId);
    if (message === null) {
      return [];
    }
    return deps.fileLinkRepository.listByMessage(messageId);
  };
}

async function resolveAttachmentDownload(
  deps: AppDependencies,
  link: FileLink,
): Promise<FileLinkDownload | null> {
  if (link.attachmentId === null) {
    return null;
  }
  const attachment: Attachment | null =
    await deps.messageRepository.findAttachmentById(link.attachmentId);
  if (attachment === null) {
    return null;
  }
  const blob = await deps.blobs.get(attachment.blobKey);
  if (blob === null) {
    return null;
  }
  return {
    link,
    blob,
    fileName: attachment.fileName,
    contentType: blob.contentType ?? attachment.contentType,
  };
}

async function resolveRawDownload(
  deps: AppDependencies,
  link: FileLink,
): Promise<FileLinkDownload | null> {
  if (link.messageId === null) {
    return null;
  }
  const message = await deps.messageRepository.findById(link.messageId);
  if (message === null) {
    return null;
  }
  const key = message.rawKey ?? buildRawMessageBlobKey(message.id);
  const blob = await deps.blobs.get(key);
  if (blob === null) {
    return null;
  }
  return {
    link,
    blob,
    fileName: `${message.id}.eml`,
    contentType: "message/rfc822",
  };
}

/** Resolves a presented file-link token to a download.
 *
 * Unauthenticated by design: the token *is* the credential, so this never
 * consults a viewer. Every failure mode -- unknown token, expired, revoked,
 * exhausted, missing blob, or an unexpected repository error -- returns
 * `null`, so the HTTP route can answer one uniform 404 and a caller cannot
 * distinguish "wrong token" from "no such link". */
export function createResolveFileLinkUseCase(
  deps: AppDependencies,
): (token: string) => Promise<FileLinkDownload | null> {
  return async (token) => {
    try {
      if (token.length === 0) {
        return null;
      }
      const tokenHash = await deps.tokenHasher.hash(token);
      const now = deps.clock.now().toISOString();
      // One atomic conditional UPDATE covers lookup, the usability check
      // and the counter increment. Counting *before* streaming means a
      // client that aborts mid-transfer still consumes its allowance
      // (otherwise an exhausted link could be replayed by cancelling), and
      // doing it atomically means two racing downloads cannot both slip
      // through a one-download link.
      const consumed = await deps.fileLinkRepository.consumeByTokenHash(
        tokenHash,
        now,
      );
      if (consumed === null) {
        return null;
      }

      return consumed.target === FileLinkTarget.Attachment
        ? await resolveAttachmentDownload(deps, consumed)
        : await resolveRawDownload(deps, consumed);
    } catch {
      return null;
    }
  };
}

/** Opportunistic cleanup, run off the request's critical path. */
export function createSweepExpiredFileLinksUseCase(
  deps: AppDependencies,
): () => Promise<number> {
  return () =>
    deps.fileLinkRepository.deleteExpired(deps.clock.now().toISOString());
}
