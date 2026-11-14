import { ValidationError } from "../errors";
import type { AttachmentId, MessageId } from "../value-objects/ids";

/** Coarse file-type classification, decided **once at receive time** and
 * stored on the row -- so listing queries filter on an indexed column
 * instead of re-deriving a type from `content_type` strings, and so the
 * classification of an already-stored message can never silently change
 * when the rules evolve. */
export enum AttachmentKind {
  Image = "IMAGE",
  Video = "VIDEO",
  Audio = "AUDIO",
  Pdf = "PDF",
  Document = "DOCUMENT",
  Spreadsheet = "SPREADSHEET",
  Presentation = "PRESENTATION",
  Archive = "ARCHIVE",
  Text = "TEXT",
  Calendar = "CALENDAR",
  Other = "OTHER",
}

/** Exact content types that a top-level-type prefix match would get wrong
 * or miss. Checked before the prefix rules. */
const CONTENT_TYPE_KINDS: ReadonlyMap<string, AttachmentKind> = new Map([
  ["application/pdf", AttachmentKind.Pdf],
  ["application/msword", AttachmentKind.Document],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    AttachmentKind.Document,
  ],
  ["application/vnd.oasis.opendocument.text", AttachmentKind.Document],
  ["application/rtf", AttachmentKind.Document],
  ["application/vnd.ms-excel", AttachmentKind.Spreadsheet],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    AttachmentKind.Spreadsheet,
  ],
  [
    "application/vnd.oasis.opendocument.spreadsheet",
    AttachmentKind.Spreadsheet,
  ],
  ["text/csv", AttachmentKind.Spreadsheet],
  ["application/vnd.ms-powerpoint", AttachmentKind.Presentation],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    AttachmentKind.Presentation,
  ],
  [
    "application/vnd.oasis.opendocument.presentation",
    AttachmentKind.Presentation,
  ],
  ["application/zip", AttachmentKind.Archive],
  ["application/x-7z-compressed", AttachmentKind.Archive],
  ["application/x-rar-compressed", AttachmentKind.Archive],
  ["application/vnd.rar", AttachmentKind.Archive],
  ["application/gzip", AttachmentKind.Archive],
  ["application/x-tar", AttachmentKind.Archive],
  ["text/calendar", AttachmentKind.Calendar],
]);

/** Extension fallbacks for the depressingly common case where a sender
 * labels everything `application/octet-stream`. */
const EXTENSION_KINDS: ReadonlyMap<string, AttachmentKind> = new Map([
  ["png", AttachmentKind.Image],
  ["jpg", AttachmentKind.Image],
  ["jpeg", AttachmentKind.Image],
  ["gif", AttachmentKind.Image],
  ["webp", AttachmentKind.Image],
  ["heic", AttachmentKind.Image],
  ["svg", AttachmentKind.Image],
  ["bmp", AttachmentKind.Image],
  ["mp4", AttachmentKind.Video],
  ["mov", AttachmentKind.Video],
  ["webm", AttachmentKind.Video],
  ["mkv", AttachmentKind.Video],
  ["mp3", AttachmentKind.Audio],
  ["wav", AttachmentKind.Audio],
  ["m4a", AttachmentKind.Audio],
  ["flac", AttachmentKind.Audio],
  ["ogg", AttachmentKind.Audio],
  ["pdf", AttachmentKind.Pdf],
  ["doc", AttachmentKind.Document],
  ["docx", AttachmentKind.Document],
  ["odt", AttachmentKind.Document],
  ["rtf", AttachmentKind.Document],
  ["xls", AttachmentKind.Spreadsheet],
  ["xlsx", AttachmentKind.Spreadsheet],
  ["ods", AttachmentKind.Spreadsheet],
  ["csv", AttachmentKind.Spreadsheet],
  ["tsv", AttachmentKind.Spreadsheet],
  ["ppt", AttachmentKind.Presentation],
  ["pptx", AttachmentKind.Presentation],
  ["odp", AttachmentKind.Presentation],
  ["zip", AttachmentKind.Archive],
  ["7z", AttachmentKind.Archive],
  ["rar", AttachmentKind.Archive],
  ["gz", AttachmentKind.Archive],
  ["tar", AttachmentKind.Archive],
  ["txt", AttachmentKind.Text],
  ["md", AttachmentKind.Text],
  ["log", AttachmentKind.Text],
  ["json", AttachmentKind.Text],
  ["xml", AttachmentKind.Text],
  ["ics", AttachmentKind.Calendar],
]);

/** Classifies an attachment from its declared content type, falling back to
 * the file extension when the type is generic or absent.
 *
 * The content type is attacker-supplied and unverified -- this drives
 * *search grouping only*, never a security decision. The download-side
 * protections (`nosniff`, `CSP: sandbox`, the inline allowlist) are what
 * guard against a mislabeled file, and they judge the stored content type
 * independently of this classification. */
