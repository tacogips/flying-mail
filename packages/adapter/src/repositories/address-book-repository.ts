import type {
  AddressBookListFilter,
  AddressBookRepository,
} from "@mailcal/application/ports/address-book-repository";
import type {
  SqlDatabase,
  SqlValue,
} from "@mailcal/application/ports/sql-database";
import type { AddressBook } from "@mailcal/domain/entities/address-book";
import {
  createAddressBookId,
  createMailAddressId,
} from "@mailcal/domain/value-objects/ids";
import {
  buildAllowedPatternsColumnCondition,
  buildMailPermissionColumnFilterCondition,
} from "./mail-permission-queries";
import { boolToSql, buildInPlaceholders, sqlToBool } from "./sql-helpers";

interface AddressBookRow {
  readonly id: string;
  readonly mail_address_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_default: number;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToAddressBook(row: AddressBookRow): AddressBook {
  return {
    id: createAddressBookId(row.id),
    mailAddressId: createMailAddressId(row.mail_address_id),
    name: row.name,
    description: row.description,
    isDefault: sqlToBool(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Re-issuing a book under the same id replaces it, so a use case can call
 * `save` for both create and update without asking which one it is.
 * Violating the partial unique index on `is_default` surfaces as the
 * driver's own constraint error; this repository does not catch it, leaving
 * translation to `CONFLICT` to the use case's `translateDomainError`. */
const UPSERT_SQL = `INSERT INTO address_books
  (id, mail_address_id, name, description, is_default, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    is_default = excluded.is_default,
    updated_at = excluded.updated_at`;

export function createAddressBookRepository(
  db: SqlDatabase,
): AddressBookRepository {
  return {
    async findById(id) {
      const rows = await db.query<AddressBookRow>(
        "SELECT * FROM address_books WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToAddressBook(rows[0]);
    },

    async findDefaultForMailAddress(mailAddressId) {
      const rows = await db.query<AddressBookRow>(
        `SELECT * FROM address_books
         WHERE mail_address_id = ? AND is_default = 1`,
        [mailAddressId],
      );
      return rows[0] === undefined ? null : rowToAddressBook(rows[0]);
    },

    async listByMailAddresses(mailAddressIds) {
      if (mailAddressIds.length === 0) {
        return [];
      }
      const rows = await db.query<AddressBookRow>(
        `SELECT * FROM address_books
         WHERE mail_address_id IN (${buildInPlaceholders(mailAddressIds.length)})
         ORDER BY name ASC, id ASC`,
        [...mailAddressIds],
      );
      return rows.map(rowToAddressBook);
    },

    /** Joins to `mail_addresses` because both scoping mechanisms --
     * `allowedPatterns` (API-key scope) and `mailPermissionFilter` (user
     * mailbox rules) -- match against the book's *owning address*, not any
     * column on `address_books` itself. */
    async listReadable(filter: AddressBookListFilter) {
      const conditions: string[] = [];
      const params: SqlValue[] = [];

      if (filter.mailAddressIds !== undefined) {
        conditions.push(
          `address_books.mail_address_id IN (${buildInPlaceholders(filter.mailAddressIds.length)})`,
        );
        params.push(...filter.mailAddressIds);
      }

      const allowed = buildAllowedPatternsColumnCondition(
        "mail_addresses.address",
        filter.allowedPatterns,
      );
      if (allowed === "NONE") {
        return [];
      }
      if (allowed !== null) {
        conditions.push(allowed.sql);
        params.push(...allowed.params);
      }

      const mailPermission = buildMailPermissionColumnFilterCondition(
        "mail_addresses.domain_id",
        "mail_addresses.address",
        filter.mailPermissionFilter,
      );
      if (mailPermission === "NONE") {
        return [];
      }
      if (mailPermission !== null) {
        conditions.push(mailPermission.sql);
        params.push(...mailPermission.params);
      }

      const where =
        conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
      const rows = await db.query<AddressBookRow>(
        `SELECT address_books.* FROM address_books
         JOIN mail_addresses ON mail_addresses.id = address_books.mail_address_id
         ${where}
         ORDER BY address_books.name ASC, address_books.id ASC`,
        params,
      );
      return rows.map(rowToAddressBook);
    },

    async save(book) {
      await db.execute(UPSERT_SQL, [
        book.id,
        book.mailAddressId,
        book.name,
        book.description,
        boolToSql(book.isDefault),
        book.createdAt,
        book.updatedAt,
      ]);
    },

    async delete(id) {
      // Contacts (and through them their child rows and CardDAV link/state
      // rows) all cascade (migration 0010).
      await db.execute("DELETE FROM address_books WHERE id = ?", [id]);
    },

    async countContacts(id) {
      const rows = await db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM contacts WHERE address_book_id = ?",
        [id],
      );
      return rows[0]?.count ?? 0;
    },
  };
}
