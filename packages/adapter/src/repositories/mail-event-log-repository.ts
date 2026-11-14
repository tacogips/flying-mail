import type { MailEventLog } from "@flying-mail/application/ports/mail-event-log";
import type {
  SqlDatabase,
  SqlStatement,
} from "@flying-mail/application/ports/sql-database";
import {
  MailEventType,
  normalizeEventAddresses,
  type MailEventRecord,
} from "@flying-mail/domain/entities/mail-event";
import {
  createDomainId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface MailEventRow {
  readonly seq: number;
  readonly type: string;
  readonly message_id: string;
  readonly domain_id: string;
  readonly addresses: string;
  readonly occurred_at: string;
}

interface MailEventLogStateRow {
  readonly epoch: string;
  readonly pruned_through_seq: number;
  readonly head_seq: number;
}

function parseAddresses(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "string")
    ) {
      return [];
    }
    return normalizeEventAddresses(parsed);
  } catch {
    return [];
  }
}

function rowToMailEvent(row: MailEventRow): MailEventRecord {
  return {
    seq: row.seq,
    type: assertEnumValue(MailEventType, row.type, "mail event type"),
    messageId: createMessageId(row.message_id),
    domainId: createDomainId(row.domain_id),
    addresses: parseAddresses(row.addresses),
    occurredAt: row.occurred_at,
  };
}

export function createMailEventLogRepository(db: SqlDatabase): MailEventLog {
  return {
    async append(events, timing) {
      if (events.length === 0) {
        return;
      }
      const statements: SqlStatement[] = events.map((event) => ({
        sql: `INSERT INTO mail_events
          (type, message_id, domain_id, addresses, occurred_at)
          VALUES (?, ?, ?, ?, ?)`,
        params: [
          event.type,
          event.messageId,
          event.domainId,
          JSON.stringify(normalizeEventAddresses(event.addresses)),
          timing.occurredAt,
        ],
      }));
      statements.push(
        {
          sql: `UPDATE mail_event_log_state
            SET pruned_through_seq = MAX(
              pruned_through_seq,
              COALESCE((SELECT MAX(seq) FROM mail_events WHERE occurred_at < ?), 0)
            )
            WHERE id = 1`,
          params: [timing.retentionCutoff],
        },
        {
          sql: `DELETE FROM mail_events
            WHERE seq <= (SELECT pruned_through_seq FROM mail_event_log_state WHERE id = 1)`,
        },
      );
      await db.batch(statements);
    },

    async state() {
      const rows = await db.query<MailEventLogStateRow>(
        `SELECT epoch, pruned_through_seq,
          COALESCE((SELECT MAX(seq) FROM mail_events), pruned_through_seq) AS head_seq
         FROM mail_event_log_state WHERE id = 1`,
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Mail event log state row is missing");
      }
      return {
        epoch: row.epoch,
        prunedThroughSeq: row.pruned_through_seq,
        headSeq: row.head_seq,
      };
    },

    async listAfter(seq, limit) {
      const rows = await db.query<MailEventRow>(
        `SELECT seq, type, message_id, domain_id, addresses, occurred_at
         FROM mail_events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
        [seq, limit],
      );
      return rows.map(rowToMailEvent);
    },
  };
}