export function classifyAttachmentKind(
  contentType: string,
  fileName: string | null,
): AttachmentKind {
  const baseType = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  const exact = CONTENT_TYPE_KINDS.get(baseType);
  if (exact !== undefined) {
    return exact;
  }
  if (baseType.startsWith("image/")) {
    return AttachmentKind.Image;
  }
  if (baseType.startsWith("video/")) {
    return AttachmentKind.Video;
  }
  if (baseType.startsWith("audio/")) {
    return AttachmentKind.Audio;
  }

  // Generic or unknown type: try the extension before conceding.
  if (fileName !== null) {
    const dot = fileName.lastIndexOf(".");
    if (dot !== -1 && dot < fileName.length - 1) {
      const byExtension = EXTENSION_KINDS.get(
        fileName.slice(dot + 1).toLowerCase(),
      );
      if (byExtension !== undefined) {
        return byExtension;
      }
    }
  }

  // `text/*` after the extension check, so `report.csv` served as
  // `text/plain` still lands in SPREADSHEET rather than the vaguer TEXT.
  if (baseType.startsWith("text/")) {
    return AttachmentKind.Text;
  }
  return AttachmentKind.Other;
}

export interface Attachment {
  readonly id: AttachmentId;
  /** `null` for a staged upload that has not yet been sent as part of a
   * message. `attachToMessage` sets it when the message is created. */
  readonly messageId: MessageId | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly blobKey: string;
  /** RFC 2392 `Content-ID`, without the angle brackets, for `cid:`
   * references from an HTML body. */
  readonly contentId: string | null;
  readonly inline: boolean;
  /** See {@link AttachmentKind}: fixed at receive time. */
  readonly kind: AttachmentKind;
  readonly createdAt: string;
}

export interface CreateAttachmentInput {
  readonly id: AttachmentId;
  readonly messageId: MessageId | null;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly blobKey: string;
  readonly contentId: string | null;
  readonly inline: boolean;
  /** Omitted: derived from `contentType` and `fileName` by the factory. */
  readonly kind?: AttachmentKind;
  readonly createdAt: string;
}

const MAX_FILE_NAME_LENGTH = 255;
const DEFAULT_FILE_NAME = "attachment";
// Control characters plus the Windows-reserved set. Path separators are
// handled separately (see `sanitizeFileName`), and mail attachment names are
// attacker-supplied: this value ends up both in an object-store key and in a
// `Content-Disposition` header.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_FILE_NAME_CHARS = /[\x00-\x1f\x7f:*?"<>|]/g;
const PATH_SEPARATORS = /[/\\]/;

/** Reduces an arbitrary attachment file name to a safe basename, usable both
 * as part of an object-store key and as a `Content-Disposition` filename.
 *
 * A sender controls this string completely, so the first step is to keep
 * only the last path segment: that removes every traversal (`../../etc/passwd`
 * becomes `passwd`) without leaving mangled `_._` residue behind, which a
 * character-substitution-only approach does. Never returns an empty string,
 * a path separator, or a leading dot. */
export function sanitizeFileName(fileName: string): string {
  const segments = fileName.split(PATH_SEPARATORS);
  const baseName = segments[segments.length - 1] ?? "";
  const withoutUnsafeChars = baseName.replace(UNSAFE_FILE_NAME_CHARS, "_");
  // Collapse runs of dots so no `..` segment can survive into a key, and so
  // a name of only dots reduces to the default rather than to a bare dot.
  const collapsed = withoutUnsafeChars.replace(/\.{2,}/g, ".");
  const trimmed = collapsed.trim().replace(/^\.+/, "");
  if (trimmed.length === 0) {
    return DEFAULT_FILE_NAME;
  }
  return trimmed.length > MAX_FILE_NAME_LENGTH
    ? trimmed.slice(0, MAX_FILE_NAME_LENGTH)
    : trimmed;
}

/** Object-store key for an attachment body. Derived from the
 * application-generated id, so a retried ingest overwrites in place rather
 * than accumulating duplicates. */
export function buildAttachmentBlobKey(
  id: AttachmentId,
  fileName: string,
): string {
  return `att/${id}/${sanitizeFileName(fileName)}`;
}

/** Object-store key for a message's full RFC 5322 source. */
export function buildRawMessageBlobKey(id: MessageId): string {
  return `raw/${id}.eml`;
}

/** Binds a staged upload to the message that is carrying it. */
export function attachToMessage(
  attachment: Attachment,
  messageId: MessageId,
): Attachment {
  return { ...attachment, messageId };
}

/** True for an upload that has not yet been sent as part of a message. */
export function isStagedAttachment(attachment: Attachment): boolean {
  return attachment.messageId === null;
}

export function createAttachment(input: CreateAttachmentInput): Attachment {
  if (!Number.isFinite(input.size) || input.size < 0) {
    throw new ValidationError(
      "attachment size must be a non-negative finite number",
      "size",
    );
  }
  if (input.contentType.trim().length === 0) {
    throw new ValidationError(
      "attachment contentType must not be empty",
      "contentType",
    );
  }
  return {
    id: input.id,
    messageId: input.messageId,
    fileName: sanitizeFileName(input.fileName),
    contentType: input.contentType,
    size: input.size,
    blobKey: input.blobKey,
    contentId: input.contentId,
    inline: input.inline,
    kind:
      input.kind ?? classifyAttachmentKind(input.contentType, input.fileName),
    createdAt: input.createdAt,
  };
}
