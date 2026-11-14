import type { MessageEventRepository } from "@mailcal/application/ports/message-event-repository";
import type {
  SqlDatabase,
  SqlValue,
} from "@mailcal/application/ports/sql-database";
import {
  type MessageEvent,
  MessageEventKind,
} from "@mailcal/domain/entities/message-event";
import {
  createMessageEventId,
  createMessageId,
} from "@mailcal/domain/value-objects/ids";
import {
  buildAllowedPatternsCondition,
  buildMailPermissionFilterCondition,
} from "./message-repository-queries";
import { assertEnumValue } from "./sql-helpers";

interface EventRow {
  readonly id: string;
  readonly message_id: string;
  readonly kind: string;
  readonly due_at: string | null;
  readonly title: string;
  readonly note: string | null;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToEvent(row: EventRow): MessageEvent {
  return {
    id: createMessageEventId(row.id),
    messageId: createMessageId(row.message_id),
    kind: assertEnumValue(MessageEventKind, row.kind, "event kind"),
    dueAt: row.due_at,
    title: row.title,
    note: row.note,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_SQL = `INSERT INTO message_events
  (id, message_id, kind, due_at, title, note, completed_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    due_at = excluded.due_at,
    title = excluded.title,
    note = excluded.note,
    completed_at = excluded.completed_at,
    updated_at = excluded.updated_at`;

export function createMessageEventRepository(
  db: SqlDatabase,
): MessageEventRepository {
  return {
    async findById(id) {
      const rows = await db.query<EventRow>(
        "SELECT * FROM message_events WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToEvent(rows[0]);
    },

    async save(event) {
      await db.execute(UPSERT_SQL, [
        event.id,
        event.messageId,
        event.kind,
        event.dueAt,
        event.title,
        event.note,
        event.completedAt,
        event.createdAt,
        event.updatedAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM message_events WHERE id = ?", [id]);
    },

    async listByMessages(ids) {
      if (ids.length === 0) {
        return new Map();
      }
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await db.query<EventRow>(
        `SELECT * FROM message_events
         WHERE message_id IN (${placeholders})
         ORDER BY due_at IS NULL, due_at ASC, created_at ASC`,
        [...ids],
      );
      const map = new Map<string, MessageEvent[]>();
      for (const row of rows) {
        const list = map.get(row.message_id) ?? [];
        list.push(rowToEvent(row));
        map.set(row.message_id, list);
      }
      return map;
    },

    async list(filter, limit) {
      const conditions: string[] = [];
      const params: SqlValue[] = [];

      if (filter.includeCompleted !== true) {
        conditions.push("message_events.completed_at IS NULL");
      }
      if (filter.dueBefore !== undefined) {
        conditions.push(
          "message_events.due_at IS NOT NULL AND message_events.due_at <= ?",
        );
        params.push(filter.dueBefore);
      }
      if (filter.dueAfter !== undefined) {
        conditions.push(
          "message_events.due_at IS NOT NULL AND message_events.due_at >= ?",
        );
        params.push(filter.dueAfter);
      }

      // The same scope allowlist a message listing gets, applied through
      // the owning message: an API key must not see events on mail it
      // could not read.
      const scope = buildAllowedPatternsCondition(filter.allowedPatterns);
      if (scope === "NONE") {
        return [];
      }
      if (scope !== null) {
        conditions.push(
          `EXISTS (SELECT 1 FROM messages
             WHERE messages.id = message_events.message_id AND ${scope.sql})`,
        );
        params.push(...scope.params);
      }

      // Same treatment for a USER viewer's mailbox rules, independently of
      // the allowlist above -- see `MessageListFilter.mailPermissionFilter`.
      const mailPermission = buildMailPermissionFilterCondition(
        filter.mailPermissionFilter,
      );
      if (mailPermission === "NONE") {
        return [];
      }
      if (mailPermission !== null) {
        conditions.push(
          `EXISTS (SELECT 1 FROM messages
             WHERE messages.id = message_events.message_id AND ${mailPermission.sql})`,
        );
        params.push(...mailPermission.params);
      }

      const where =
        conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
      const rows = await db.query<EventRow>(
        `SELECT message_events.* FROM message_events
         ${where}
         ORDER BY message_events.due_at IS NULL,
                  message_events.due_at ASC,
                  message_events.created_at ASC
         LIMIT ?`,
        [...params, limit],
      );
      return rows.map(rowToEvent);
    },
  };
}
