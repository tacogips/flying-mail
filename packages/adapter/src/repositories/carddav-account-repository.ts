import type { CarddavAccountRepository } from "@flying-mail/application/ports/carddav";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import type {
  CarddavAccount,
  CarddavBookLink,
  CarddavContactState,
  CarddavDeletion,
} from "@flying-mail/domain/entities/carddav-account";
import {
  createAddressBookId,
  createCarddavAccountId,
  createCarddavBookId,
  createContactId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { boolToSql, sqlToBool } from "./sql-helpers";

interface CarddavAccountRow {
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

interface CarddavBookLinkRow {
  readonly id: string;
  readonly account_id: string;
  readonly address_book_id: string;
  readonly remote_url: string;
  readonly display_name: string | null;
  readonly ctag: string | null;
  readonly sync_token: string | null;
  readonly last_synced_at: string | null;
}

interface CarddavContactStateRow {
  readonly contact_id: string;
  readonly carddav_book_id: string;
  readonly href: string;
  readonly etag: string | null;
  readonly last_synced_at: string;
  readonly remote_unsupported: number;
}

interface CarddavDeletionRow {
  readonly carddav_book_id: string;
  readonly href: string;
  readonly etag: string | null;
  readonly deleted_at: string;
}

function rowToAccount(row: CarddavAccountRow): CarddavAccount {
  return {
    id: createCarddavAccountId(row.id),
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

function rowToBookLink(row: CarddavBookLinkRow): CarddavBookLink {
  return {
    id: createCarddavBookId(row.id),
    accountId: createCarddavAccountId(row.account_id),
    addressBookId: createAddressBookId(row.address_book_id),
    remoteUrl: row.remote_url,
    displayName: row.display_name,
    ctag: row.ctag,
    syncToken: row.sync_token,
    lastSyncedAt: row.last_synced_at,
  };
}

function rowToContactState(row: CarddavContactStateRow): CarddavContactState {
  return {
    contactId: createContactId(row.contact_id),
    carddavBookId: createCarddavBookId(row.carddav_book_id),
    href: row.href,
    etag: row.etag,
    lastSyncedAt: row.last_synced_at,
    remoteUnsupported: sqlToBool(row.remote_unsupported),
  };
}

function rowToDeletion(row: CarddavDeletionRow): CarddavDeletion {
  return {
    carddavBookId: createCarddavBookId(row.carddav_book_id),
    href: row.href,
    etag: row.etag,
    deletedAt: row.deleted_at,
  };
}

const UPSERT_ACCOUNT_SQL = `INSERT INTO carddav_accounts
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

const UPSERT_BOOK_LINK_SQL = `INSERT INTO carddav_book_links
  (id, account_id, address_book_id, remote_url, display_name, ctag, sync_token, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    account_id = excluded.account_id,
    address_book_id = excluded.address_book_id,
    remote_url = excluded.remote_url,
    display_name = excluded.display_name,
    ctag = excluded.ctag,
    sync_token = excluded.sync_token,
    last_synced_at = excluded.last_synced_at`;

const UPSERT_CONTACT_STATE_SQL = `INSERT INTO carddav_contact_states
  (contact_id, carddav_book_id, href, etag, last_synced_at, remote_unsupported)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(contact_id) DO UPDATE SET
    carddav_book_id = excluded.carddav_book_id,
    href = excluded.href,
    etag = excluded.etag,
    last_synced_at = excluded.last_synced_at,
    remote_unsupported = excluded.remote_unsupported`;

const UPSERT_DELETION_SQL = `INSERT INTO carddav_deletions
  (carddav_book_id, href, etag, deleted_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(carddav_book_id, href) DO UPDATE SET
    etag = excluded.etag,
    deleted_at = excluded.deleted_at`;

export function createCarddavAccountRepository(
  db: SqlDatabase,
): CarddavAccountRepository {
  return {
    async findAccountById(id) {
      const rows = await db.query<CarddavAccountRow>(
        "SELECT * FROM carddav_accounts WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToAccount(rows[0]);
    },

    async listAccountsByUser(userId) {
      const rows = await db.query<CarddavAccountRow>(
        `SELECT * FROM carddav_accounts WHERE user_id = ?
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
      // `carddav_book_links` (and through them contact states and
      // tombstones) cascade; the local address books and their contacts are
      // deliberately left alone -- disconnecting an account must not delete
      // a user's data.
      await db.execute("DELETE FROM carddav_accounts WHERE id = ?", [id]);
    },

    async findBookLinkById(id) {
      const rows = await db.query<CarddavBookLinkRow>(
        "SELECT * FROM carddav_book_links WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToBookLink(rows[0]);
    },

    async findBookLinkByAddressBook(addressBookId) {
      const rows = await db.query<CarddavBookLinkRow>(
        "SELECT * FROM carddav_book_links WHERE address_book_id = ?",
        [addressBookId],
      );
      return rows[0] === undefined ? null : rowToBookLink(rows[0]);
    },

    async listBookLinksByAccount(accountId) {
      const rows = await db.query<CarddavBookLinkRow>(
        `SELECT * FROM carddav_book_links WHERE account_id = ?
         ORDER BY display_name ASC, id ASC`,
        [accountId],
      );
      return rows.map(rowToBookLink);
    },

    async saveBookLink(link) {
      await db.execute(UPSERT_BOOK_LINK_SQL, [
        link.id,
        link.accountId,
        link.addressBookId,
        link.remoteUrl,
        link.displayName,
        link.ctag,
        link.syncToken,
        link.lastSyncedAt,
      ]);
    },

    async deleteBookLink(id) {
      await db.execute("DELETE FROM carddav_book_links WHERE id = ?", [id]);
    },

    async findContactState(contactId) {
      const rows = await db.query<CarddavContactStateRow>(
        "SELECT * FROM carddav_contact_states WHERE contact_id = ?",
        [contactId],
      );
      return rows[0] === undefined ? null : rowToContactState(rows[0]);
    },

    async findContactStateByHref(carddavBookId, href) {
      const rows = await db.query<CarddavContactStateRow>(
        `SELECT * FROM carddav_contact_states
         WHERE carddav_book_id = ? AND href = ?`,
        [carddavBookId, href],
      );
      return rows[0] === undefined ? null : rowToContactState(rows[0]);
    },

    async listContactStates(carddavBookId) {
      const rows = await db.query<CarddavContactStateRow>(
        `SELECT * FROM carddav_contact_states WHERE carddav_book_id = ?
         ORDER BY href ASC`,
        [carddavBookId],
      );
      return rows.map(rowToContactState);
    },

    async saveContactState(state) {
      await db.execute(UPSERT_CONTACT_STATE_SQL, [
        state.contactId,
        state.carddavBookId,
        state.href,
        state.etag,
        state.lastSyncedAt,
        boolToSql(state.remoteUnsupported),
      ]);
    },

    async deleteContactState(contactId) {
      await db.execute(
        "DELETE FROM carddav_contact_states WHERE contact_id = ?",
        [contactId],
      );
    },

    async addDeletion(deletion) {
      await db.execute(UPSERT_DELETION_SQL, [
        deletion.carddavBookId,
        deletion.href,
        deletion.etag,
        deletion.deletedAt,
      ]);
    },

    async listDeletions(carddavBookId) {
      const rows = await db.query<CarddavDeletionRow>(
        `SELECT * FROM carddav_deletions WHERE carddav_book_id = ?
         ORDER BY deleted_at ASC, href ASC`,
        [carddavBookId],
      );
      return rows.map(rowToDeletion);
    },

    async removeDeletion(carddavBookId, href) {
      await db.execute(
        "DELETE FROM carddav_deletions WHERE carddav_book_id = ? AND href = ?",
        [carddavBookId, href],
      );
    },
  };
}
