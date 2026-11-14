import type {
  InsertMessageInput,
  MessagePage,
  MessageRepository,
} from "@mailcal/application/ports/message-repository";
import type {
  SqlDatabase,
  SqlStatement,
  SqlValue,
} from "@mailcal/application/ports/sql-database";
import {
  type Attachment,
  AttachmentKind,
} from "@mailcal/domain/entities/attachment";
import {
  FetchStatus,
  type MessageFetchState,
} from "@mailcal/domain/entities/fetch-state";
import {
  DeliveryStatus,
  MailStatus,
  type Message,
  MessageDirection,
  type MessageRecipient,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { SpamMarkedBy } from "@mailcal/domain/entities/spam-mark";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createApiKeyId,
  createAttachmentId,
  createDomainId,
  createMessageId,
  createTagId,
  createThreadId,
  type MessageId,
  type TagId,
} from "@mailcal/domain/value-objects/ids";
import { buildMessageListQuery } from "./message-repository-queries";
import {
  assertEnumValue,
  boolToSql,
  buildInPlaceholders,
  encodeCursor,
  sqlToBool,
} from "./sql-helpers";

interface MessageRow {
  readonly id: string;
  readonly domain_id: string;
  readonly direction: string;
  readonly thread_id: string;
  readonly rfc_message_id: string | null;
  readonly in_reply_to: string | null;
  readonly references_json: string;
  readonly subject: string;
  readonly from_address: string;
  readonly from_name: string | null;
  readonly text_body: string | null;
  readonly html_body: string | null;
  readonly body_truncated: number;
  readonly snippet: string;
  readonly raw_key: string | null;
  readonly raw_size: number;
  readonly spam_score: number | null;
  readonly status: string;
  readonly delivery_status: string;
  readonly list_id: string | null;
  readonly is_mailing_list: number;
  readonly delivery_error: string | null;
  readonly read_at: string | null;
  readonly occurred_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface SpamRow {
  readonly message_id: string;
  readonly score: number | null;
  readonly marked_by: string;
  readonly marked_at: string;
}

const UPSERT_SPAM_SQL = `INSERT INTO message_spam
  (message_id, score, marked_by, marked_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(message_id) DO UPDATE SET
    score = excluded.score,
    marked_by = excluded.marked_by,
    marked_at = excluded.marked_at`;

interface RecipientRow {
  readonly message_id: string;
  readonly kind: string;
  readonly address: string;
  readonly name: string | null;
  readonly position: number;
}

interface AttachmentRow {
  readonly id: string;
  readonly message_id: string | null;
  readonly file_name: string;
  readonly content_type: string;
  readonly size: number;
  readonly blob_key: string;
  readonly content_id: string | null;
  readonly inline: number;
  readonly kind: string;
  readonly created_at: string;
}

interface FetchStateRow {
  readonly message_id: string;
  readonly api_key_id: string;
  readonly status: string;
  readonly fetched_at: string | null;
  readonly updated_at: string;
}

function parseReferences(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    // A corrupt column costs threading accuracy for one message, not the
    // ability to read it.
    return [];
  }
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: createMessageId(row.id),
    domainId: createDomainId(row.domain_id),
    direction: assertEnumValue(
      MessageDirection,
      row.direction,
      "message direction",
    ),
    threadId: createThreadId(row.thread_id),
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.references_json),
    subject: row.subject,
    fromAddress: createEmailAddress(row.from_address),
    fromName: row.from_name,
    textBody: row.text_body,
    htmlBody: row.html_body,
    bodyTruncated: sqlToBool(row.body_truncated),
    snippet: row.snippet,
    rawKey: row.raw_key,
    rawSize: row.raw_size,
    spamScore: row.spam_score,
    status: assertEnumValue(MailStatus, row.status, "mail status"),
    deliveryStatus: assertEnumValue(
      DeliveryStatus,
      row.delivery_status,
      "delivery status",
    ),
    listId: row.list_id,
    isMailingList: sqlToBool(row.is_mailing_list),
    deliveryError: row.delivery_error,
    readAt: row.read_at,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRecipient(row: RecipientRow): MessageRecipient {
  return {
    kind: assertEnumValue(RecipientKind, row.kind, "recipient kind"),
    address: createEmailAddress(row.address),
    name: row.name,
    position: row.position,
  };
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: createAttachmentId(row.id),
    messageId: row.message_id === null ? null : createMessageId(row.message_id),
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    blobKey: row.blob_key,
    contentId: row.content_id,
    inline: sqlToBool(row.inline),
    kind: assertEnumValue(AttachmentKind, row.kind, "attachment kind"),
    createdAt: row.created_at,
  };
}

