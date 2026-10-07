import type { Message } from "@flying-mail/domain/entities/message";
import type { SqlValue } from "@flying-mail/application/ports/sql-database";

export const FIND_INBOUND_BY_RFC_MESSAGE_ID_SQL = `SELECT * FROM messages
  WHERE direction = 'INBOUND' AND domain_id = ? AND rfc_message_id = ?
  ORDER BY created_at ASC LIMIT 1`;

export const ADD_ENVELOPE_RECIPIENT_SQL = `INSERT INTO message_recipients
  (message_id, kind, address, name, position)
  SELECT ?, 'ENVELOPE', ?, NULL,
    COALESCE((SELECT MAX(position) + 1 FROM message_recipients
      WHERE message_id = ? AND kind = 'ENVELOPE'), 0)
  WHERE NOT EXISTS (
    SELECT 1 FROM message_recipients
    WHERE message_id = ? AND kind = 'ENVELOPE' AND address = ?
  )`;

export const SAVE_IF_DRAFT_SQL = `UPDATE messages SET
  domain_id = ?, thread_id = ?, rfc_message_id = ?, in_reply_to = ?,
  references_json = ?, reply_to = ?, forwarded_from_message_id = ?,
  subject = ?, from_address = ?, from_name = ?, text_body = ?, html_body = ?,
  body_truncated = ?, snippet = ?, raw_key = ?, raw_size = ?, spam_score = ?,
  status = ?, delivery_status = ?, list_id = ?, is_mailing_list = ?,
  delivery_error = ?, read_at = ?, occurred_at = ?, updated_at = ?
  WHERE id = ? AND status = 'DRAFT'`;

export function saveIfDraftParams(message: Message): readonly SqlValue[] {
  return [
    message.domainId,
    message.threadId,
    message.rfcMessageId,
    message.inReplyTo,
    JSON.stringify(message.references),
    message.replyTo,
    message.forwardedFromMessageId,
    message.subject,
    message.fromAddress,
    message.fromName,
    message.textBody,
    message.htmlBody,
    Number(message.bodyTruncated),
    message.snippet,
    message.rawKey,
    message.rawSize,
    message.spamScore,
    message.status,
    message.deliveryStatus,
    message.listId,
    Number(message.isMailingList),
    message.deliveryError,
    message.readAt,
    message.occurredAt,
    message.updatedAt,
    message.id,
  ];
}

export function buildCountAttachmentsByBlobKeysSql(keyCount: number): string {
  return `SELECT blob_key, COUNT(*) AS count FROM attachments
    WHERE blob_key IN (${Array.from({ length: keyCount }, () => "?").join(", ")})
    GROUP BY blob_key`;
}
