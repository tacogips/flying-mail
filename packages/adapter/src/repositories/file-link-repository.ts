import type { FileLinkRepository } from "@mailcal/application/ports/file-link-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type FileLink,
  FileLinkTarget,
} from "@mailcal/domain/entities/file-link";
import {
  createApiKeyId,
  createAttachmentId,
  createFileLinkId,
  createMessageId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface FileLinkRow {
  readonly id: string;
  readonly token_hash: string;
  readonly target: string;
  readonly attachment_id: string | null;
  readonly message_id: string | null;
  readonly expires_at: string;
  readonly max_downloads: number | null;
  readonly download_count: number;
  readonly created_by_api_key_id: string | null;
  readonly created_by_user_id: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

function rowToFileLink(row: FileLinkRow): FileLink {
  return {
    id: createFileLinkId(row.id),
    tokenHash: row.token_hash,
    target: assertEnumValue(FileLinkTarget, row.target, "file link target"),
    attachmentId:
      row.attachment_id === null ? null : createAttachmentId(row.attachment_id),
    messageId: row.message_id === null ? null : createMessageId(row.message_id),
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    createdByApiKeyId:
      row.created_by_api_key_id === null
        ? null
        : createApiKeyId(row.created_by_api_key_id),
    createdByUserId:
      row.created_by_user_id === null
        ? null
        : createUserId(row.created_by_user_id),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

const UPSERT_SQL = `INSERT INTO file_links
  (id, token_hash, target, attachment_id, message_id, expires_at,
   max_downloads, download_count, created_by_api_key_id, created_by_user_id,
   created_at, revoked_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    download_count = excluded.download_count,
    revoked_at = excluded.revoked_at`;

export function createFileLinkRepository(db: SqlDatabase): FileLinkRepository {
  return {
    async findById(id) {
      const rows = await db.query<FileLinkRow>(
        "SELECT * FROM file_links WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToFileLink(rows[0]);
    },

    async findByTokenHash(tokenHash) {
      const rows = await db.query<FileLinkRow>(
        "SELECT * FROM file_links WHERE token_hash = ?",
        [tokenHash],
      );
      return rows[0] === undefined ? null : rowToFileLink(rows[0]);
    },

    async consumeByTokenHash(tokenHash, now) {
      // The WHERE clause carries every usability condition, so the
      // increment and the check are one atomic statement: of N racing
      // requests against a link with one download left, exactly one sees
      // rowsAffected = 1.
      const result = await db.execute(
        `UPDATE file_links
         SET download_count = download_count + 1
         WHERE token_hash = ?
           AND revoked_at IS NULL
           AND expires_at > ?
           AND (max_downloads IS NULL OR download_count < max_downloads)`,
        [tokenHash, now],
      );
      if (result.rowsAffected === 0) {
        return null;
      }
      const rows = await db.query<FileLinkRow>(
        "SELECT * FROM file_links WHERE token_hash = ?",
        [tokenHash],
      );
      return rows[0] === undefined ? null : rowToFileLink(rows[0]);
    },

    /** Includes links whose target is an attachment *of* this message, so a
     * message view can show every link that reaches any part of it. */
    async listByMessage(messageId) {
      const rows = await db.query<FileLinkRow>(
        `SELECT file_links.* FROM file_links
         LEFT JOIN attachments ON attachments.id = file_links.attachment_id
         WHERE file_links.message_id = ? OR attachments.message_id = ?
         ORDER BY file_links.created_at DESC`,
        [messageId, messageId],
      );
      return rows.map(rowToFileLink);
    },

    async save(link) {
      await db.execute(UPSERT_SQL, [
        link.id,
        link.tokenHash,
        link.target,
        link.attachmentId,
        link.messageId,
        link.expiresAt,
        link.maxDownloads,
        link.downloadCount,
        link.createdByApiKeyId,
        link.createdByUserId,
        link.createdAt,
        link.revokedAt,
      ]);
    },

    async deleteExpired(now) {
      const result = await db.execute(
        "DELETE FROM file_links WHERE expires_at <= ?",
        [now],
      );
      return result.rowsAffected;
    },
  };
}
