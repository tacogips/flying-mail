import type { SqlStatement } from "@flying-mail/application/ports/sql-database";
import type { Contact } from "@flying-mail/domain/entities/contact";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAddressBookId,
  createContactId,
} from "@flying-mail/domain/value-objects/ids";
import { createIsoDate } from "@flying-mail/domain/value-objects/iso-date";

/** Row <-> entity mapping for `contacts` and its four child tables.
 *
 * Kept beside the repository rather than inside it so the repository file
 * stays focused on queries. */

export interface ContactRow {
  readonly id: string;
  readonly address_book_id: string;
  readonly uid: string;
  readonly display_name: string;
  readonly given_name: string | null;
  readonly family_name: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly note: string | null;
  readonly birthday: string | null;
  readonly extra_vcard_lines: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ContactEmailRow {
  readonly contact_id: string;
  readonly position: number;
  readonly address: string;
  readonly label: string | null;
}

export interface ContactPhoneRow {
  readonly contact_id: string;
  readonly position: number;
  readonly number: string;
  readonly label: string | null;
}

export interface ContactPostalAddressRow {
  readonly contact_id: string;
  readonly position: number;
  readonly formatted: string;
  readonly label: string | null;
}

export interface ContactUrlRow {
  readonly contact_id: string;
  readonly position: number;
  readonly url: string;
  readonly label: string | null;
}

function byPosition<T extends { readonly position: number }>(
  rows: readonly T[],
): readonly T[] {
  return rows.slice().sort((left, right) => left.position - right.position);
}

export function rowToContact(
  row: ContactRow,
  emails: readonly ContactEmailRow[],
  phones: readonly ContactPhoneRow[],
  postalAddresses: readonly ContactPostalAddressRow[],
  urls: readonly ContactUrlRow[],
): Contact {
  return {
    id: createContactId(row.id),
    addressBookId: createAddressBookId(row.address_book_id),
    uid: row.uid,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    nickname: row.nickname,
    organization: row.organization,
    title: row.title,
    emails: byPosition(emails).map((email) => ({
      address: createEmailAddress(email.address),
      label: email.label,
    })),
    phones: byPosition(phones).map((phone) => ({
      number: phone.number,
      label: phone.label,
    })),
    postalAddresses: byPosition(postalAddresses).map((address) => ({
      formatted: address.formatted,
      label: address.label,
    })),
    urls: byPosition(urls).map((url) => url.url),
    note: row.note,
    birthday:
      row.birthday === null ? null : createIsoDate(row.birthday, "birthday"),
    extraVcardLines: row.extra_vcard_lines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_CONTACT_SQL = `INSERT INTO contacts
  (id, address_book_id, uid, display_name, given_name, family_name, nickname,
   organization, title, note, birthday, extra_vcard_lines, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    address_book_id = excluded.address_book_id,
    uid = excluded.uid,
    display_name = excluded.display_name,
    given_name = excluded.given_name,
    family_name = excluded.family_name,
    nickname = excluded.nickname,
    organization = excluded.organization,
    title = excluded.title,
    note = excluded.note,
    birthday = excluded.birthday,
    extra_vcard_lines = excluded.extra_vcard_lines,
    updated_at = excluded.updated_at`;

/** The contact row plus its four child tables as one ordered statement list.
 *
 * D1 has no interactive transactions, so a write that must not tear has to
 * be a single `batch()`. Children are deleted then re-inserted rather than
 * diffed: the sets are small (at most 32 each, per the domain's
 * `MAX_CONTACT_LIST_LENGTH`), and a full replace cannot leave a stale row
 * behind when an email is removed -- mirrors `eventWriteStatements`. */
export function contactWriteStatements(
  contact: Contact,
): readonly SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql: UPSERT_CONTACT_SQL,
      params: [
        contact.id,
        contact.addressBookId,
        contact.uid,
        contact.displayName,
        contact.givenName,
        contact.familyName,
        contact.nickname,
        contact.organization,
        contact.title,
        contact.note,
        contact.birthday,
        contact.extraVcardLines,
        contact.createdAt,
        contact.updatedAt,
      ],
    },
    {
      sql: "DELETE FROM contact_emails WHERE contact_id = ?",
      params: [contact.id],
    },
    {
      sql: "DELETE FROM contact_phones WHERE contact_id = ?",
      params: [contact.id],
    },
    {
      sql: "DELETE FROM contact_postal_addresses WHERE contact_id = ?",
      params: [contact.id],
    },
    {
      sql: "DELETE FROM contact_urls WHERE contact_id = ?",
      params: [contact.id],
    },
  ];

  contact.emails.forEach((email, position) => {
    statements.push({
      sql: `INSERT INTO contact_emails (contact_id, position, address, label)
            VALUES (?, ?, ?, ?)`,
      params: [contact.id, position, email.address, email.label],
    });
  });
  contact.phones.forEach((phone, position) => {
    statements.push({
      sql: `INSERT INTO contact_phones (contact_id, position, number, label)
            VALUES (?, ?, ?, ?)`,
      params: [contact.id, position, phone.number, phone.label],
    });
  });
  contact.postalAddresses.forEach((address, position) => {
    statements.push({
      sql: `INSERT INTO contact_postal_addresses (contact_id, position, formatted, label)
            VALUES (?, ?, ?, ?)`,
      params: [contact.id, position, address.formatted, address.label],
    });
  });
  contact.urls.forEach((url, position) => {
    // The domain's `urls` is a plain `readonly string[]` (see
    // `Contact.urls`); the child table's `label` column exists only for
    // schema symmetry with the other three and is always written `null`
    // from this side.
    statements.push({
      sql: `INSERT INTO contact_urls (contact_id, position, url, label)
            VALUES (?, ?, ?, ?)`,
      params: [contact.id, position, url, null],
    });
  });

  return statements;
}
