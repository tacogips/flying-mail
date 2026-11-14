import type { ContactListPageInput } from "@flying-mail/application/ports/contact-repository";
import type { SqlValue } from "@flying-mail/application/ports/sql-database";
import {
  buildInPlaceholders,
  decodeCursor,
  escapeLikePattern,
} from "./sql-helpers";

/** Builds the listing and count queries for `ContactRepository.listPage`,
 * mirroring `message-repository-queries.ts`'s `buildMessageListQuery`
 * shape: one extra row is requested so the caller can tell whether a next
 * page exists without a second query, and the cursor is a keyset over a
 * total order rather than an offset. Ordering is `(display_name ASC, id
 * ASC)` -- alphabetical is what a rolodex-style listing wants, and pairing
 * it with `id` keeps the order total even when two contacts share a
 * display name. */

export interface BuiltContactListQuery {
  readonly rowsSql: string;
  readonly rowsParams: readonly SqlValue[];
  readonly countSql: string;
  readonly countParams: readonly SqlValue[];
}

export function buildContactListQuery(
  input: ContactListPageInput,
): BuiltContactListQuery {
  const conditions: string[] = [
    `contacts.address_book_id IN (${buildInPlaceholders(input.addressBookIds.length)})`,
  ];
  const params: SqlValue[] = [...input.addressBookIds];

  if (input.email !== undefined) {
    conditions.push(
      `EXISTS (SELECT 1 FROM contact_emails ce
                WHERE ce.contact_id = contacts.id AND ce.address = ?)`,
    );
    params.push(input.email);
  }

  if (input.query !== undefined && input.query.trim().length > 0) {
    const term = `%${escapeLikePattern(input.query.trim())}%`;
    conditions.push(
      `(contacts.display_name LIKE ? ESCAPE '\\'
        OR contacts.organization LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM contact_emails ce
                    WHERE ce.contact_id = contacts.id AND ce.address LIKE ? ESCAPE '\\'))`,
    );
    params.push(term, term, term);
  }

  const countSql = `SELECT COUNT(*) AS count FROM contacts WHERE ${conditions.join(" AND ")}`;
  const countParams = [...params];

  const rowsConditions = [...conditions];
  const rowsParams = [...params];
  const decoded = input.after === undefined ? null : decodeCursor(input.after);
  if (decoded !== null) {
    // `decodeCursor` names its pair `(occurredAt, id)` for its original
    // `messages` use, but it is just an opaque two-field codec -- the first
    // field carries `display_name` here.
    rowsConditions.push(
      `(contacts.display_name > ? OR (contacts.display_name = ? AND contacts.id > ?))`,
    );
    rowsParams.push(decoded.occurredAt, decoded.occurredAt, decoded.id);
  }

  const rowsSql = `SELECT * FROM contacts WHERE ${rowsConditions.join(" AND ")}
    ORDER BY contacts.display_name ASC, contacts.id ASC LIMIT ?`;
  rowsParams.push(input.first + 1);

  return { rowsSql, rowsParams, countSql, countParams };
}
