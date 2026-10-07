import type { ExternalMessageStateRepository } from "@flying-mail/application/ports/external-mail";
import type {
  SqlDatabase,
  SqlStatement,
} from "@flying-mail/application/ports/sql-database";
import type { ExternalMessageState } from "@flying-mail/domain/entities/external-message-state";
import {
  createExternalAccountId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";

interface ExternalMessageStateRow {
  readonly account_id: string;
  readonly remote_id: string;
  readonly message_id: string;
  readonly fetched_at: string;
}

function rowToExternalMessageState(
  row: ExternalMessageStateRow,
): ExternalMessageState {
  return {
    accountId: createExternalAccountId(row.account_id),
    remoteId: row.remote_id,
    messageId: createMessageId(row.message_id),
    fetchedAt: row.fetched_at,
  };
}

const UPSERT_SQL = `INSERT INTO external_message_states
  (account_id, remote_id, message_id, fetched_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(account_id, remote_id) DO UPDATE SET
    message_id = excluded.message_id,
    fetched_at = excluded.fetched_at`;

/** The one place the upsert statement is built, so `save()` and
 * `buildSaveStatement()` can never drift apart. */
function saveStatement(state: ExternalMessageState): SqlStatement {
  return {
    sql: UPSERT_SQL,
    params: [state.accountId, state.remoteId, state.messageId, state.fetchedAt],
  };
}

export function createExternalMessageStateRepository(
  db: SqlDatabase,
): ExternalMessageStateRepository {
  return {
    async find(accountId, remoteId) {
      const rows = await db.query<ExternalMessageStateRow>(
        `SELECT * FROM external_message_states
         WHERE account_id = ? AND remote_id = ?`,
        [accountId, remoteId],
      );
      return rows[0] === undefined ? null : rowToExternalMessageState(rows[0]);
    },

    async listRemoteIds(accountId) {
      const rows = await db.query<{ remote_id: string }>(
        "SELECT remote_id FROM external_message_states WHERE account_id = ?",
        [accountId],
      );
      return new Set(rows.map((row) => row.remote_id));
    },

    async save(state) {
      const statement = saveStatement(state);
      await db.execute(statement.sql, statement.params);
    },

    buildSaveStatement: saveStatement,
  };
}
