import type { TagRepository } from "@mailcal/application/ports/tag-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { SystemTagSlug, type Tag, TagKind } from "@mailcal/domain/entities/tag";
import { createTagId, type TagId } from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, buildInPlaceholders } from "./sql-helpers";

interface TagRow {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly kind: string;
  readonly system_slug: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToTag(row: TagRow): Tag {
  return {
    id: createTagId(row.id),
    name: row.name,
    color: row.color,
    kind: assertEnumValue(TagKind, row.kind, "tag kind"),
    systemSlug:
      row.system_slug === null
        ? null
        : assertEnumValue(SystemTagSlug, row.system_slug, "system tag slug"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_SQL = `INSERT INTO tags
  (id, name, color, kind, system_slug, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    color = excluded.color,
    updated_at = excluded.updated_at`;

export function createTagRepository(db: SqlDatabase): TagRepository {
  return {
    async findById(id) {
      const rows = await db.query<TagRow>("SELECT * FROM tags WHERE id = ?", [
        id,
      ]);
      return rows[0] === undefined ? null : rowToTag(rows[0]);
    },

    async findByIds(ids) {
      if (ids.length === 0) {
        return [];
      }
      const rows = await db.query<TagRow>(
        `SELECT * FROM tags WHERE id IN (${buildInPlaceholders(ids.length)})`,
        [...ids],
      );
      return rows.map(rowToTag);
    },

    /** Case-insensitive, matching the duplicate-name rule the tag use cases
     * enforce -- "Invoices" and "invoices" are the same tag to a reader. */
    async findByName(name) {
      const rows = await db.query<TagRow>(
        "SELECT * FROM tags WHERE lower(name) = lower(?)",
        [name.trim()],
      );
      return rows[0] === undefined ? null : rowToTag(rows[0]);
    },

    async findBySystemSlug(slug) {
      const rows = await db.query<TagRow>(
        "SELECT * FROM tags WHERE system_slug = ?",
        [slug],
      );
      return rows[0] === undefined ? null : rowToTag(rows[0]);
    },

    async list() {
      const rows = await db.query<TagRow>(
        "SELECT * FROM tags ORDER BY kind DESC, name ASC",
      );
      return rows.map(rowToTag);
    },

    async countMessages(ids) {
      const counts = new Map<string, number>(
        ids.map((id) => [id as string, 0]),
      );
      if (ids.length === 0) {
        return counts;
      }
      const rows = await db.query<{ tag_id: string; count: number }>(
        `SELECT tag_id, COUNT(*) AS count
         FROM message_tags
         WHERE tag_id IN (${buildInPlaceholders(ids.length)})
         GROUP BY tag_id`,
        [...ids],
      );
      for (const row of rows) {
        counts.set(row.tag_id, row.count);
      }
      return counts;
    },

    async save(tag: Tag) {
      await db.execute(UPSERT_SQL, [
        tag.id,
        tag.name,
        tag.color,
        tag.kind,
        tag.systemSlug,
        tag.createdAt,
        tag.updatedAt,
      ]);
    },

    async delete(id: TagId) {
      await db.execute("DELETE FROM tags WHERE id = ?", [id]);
    },
  };
}
