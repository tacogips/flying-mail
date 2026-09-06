import type { ContactRepository } from "@mailcal/application/ports/contact-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { Contact } from "@mailcal/domain/entities/contact";
import { buildContactListQuery } from "./contact-queries";
import {
  type ContactEmailRow,
  type ContactPhoneRow,
  type ContactPostalAddressRow,
  type ContactRow,
  type ContactUrlRow,
  contactWriteStatements,
  rowToContact,
} from "./contact-rows";
import { buildInPlaceholders, encodeCursor } from "./sql-helpers";

function groupByContactId<T extends { readonly contact_id: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.contact_id) ?? [];
    bucket.push(row);
    grouped.set(row.contact_id, bucket);
  }
  return grouped;
}

export function createContactRepository(db: SqlDatabase): ContactRepository {
  /** Loads the four child tables for a page of contacts in four queries
   * rather than four queries per contact. */
  async function hydrate(
    rows: readonly ContactRow[],
  ): Promise<readonly Contact[]> {
    if (rows.length === 0) {
      return [];
    }
    const ids = rows.map((row) => row.id);
    const placeholders = buildInPlaceholders(ids.length);
    const [emailRows, phoneRows, postalRows, urlRows] = await Promise.all([
      db.query<ContactEmailRow>(
        `SELECT * FROM contact_emails WHERE contact_id IN (${placeholders})`,
        [...ids],
      ),
      db.query<ContactPhoneRow>(
        `SELECT * FROM contact_phones WHERE contact_id IN (${placeholders})`,
        [...ids],
      ),
      db.query<ContactPostalAddressRow>(
        `SELECT * FROM contact_postal_addresses WHERE contact_id IN (${placeholders})`,
        [...ids],
      ),
      db.query<ContactUrlRow>(
        `SELECT * FROM contact_urls WHERE contact_id IN (${placeholders})`,
        [...ids],
      ),
    ]);

    const emailsByContact = groupByContactId(emailRows);
    const phonesByContact = groupByContactId(phoneRows);
    const postalByContact = groupByContactId(postalRows);
    const urlsByContact = groupByContactId(urlRows);

    return rows.map((row) =>
      rowToContact(
        row,
        emailsByContact.get(row.id) ?? [],
        phonesByContact.get(row.id) ?? [],
        postalByContact.get(row.id) ?? [],
        urlsByContact.get(row.id) ?? [],
      ),
    );
  }

  async function queryContacts(
    sql: string,
    params: readonly (string | number | null)[],
  ): Promise<readonly Contact[]> {
    return hydrate(await db.query<ContactRow>(sql, params));
  }

  return {
    async findById(id) {
      const contacts = await queryContacts(
        "SELECT * FROM contacts WHERE id = ?",
        [id],
      );
      return contacts[0] ?? null;
    },

    async findByUid(addressBookId, uid) {
      const contacts = await queryContacts(
        "SELECT * FROM contacts WHERE address_book_id = ? AND uid = ?",
        [addressBookId, uid],
      );
      return contacts[0] ?? null;
    },

    async createContact(contact) {
      await db.batch(contactWriteStatements(contact));
    },

    async updateContact(contact) {
      await db.batch(contactWriteStatements(contact));
    },

    async deleteContact(id) {
      // Child rows and the CardDAV contact-state row all cascade
      // (migration 0010); a pending remote deletion is preserved separately
      // as a `carddav_deletions` tombstone by the use case, since that
      // table has no foreign key to `contacts` for exactly that reason.
      await db.execute("DELETE FROM contacts WHERE id = ?", [id]);
    },

    async listByAddressBook(addressBookId) {
      return queryContacts(
        `SELECT * FROM contacts WHERE address_book_id = ?
         ORDER BY display_name ASC, id ASC`,
        [addressBookId],
      );
    },

    async listByEmail(address, addressBookIds) {
      if (addressBookIds.length === 0) {
        return [];
      }
      const rows = await db.query<ContactRow>(
        `SELECT DISTINCT contacts.* FROM contacts
         JOIN contact_emails ON contact_emails.contact_id = contacts.id
         WHERE contact_emails.address = ?
           AND contacts.address_book_id IN (${buildInPlaceholders(addressBookIds.length)})
         ORDER BY contacts.display_name ASC, contacts.id ASC`,
        [address, ...addressBookIds],
      );
      return hydrate(rows);
    },

    async listPage(input) {
      const query = buildContactListQuery(input);
      const [rows, countRows] = await Promise.all([
        db.query<ContactRow>(query.rowsSql, query.rowsParams),
        db.query<{ count: number }>(query.countSql, query.countParams),
      ]);

      const hasMore = rows.length > input.first;
      const page = hasMore ? rows.slice(0, input.first) : rows;
      const last = page[page.length - 1];
      const nodes = await hydrate(page);
      return {
        nodes,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor(last.display_name, last.id)
            : null,
        totalCount: countRows[0]?.count ?? 0,
      };
    },
  };
}
