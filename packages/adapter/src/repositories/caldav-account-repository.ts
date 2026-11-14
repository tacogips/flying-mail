import type { CaldavAccountRepository } from "@mailcal/application/ports/caldav";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type {
  CaldavAccount,
  CaldavCalendarLink,
  CaldavDeletion,
  CaldavEventState,
} from "@mailcal/domain/entities/caldav-account";
import {
  createCaldavAccountId,
  createCaldavCalendarId,
  createCalendarId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { boolToSql, sqlToBool } from "./sql-helpers";

interface CaldavAccountRow {
  readonly id: string;
  readonly user_id: string;
  readonly server_url: string;
  readonly username: string;
  readonly password_ciphertext: string;
  readonly principal_url: string | null;
  readonly home_set_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CaldavCalendarRow {
  readonly id: string;
  readonly account_id: string;
  readonly calendar_id: string;
  readonly remote_url: string;
  readonly display_name: string | null;
  readonly ctag: string | null;
  readonly sync_token: string | null;
  readonly last_synced_at: string | null;
}

interface CaldavEventStateRow {
  readonly event_id: string;
  readonly caldav_calendar_id: string;
  readonly href: string;
  readonly etag: string | null;
  readonly last_synced_at: string;
  readonly remote_unsupported: number;
}

interface CaldavDeletionRow {
  readonly caldav_calendar_id: string;
  readonly href: string;
  readonly etag: string | null;
  readonly deleted_at: string;
}

function rowToAccount(row: CaldavAccountRow): CaldavAccount {
  return {
    id: createCaldavAccountId(row.id),
    userId: createUserId(row.user_id),
    serverUrl: row.server_url,
    username: row.username,
    // Ciphertext only: the plaintext app-specific password exists solely
    // inside a connect/sync call, never in a row and never in a log line.
    passwordCiphertext: row.password_ciphertext,
    principalUrl: row.principal_url,
    homeSetUrl: row.home_set_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCalendarLink(row: CaldavCalendarRow): CaldavCalendarLink {
  return {
    id: createCaldavCalendarId(row.id),
    accountId: createCaldavAccountId(row.account_id),
    calendarId: createCalendarId(row.calendar_id),
    remoteUrl: row.remote_url,
    displayName: row.display_name,
    ctag: row.ctag,
    syncToken: row.sync_token,
    lastSyncedAt: row.last_synced_at,
  };
}

function rowToEventState(row: CaldavEventStateRow): CaldavEventState {
  return {
    eventId: row.event_id,
    caldavCalendarId: createCaldavCalendarId(row.caldav_calendar_id),
    href: row.href,
    etag: row.etag,
    lastSyncedAt: row.last_synced_at,
    remoteUnsupported: sqlToBool(row.remote_unsupported),
  };
}

function rowToDeletion(row: CaldavDeletionRow): CaldavDeletion {
  return {
    caldavCalendarId: createCaldavCalendarId(row.caldav_calendar_id),
    href: row.href,
    etag: row.etag,
    deletedAt: row.deleted_at,
  };
}

const UPSERT_ACCOUNT_SQL = `INSERT INTO caldav_accounts
  (id, user_id, server_url, username, password_ciphertext,
   principal_url, home_set_url, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    server_url = excluded.server_url,
    username = excluded.username,
    password_ciphertext = excluded.password_ciphertext,
    principal_url = excluded.principal_url,
    home_set_url = excluded.home_set_url,
    updated_at = excluded.updated_at`;

const UPSERT_CALENDAR_SQL = `INSERT INTO caldav_calendars
  (id, account_id, calendar_id, remote_url, display_name, ctag, sync_token, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    account_id = excluded.account_id,
    calendar_id = excluded.calendar_id,
    remote_url = excluded.remote_url,
    display_name = excluded.display_name,
    ctag = excluded.ctag,
    sync_token = excluded.sync_token,
    last_synced_at = excluded.last_synced_at`;

const UPSERT_EVENT_STATE_SQL = `INSERT INTO caldav_event_states
  (event_id, caldav_calendar_id, href, etag, last_synced_at, remote_unsupported)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET
    caldav_calendar_id = excluded.caldav_calendar_id,
    href = excluded.href,
    etag = excluded.etag,
    last_synced_at = excluded.last_synced_at,
    remote_unsupported = excluded.remote_unsupported`;

const UPSERT_DELETION_SQL = `INSERT INTO caldav_deletions
  (caldav_calendar_id, href, etag, deleted_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(caldav_calendar_id, href) DO UPDATE SET
    etag = excluded.etag,
    deleted_at = excluded.deleted_at`;

export function createCaldavAccountRepository(
  db: SqlDatabase,
): CaldavAccountRepository {
  return {
    async findAccountById(id) {
      const rows = await db.query<CaldavAccountRow>(
        "SELECT * FROM caldav_accounts WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToAccount(rows[0]);
    },

    async listAccountsByUser(userId) {
      const rows = await db.query<CaldavAccountRow>(
        `SELECT * FROM caldav_accounts WHERE user_id = ?
         ORDER BY created_at ASC, id ASC`,
        [userId],
      );
      return rows.map(rowToAccount);
    },

    async saveAccount(account) {
      await db.execute(UPSERT_ACCOUNT_SQL, [
        account.id,
        account.userId,
        account.serverUrl,
        account.username,
        account.passwordCiphertext,
        account.principalUrl,
        account.homeSetUrl,
        account.createdAt,
        account.updatedAt,
      ]);
    },

    async deleteAccount(id) {
      // `caldav_calendars` (and through them event states and tombstones)
      // cascade; the local calendars and their events are deliberately left
      // alone -- disconnecting an account must not delete a user's data.
      await db.execute("DELETE FROM caldav_accounts WHERE id = ?", [id]);
    },

    async findCalendarLinkById(id) {
      const rows = await db.query<CaldavCalendarRow>(
        "SELECT * FROM caldav_calendars WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToCalendarLink(rows[0]);
    },

    async findCalendarLinkByCalendar(calendarId) {
      const rows = await db.query<CaldavCalendarRow>(
        "SELECT * FROM caldav_calendars WHERE calendar_id = ?",
        [calendarId],
      );
      return rows[0] === undefined ? null : rowToCalendarLink(rows[0]);
    },

    async listCalendarLinksByAccount(accountId) {
      const rows = await db.query<CaldavCalendarRow>(
        `SELECT * FROM caldav_calendars WHERE account_id = ?
         ORDER BY display_name ASC, id ASC`,
        [accountId],
      );
      return rows.map(rowToCalendarLink);
    },

    async saveCalendarLink(link) {
      await db.execute(UPSERT_CALENDAR_SQL, [
        link.id,
        link.accountId,
        link.calendarId,
        link.remoteUrl,
        link.displayName,
        link.ctag,
        link.syncToken,
        link.lastSyncedAt,
      ]);
    },

    async deleteCalendarLink(id) {
      await db.execute("DELETE FROM caldav_calendars WHERE id = ?", [id]);
    },

    async findEventState(eventId) {
      const rows = await db.query<CaldavEventStateRow>(
        "SELECT * FROM caldav_event_states WHERE event_id = ?",
        [eventId],
      );
      return rows[0] === undefined ? null : rowToEventState(rows[0]);
    },

    async findEventStateByHref(caldavCalendarId, href) {
      const rows = await db.query<CaldavEventStateRow>(
        `SELECT * FROM caldav_event_states
         WHERE caldav_calendar_id = ? AND href = ?`,
        [caldavCalendarId, href],
      );
      return rows[0] === undefined ? null : rowToEventState(rows[0]);
    },

    async listEventStates(caldavCalendarId) {
      const rows = await db.query<CaldavEventStateRow>(
        `SELECT * FROM caldav_event_states WHERE caldav_calendar_id = ?
         ORDER BY href ASC`,
        [caldavCalendarId],
      );
      return rows.map(rowToEventState);
    },

    async saveEventState(state) {
      await db.execute(UPSERT_EVENT_STATE_SQL, [
        state.eventId,
        state.caldavCalendarId,
        state.href,
        state.etag,
        state.lastSyncedAt,
        boolToSql(state.remoteUnsupported),
      ]);
    },

    async deleteEventState(eventId) {
      await db.execute("DELETE FROM caldav_event_states WHERE event_id = ?", [
        eventId,
      ]);
    },

    async addDeletion(deletion) {
      await db.execute(UPSERT_DELETION_SQL, [
        deletion.caldavCalendarId,
        deletion.href,
        deletion.etag,
        deletion.deletedAt,
      ]);
    },

    async listDeletions(caldavCalendarId) {
      const rows = await db.query<CaldavDeletionRow>(
        `SELECT * FROM caldav_deletions WHERE caldav_calendar_id = ?
         ORDER BY deleted_at ASC, href ASC`,
        [caldavCalendarId],
      );
      return rows.map(rowToDeletion);
    },

    async removeDeletion(caldavCalendarId, href) {
      await db.execute(
        "DELETE FROM caldav_deletions WHERE caldav_calendar_id = ? AND href = ?",
        [caldavCalendarId, href],
      );
    },
  };
}
