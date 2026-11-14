import type { CalendarRepository } from "@mailcal/application/ports/calendar-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import {
  createCalendarId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { buildInPlaceholders } from "./sql-helpers";

interface CalendarRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToCalendar(row: CalendarRow): Calendar {
  return {
    id: createCalendarId(row.id),
    ownerUserId: createUserId(row.owner_user_id),
    name: row.name,
    color: row.color,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Re-issuing a calendar under the same id replaces it, so a use case can
 * call `save` for both create and update without asking which one it is --
 * the same shape the mail repositories use. */
const UPSERT_SQL = `INSERT INTO calendars
  (id, owner_user_id, name, color, description, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    color = excluded.color,
    description = excluded.description,
    updated_at = excluded.updated_at`;

export function createCalendarRepository(db: SqlDatabase): CalendarRepository {
  return {
    async findById(id) {
      const rows = await db.query<CalendarRow>(
        "SELECT * FROM calendars WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToCalendar(rows[0]);
    },

    async findByIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db.query<CalendarRow>(
        `SELECT * FROM calendars WHERE id IN (${buildInPlaceholders(ids.length)})
         ORDER BY name ASC, id ASC`,
        [...ids],
      );
      return rows.map(rowToCalendar);
    },

    async listByOwner(ownerUserId) {
      const rows = await db.query<CalendarRow>(
        `SELECT * FROM calendars WHERE owner_user_id = ?
         ORDER BY name ASC, id ASC`,
        [ownerUserId],
      );
      return rows.map(rowToCalendar);
    },

    async listAll() {
      const rows = await db.query<CalendarRow>(
        "SELECT * FROM calendars ORDER BY owner_user_id ASC, name ASC, id ASC",
      );
      return rows.map(rowToCalendar);
    },

    async save(calendar) {
      await db.execute(UPSERT_SQL, [
        calendar.id,
        calendar.ownerUserId,
        calendar.name,
        calendar.color,
        calendar.description,
        calendar.createdAt,
        calendar.updatedAt,
      ]);
    },

    async delete(id) {
      // Events, mentions, links, attachment claims and CalDAV link rows all
      // cascade from here (migration 0006).
      await db.execute("DELETE FROM calendars WHERE id = ?", [id]);
    },
  };
}