function rowToFetchState(row: FetchStateRow): MessageFetchState {
  return {
    messageId: createMessageId(row.message_id),
    apiKeyId: createApiKeyId(row.api_key_id),
    status: assertEnumValue(FetchStatus, row.status, "fetch status"),
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_MESSAGE_SQL = `INSERT INTO messages
  (id, domain_id, direction, thread_id, rfc_message_id, in_reply_to,
   references_json, subject, from_address, from_name, text_body, html_body,
   body_truncated, snippet, raw_key, raw_size, spam_score, status,
   delivery_status, list_id, is_mailing_list,
   delivery_error, read_at, occurred_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    thread_id = excluded.thread_id,
    subject = excluded.subject,
    text_body = excluded.text_body,
    html_body = excluded.html_body,
    body_truncated = excluded.body_truncated,
    snippet = excluded.snippet,
    raw_key = excluded.raw_key,
    raw_size = excluded.raw_size,
    spam_score = excluded.spam_score,
    status = excluded.status,
    delivery_status = excluded.delivery_status,
    list_id = excluded.list_id,
    is_mailing_list = excluded.is_mailing_list,
    from_address = excluded.from_address,
    from_name = excluded.from_name,
    delivery_error = excluded.delivery_error,
    read_at = excluded.read_at,
    occurred_at = excluded.occurred_at,
    updated_at = excluded.updated_at`;

function messageParams(message: Message): readonly SqlValue[] {
  return [
    message.id,
    message.domainId,
    message.direction,
    message.threadId,
    message.rfcMessageId,
    message.inReplyTo,
    JSON.stringify(message.references),
    message.subject,
    message.fromAddress,
    message.fromName,
    message.textBody,
    message.htmlBody,
    boolToSql(message.bodyTruncated),
    message.snippet,
    message.rawKey,
    message.rawSize,
    message.spamScore,
    message.status,
    message.deliveryStatus,
    message.listId,
    boolToSql(message.isMailingList),
    message.deliveryError,
    message.readAt,
    message.occurredAt,
    message.createdAt,
    message.updatedAt,
  ];
}

function groupByMessageId<
  TRow extends { readonly message_id: string | null },
  TValue,
>(
  ids: readonly MessageId[],
  rows: readonly TRow[],
  map: (row: TRow) => TValue,
): ReadonlyMap<string, readonly TValue[]> {
  const grouped = new Map<string, TValue[]>(
    ids.map((id) => [id as string, []]),
  );
  for (const row of rows) {
    if (row.message_id === null) {
      continue;
    }
    grouped.get(row.message_id)?.push(map(row));
  }
  return grouped;
}

export function createMessageRepository(db: SqlDatabase): MessageRepository {
  async function findByIds(
    ids: readonly MessageId[],
  ): Promise<readonly Message[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await db.query<MessageRow>(
      `SELECT * FROM messages WHERE id IN (${buildInPlaceholders(ids.length)})`,
      [...ids],
    );
    // Preserve the caller's order: use cases pair results with the ids they
    // asked for, and SQL makes no ordering promise for an `IN` list.
    const byId = new Map(rows.map((row) => [row.id, rowToMessage(row)]));
    return ids
      .map((id) => byId.get(id))
      .filter((message): message is Message => message !== undefined);
  }

  return {
    async findById(id) {
      const rows = await db.query<MessageRow>(
        "SELECT * FROM messages WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToMessage(rows[0]);
    },

    findByIds,

    async findByRfcMessageId(rfcMessageId) {
      const rows = await db.query<MessageRow>(
        "SELECT * FROM messages WHERE rfc_message_id = ?",
        [rfcMessageId],
      );
      return rows[0] === undefined ? null : rowToMessage(rows[0]);
    },

    async findThreadIdByReferences(references) {
      if (references.length === 0) {
        return null;
      }
      const rows = await db.query<MessageRow>(
        `SELECT * FROM messages
         WHERE rfc_message_id IN (${buildInPlaceholders(references.length)})
         ORDER BY occurred_at DESC, id DESC
         LIMIT 1`,
        [...references],
      );
      return rows[0] === undefined ? null : createThreadId(rows[0].thread_id);
    },

    async list(filter, limit, cursor): Promise<MessagePage> {
      const query = buildMessageListQuery(filter, limit, cursor);
      const [rows, countRows] = await Promise.all([
        db.query<MessageRow>(query.rowsSql, query.rowsParams),
        db.query<{ count: number }>(query.countSql, query.countParams),
      ]);

      // One extra row was requested; its presence is what tells us a next
      // page exists, without a second count-bounded query.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        nodes: page.map(rowToMessage),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor(last.occurred_at, last.id)
            : null,
        totalCount: countRows[0]?.count ?? 0,
      };
    },

    async listByThread(threadId) {
      const rows = await db.query<MessageRow>(
        "SELECT * FROM messages WHERE thread_id = ? ORDER BY occurred_at ASC, id ASC",
        [threadId],
      );
      return rows.map(rowToMessage);
    },

    /** One atomic `batch()` covering the message row and every relation, so
     * a partial ingest can never leave a message without its recipients --
     * which would make it invisible to every scoped listing query. */
    async insertWithRelations(input: InsertMessageInput) {
      const statements: SqlStatement[] = [
        { sql: UPSERT_MESSAGE_SQL, params: messageParams(input.message) },
      ];
      for (const recipient of input.recipients) {
        statements.push({
          sql: `INSERT INTO message_recipients (message_id, kind, address, name, position)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(message_id, kind, position) DO UPDATE SET
                  address = excluded.address, name = excluded.name`,
          params: [
            input.message.id,
            recipient.kind,
            recipient.address,
            recipient.name,
            recipient.position,
          ],
        });
      }
      for (const attachment of input.attachments) {
        statements.push({
          sql: `INSERT INTO attachments
                  (id, message_id, file_name, content_type, size, blob_key,
                   content_id, inline, kind, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  message_id = excluded.message_id`,
          params: [
            attachment.id,
            attachment.messageId,
            attachment.fileName,
            attachment.contentType,
            attachment.size,
            attachment.blobKey,
            attachment.contentId,
            boolToSql(attachment.inline),
            attachment.kind,
            attachment.createdAt,
          ],
        });
      }
      for (const tagId of input.tagIds) {
        statements.push({
          sql: `INSERT INTO message_tags (message_id, tag_id, tagged_at)
                VALUES (?, ?, ?)
                ON CONFLICT(message_id, tag_id) DO NOTHING`,
          params: [input.message.id, tagId, input.taggedAt],
        });
      }
      if (input.spam !== undefined) {
        statements.push({
          sql: UPSERT_SPAM_SQL,
          params: [
            input.spam.messageId,
            input.spam.score,
            input.spam.markedBy,
            input.spam.markedAt,
          ],
        });
      }
      await db.batch(statements);
    },

    async save(message) {
      await db.execute(UPSERT_MESSAGE_SQL, messageParams(message));
    },

    async setSpamMarks(marks) {
      if (marks.length === 0) {
        return;
      }
      await db.batch(
        marks.map((mark) => ({
          sql: UPSERT_SPAM_SQL,
          params: [mark.messageId, mark.score, mark.markedBy, mark.markedAt],
        })),
      );
    },

    async clearSpamMarks(ids) {
      if (ids.length === 0) {
        return;
      }
      const placeholders = ids.map(() => "?").join(", ");
      await db.execute(
        `DELETE FROM message_spam WHERE message_id IN (${placeholders})`,
        [...ids],
      );
    },

    async listSpamMarks(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await db.query<SpamRow>(
        `SELECT * FROM message_spam WHERE message_id IN (${placeholders})`,
        [...ids],
      );
      return new Map(
        rows.map((row) => [
          row.message_id,
          {
            messageId: createMessageId(row.message_id),
            score: row.score,
            markedBy: assertEnumValue(
              SpamMarkedBy,
              row.marked_by,
              "spam marked_by",
            ),
            markedAt: row.marked_at,
          },
        ]),
      );
    },

    async replaceRecipients(messageId, recipients) {
      const statements: SqlStatement[] = [
        {
          sql: "DELETE FROM message_recipients WHERE message_id = ?",
          params: [messageId],
        },
        ...recipients.map((recipient) => ({
          sql: `INSERT INTO message_recipients (message_id, kind, address, name, position)
                VALUES (?, ?, ?, ?, ?)`,
          params: [
            messageId,
            recipient.kind,
            recipient.address,
            recipient.name,
            recipient.position,
          ] as SqlValue[],
        })),
      ];
      await db.batch(statements);
    },

    async delete(ids) {
      if (ids.length === 0) {
        return 0;
      }
      const result = await db.execute(
        `DELETE FROM messages WHERE id IN (${buildInPlaceholders(ids.length)})`,
        [...ids],
      );
      return result.rowsAffected;
    },

    async setRead(ids, readAt, updatedAt) {
      if (ids.length === 0) {
        return;
      }
      await db.execute(
        `UPDATE messages SET read_at = ?, updated_at = ?
         WHERE id IN (${buildInPlaceholders(ids.length)})`,
        [readAt, updatedAt, ...ids],
      );
    },

    async listRecipients(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const rows = await db.query<RecipientRow>(
        `SELECT * FROM message_recipients
         WHERE message_id IN (${buildInPlaceholders(ids.length)})
         ORDER BY kind ASC, position ASC`,
        [...ids],
      );
      return groupByMessageId(ids, rows, rowToRecipient);
    },

    async listAttachments(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const rows = await db.query<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE message_id IN (${buildInPlaceholders(ids.length)})
         ORDER BY created_at ASC, id ASC`,
        [...ids],
      );
      return groupByMessageId(ids, rows, rowToAttachment);
    },

    async listTagIds(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const rows = await db.query<{ message_id: string; tag_id: string }>(
        `SELECT message_id, tag_id FROM message_tags
         WHERE message_id IN (${buildInPlaceholders(ids.length)})`,
        [...ids],
      );
      return groupByMessageId(
        ids,
        rows,
        (row): TagId => createTagId(row.tag_id),
      );
    },

    async listStaleStagedAttachments(cutoff) {
      const rows = await db.query<AttachmentRow>(
        `SELECT * FROM attachments
         WHERE message_id IS NULL AND created_at < ?`,
        [cutoff],
      );
      return rows.map(rowToAttachment);
    },

    async deleteAttachments(ids) {
      if (ids.length === 0) {
        return;
      }
      const placeholders = ids.map(() => "?").join(", ");
      await db.execute(
        `DELETE FROM attachments WHERE id IN (${placeholders})`,
        [...ids],
      );
    },

    async findAttachmentById(id) {
      const rows = await db.query<AttachmentRow>(
        "SELECT * FROM attachments WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToAttachment(rows[0]);
    },

    async saveAttachment(attachment) {
      await db.execute(
        `INSERT INTO attachments
           (id, message_id, file_name, content_type, size, blob_key,
            content_id, inline, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           message_id = excluded.message_id,
           file_name = excluded.file_name,
           content_type = excluded.content_type,
           size = excluded.size,
           blob_key = excluded.blob_key,
           kind = excluded.kind`,
        [
          attachment.id,
          attachment.messageId,
          attachment.fileName,
          attachment.contentType,
          attachment.size,
          attachment.blobKey,
          attachment.contentId,
          boolToSql(attachment.inline),
          attachment.kind,
          attachment.createdAt,
        ],
      );
    },

    async addTags(messageIds, tagIds, taggedAt) {
      if (messageIds.length === 0 || tagIds.length === 0) {
        return;
      }
      await db.batch(
        messageIds.flatMap((messageId) =>
          tagIds.map((tagId) => ({
            sql: `INSERT INTO message_tags (message_id, tag_id, tagged_at)
                  VALUES (?, ?, ?)
                  ON CONFLICT(message_id, tag_id) DO NOTHING`,
            params: [messageId, tagId, taggedAt] as readonly SqlValue[],
          })),
        ),
      );
    },

    async removeTags(messageIds, tagIds) {
      if (messageIds.length === 0 || tagIds.length === 0) {
        return;
      }
      await db.execute(
        `DELETE FROM message_tags
         WHERE message_id IN (${buildInPlaceholders(messageIds.length)})
           AND tag_id IN (${buildInPlaceholders(tagIds.length)})`,
        [...messageIds, ...tagIds],
      );
    },

    async findFetchStates(apiKeyId, ids) {
      const found = new Map<string, MessageFetchState>();
      if (ids.length === 0) {
        return found;
      }
      const rows = await db.query<FetchStateRow>(
        `SELECT * FROM message_fetch_states
         WHERE api_key_id = ?
           AND message_id IN (${buildInPlaceholders(ids.length)})`,
        [apiKeyId, ...ids],
      );
      for (const row of rows) {
        found.set(row.message_id, rowToFetchState(row));
      }
      return found;
    },

    async saveFetchStates(states) {
      if (states.length === 0) {
        return;
      }
      await db.batch(
        states.map((state) => ({
          sql: `INSERT INTO message_fetch_states
                  (message_id, api_key_id, status, fetched_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(message_id, api_key_id) DO UPDATE SET
                  status = excluded.status,
                  fetched_at = excluded.fetched_at,
                  updated_at = excluded.updated_at`,
          params: [
            state.messageId,
            state.apiKeyId,
            state.status,
            state.fetchedAt,
            state.updatedAt,
          ] as readonly SqlValue[],
        })),
      );
    },
  };
}
