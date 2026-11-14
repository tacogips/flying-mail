import type { ClassificationRuleRepository } from "@mailcal/application/ports/classification-rule-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type ClassificationRule,
  RuleAction,
  RuleField,
  RuleMatcher,
} from "@mailcal/domain/entities/classification-rule";
import {
  createClassificationRuleId,
  createDomainId,
  createTagId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue, boolToSql, sqlToBool } from "./sql-helpers";

interface RuleRow {
  readonly id: string;
  readonly domain_id: string | null;
  readonly field: string;
  readonly matcher: string;
  readonly pattern: string;
  readonly action: string;
  readonly tag_id: string | null;
  readonly enabled: number;
  readonly description: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function rowToRule(row: RuleRow): ClassificationRule {
  return {
    id: createClassificationRuleId(row.id),
    domainId: row.domain_id === null ? null : createDomainId(row.domain_id),
    field: assertEnumValue(RuleField, row.field, "rule field"),
    matcher: assertEnumValue(RuleMatcher, row.matcher, "rule matcher"),
    pattern: row.pattern,
    action: assertEnumValue(RuleAction, row.action, "rule action"),
    tagId: row.tag_id === null ? null : createTagId(row.tag_id),
    enabled: sqlToBool(row.enabled),
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_SQL = `INSERT INTO classification_rules
  (id, domain_id, field, matcher, pattern, action, tag_id, enabled,
   description, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    domain_id = excluded.domain_id,
    field = excluded.field,
    matcher = excluded.matcher,
    pattern = excluded.pattern,
    action = excluded.action,
    tag_id = excluded.tag_id,
    enabled = excluded.enabled,
    description = excluded.description,
    updated_at = excluded.updated_at`;

export function createClassificationRuleRepository(
  db: SqlDatabase,
): ClassificationRuleRepository {
  return {
    async findById(id) {
      const rows = await db.query<RuleRow>(
        "SELECT * FROM classification_rules WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToRule(rows[0]);
    },

    async save(rule) {
      await db.execute(UPSERT_SQL, [
        rule.id,
        rule.domainId,
        rule.field,
        rule.matcher,
        rule.pattern,
        rule.action,
        rule.tagId,
        boolToSql(rule.enabled),
        rule.description,
        rule.createdAt,
        rule.updatedAt,
      ]);
    },

    async delete(id) {
      await db.execute("DELETE FROM classification_rules WHERE id = ?", [id]);
    },

    async list() {
      const rows = await db.query<RuleRow>(
        "SELECT * FROM classification_rules ORDER BY created_at ASC, id ASC",
      );
      return rows.map(rowToRule);
    },

    async listEnabledForDomain(domainId) {
      const rows = await db.query<RuleRow>(
        `SELECT * FROM classification_rules
         WHERE enabled = 1 AND (domain_id IS NULL OR domain_id = ?)
         ORDER BY created_at ASC, id ASC`,
        [domainId],
      );
      return rows.map(rowToRule);
    },
  };
}
