import type { MailTemplateRepository } from "@mailcal/application/ports/mail-template-repository";
import type {
  SqlDatabase,
  SqlStatement,
} from "@mailcal/application/ports/sql-database";
import {
  type MailTemplate,
  type TemplateVariable,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import {
  createMailTemplateId,
  createUserId,
  type MailTemplateId,
} from "@mailcal/domain/value-objects/ids";
import {
  assertEnumValue,
  boolToSql,
  buildInPlaceholders,
  sqlToBool,
} from "./sql-helpers";

interface MailTemplateRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly subject: string;
  readonly text_body: string | null;
  readonly html_body: string | null;
  readonly from_address: string | null;
  readonly to_addresses_json: string;
  readonly cc_addresses_json: string;
  readonly bcc_addresses_json: string;
  readonly created_by_user_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TemplateVariableRow {
  readonly id: string;
  readonly template_id: string;
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly required: number;
  readonly default_value: string | null;
  readonly description: string | null;
  readonly position: number;
}

/** Recipient slots are stored as a JSON array in one column rather than a
 * child table: they are only ever read and written as a whole list, and
 * nothing queries an individual entry. A row written by hand with malformed
 * JSON degrades to an empty list rather than failing the whole read. */
function parseAddressList(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToVariable(row: TemplateVariableRow): TemplateVariable {
  return {
    key: row.key,
    label: row.label,
    type: assertEnumValue(
      TemplateVariableType,
      row.type,
      "template variable type",
    ),
    required: sqlToBool(row.required),
    defaultValue: row.default_value,
    description: row.description,
  };
}

function rowToTemplate(
  row: MailTemplateRow,
  variables: readonly TemplateVariable[],
): MailTemplate {
  return {
    id: createMailTemplateId(row.id),
    name: row.name,
    description: row.description,
    subject: row.subject,
    textBody: row.text_body,
    htmlBody: row.html_body,
    from: row.from_address,
    to: parseAddressList(row.to_addresses_json),
    cc: parseAddressList(row.cc_addresses_json),
    bcc: parseAddressList(row.bcc_addresses_json),
    variables,
    createdByUserId:
      row.created_by_user_id === null
        ? null
        : createUserId(row.created_by_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_TEMPLATE_SQL = `INSERT INTO mail_templates
  (id, name, description, subject, text_body, html_body, from_address,
   to_addresses_json, cc_addresses_json, bcc_addresses_json,
   created_by_user_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    subject = excluded.subject,
    text_body = excluded.text_body,
    html_body = excluded.html_body,
    from_address = excluded.from_address,
    to_addresses_json = excluded.to_addresses_json,
    cc_addresses_json = excluded.cc_addresses_json,
    bcc_addresses_json = excluded.bcc_addresses_json,
    updated_at = excluded.updated_at`;

const INSERT_VARIABLE_SQL = `INSERT INTO mail_template_variables
  (id, template_id, key, label, type, required, default_value, description, position)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export function createMailTemplateRepository(
  db: SqlDatabase,
): MailTemplateRepository {
  /** Loads and groups the variable rows for a set of templates, ordered by
   * the position the editor saved them in -- the order the generated form
   * renders its fields in. */
  async function loadVariables(
    templateIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly TemplateVariable[]>> {
    const byTemplate = new Map<string, TemplateVariable[]>(
      templateIds.map((id) => [id, []]),
    );
    if (templateIds.length === 0) {
      return byTemplate;
    }
    const rows = await db.query<TemplateVariableRow>(
      `SELECT * FROM mail_template_variables
       WHERE template_id IN (${buildInPlaceholders(templateIds.length)})
       ORDER BY template_id ASC, position ASC`,
      [...templateIds],
    );
    for (const row of rows) {
      byTemplate.get(row.template_id)?.push(rowToVariable(row));
    }
    return byTemplate;
  }

  async function hydrate(
    rows: readonly MailTemplateRow[],
  ): Promise<readonly MailTemplate[]> {
    const variables = await loadVariables(rows.map((row) => row.id));
    return rows.map((row) => rowToTemplate(row, variables.get(row.id) ?? []));
  }

  return {
    async findById(id) {
      const rows = await db.query<MailTemplateRow>(
        "SELECT * FROM mail_templates WHERE id = ?",
        [id],
      );
      const hydrated = await hydrate(rows);
      return hydrated[0] ?? null;
    },

    async findByName(name) {
      const rows = await db.query<MailTemplateRow>(
        "SELECT * FROM mail_templates WHERE lower(name) = lower(?)",
        [name.trim()],
      );
      const hydrated = await hydrate(rows);
      return hydrated[0] ?? null;
    },

    async list() {
      const rows = await db.query<MailTemplateRow>(
        "SELECT * FROM mail_templates ORDER BY name ASC",
      );
      return hydrate(rows);
    },

    /** One `batch()`: the template row and its whole variable set are
     * replaced atomically, so a reader can never observe a body that reads
     * `it.x` alongside a variable set that has just lost `x`. */
    async save(template) {
      const statements: SqlStatement[] = [
        {
          sql: UPSERT_TEMPLATE_SQL,
          params: [
            template.id,
            template.name,
            template.description,
            template.subject,
            template.textBody,
            template.htmlBody,
            template.from,
            JSON.stringify(template.to),
            JSON.stringify(template.cc),
            JSON.stringify(template.bcc),
            template.createdByUserId,
            template.createdAt,
            template.updatedAt,
          ],
        },
        {
          sql: "DELETE FROM mail_template_variables WHERE template_id = ?",
          params: [template.id],
        },
      ];
      template.variables.forEach((variable, position) => {
        statements.push({
          sql: INSERT_VARIABLE_SQL,
          params: [
            // Deterministic per (template, key): the set is rewritten whole
            // on every save, so a row needs no identity beyond its slot.
            `${template.id}:${variable.key}`,
            template.id,
            variable.key,
            variable.label,
            variable.type,
            boolToSql(variable.required),
            variable.defaultValue,
            variable.description,
            position,
          ],
        });
      });
      await db.batch(statements);
    },

    async delete(id: MailTemplateId) {
      // `mail_template_variables` cascades on the foreign key.
      await db.execute("DELETE FROM mail_templates WHERE id = ?", [id]);
    },
  };
}
