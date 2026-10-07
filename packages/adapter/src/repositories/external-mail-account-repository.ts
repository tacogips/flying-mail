import type { ExternalMailAccountRepository } from "@flying-mail/application/ports/external-mail";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import {
  ExternalAccountStatus,
  type ExternalFetchConfig,
  type ExternalMailAccount,
  type SmtpSecurity,
  type SmtpSubmissionConfig,
} from "@flying-mail/domain/entities/external-mail-account";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createExternalAccountId,
  createMailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface ExternalMailAccountRow {
  readonly id: string;
  readonly mail_address_id: string;
  readonly external_address: string;
  readonly display_name: string | null;
  readonly fetch_kind: string;
  readonly fetch_config: string;
  readonly fetch_password_ciphertext: string;
  readonly smtp_config: string | null;
  readonly smtp_password_ciphertext: string | null;
  readonly status: string;
  readonly last_fetched_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Discriminant values `fetch_kind` is `CHECK`-constrained to. Not a domain
 * `enum` -- `ExternalFetchConfig["kind"]` is a plain string-literal union --
 * so this local object stands in for one, satisfying `assertEnumValue`'s
 * `Record<string, T>` shape the way `ExternalAccountStatus` does below. */
const FETCH_KIND_VALUES: Record<string, ExternalFetchConfig["kind"]> = {
  JMAP: "JMAP",
  POP3: "POP3",
};

const SMTP_SECURITY_VALUES: Record<string, SmtpSecurity> = {
  IMPLICIT_TLS: "IMPLICIT_TLS",
  STARTTLS: "STARTTLS",
};

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(
      `external_mail_accounts config JSON field "${field}" must be a string`,
    );
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") {
    throw new Error(
      `external_mail_accounts config JSON field "${field}" must be a number`,
    );
  }
  return value;
}

function parseJsonObject(
  json: string,
  column: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `external_mail_accounts.${column} is not valid JSON: ${String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`external_mail_accounts.${column} must be a JSON object`);
  }
  // Validated: a non-null, non-array `object` narrows structurally to a
  // string-keyed bag; every field is still read through `requireString`/
  // `requireNumber` below rather than trusted as-is.
  return parsed as Record<string, unknown>;
}

/** Reassembles the `ExternalFetchConfig` union from its three storage
 * pieces: the `fetch_kind` discriminant column, the non-secret
 * `fetch_config` JSON, and the `fetch_password_ciphertext` column. Never
 * `as`-casts past field-by-field validation. */
function parseFetchConfig(
  kind: ExternalFetchConfig["kind"],
  fetchConfigJson: string,
  passwordCiphertext: string,
): ExternalFetchConfig {
  const record = parseJsonObject(fetchConfigJson, "fetch_config");
  switch (kind) {
    case "JMAP":
      return {
        kind: "JMAP",
        sessionUrl: requireString(record, "sessionUrl"),
        username: requireString(record, "username"),
        passwordCiphertext,
      };
    case "POP3":
      return {
        kind: "POP3",
        host: requireString(record, "host"),
        port: requireNumber(record, "port"),
        username: requireString(record, "username"),
        passwordCiphertext,
      };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled fetch kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function fetchConfigJson(fetch: ExternalFetchConfig): string {
  switch (fetch.kind) {
    case "JMAP":
      return JSON.stringify({
        sessionUrl: fetch.sessionUrl,
        username: fetch.username,
      });
    case "POP3":
      return JSON.stringify({
        host: fetch.host,
        port: fetch.port,
        username: fetch.username,
      });
    default: {
      const exhaustive: never = fetch;
      throw new Error(`Unhandled fetch kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function parseSmtpConfig(
  smtpConfigJson: string,
  passwordCiphertext: string,
): SmtpSubmissionConfig {
  const record = parseJsonObject(smtpConfigJson, "smtp_config");
  const security = requireString(record, "security");
  return {
    host: requireString(record, "host"),
    port: requireNumber(record, "port"),
    security: assertEnumValue(
      SMTP_SECURITY_VALUES,
      security,
      "external mail smtp security",
    ),
    username: requireString(record, "username"),
    passwordCiphertext,
  };
}

function smtpConfigJson(smtp: SmtpSubmissionConfig): string {
  return JSON.stringify({
    host: smtp.host,
    port: smtp.port,
    security: smtp.security,
    username: smtp.username,
  });
}

function rowToExternalMailAccount(
  row: ExternalMailAccountRow,
): ExternalMailAccount {
  const kind = assertEnumValue(
    FETCH_KIND_VALUES,
    row.fetch_kind,
    "external mail fetch_kind",
  );
  let smtp: SmtpSubmissionConfig | null = null;
  if (row.smtp_config !== null) {
    if (row.smtp_password_ciphertext === null) {
      throw new Error(
        "external_mail_accounts row has smtp_config but no smtp_password_ciphertext",
      );
    }
    smtp = parseSmtpConfig(row.smtp_config, row.smtp_password_ciphertext);
  }
  return {
    id: createExternalAccountId(row.id),
    mailAddressId: createMailAddressId(row.mail_address_id),
    externalAddress: createEmailAddress(row.external_address),
    displayName: row.display_name,
    fetch: parseFetchConfig(
      kind,
      row.fetch_config,
      row.fetch_password_ciphertext,
    ),
    smtp,
    status: assertEnumValue(
      ExternalAccountStatus,
      row.status,
      "external mail account status",
    ),
    lastFetchedAt: row.last_fetched_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const UPSERT_SQL = `INSERT INTO external_mail_accounts
  (id, mail_address_id, external_address, display_name, fetch_kind,
   fetch_config, fetch_password_ciphertext, smtp_config,
   smtp_password_ciphertext, status, last_fetched_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    external_address = excluded.external_address,
    display_name = excluded.display_name,
    fetch_kind = excluded.fetch_kind,
    fetch_config = excluded.fetch_config,
    fetch_password_ciphertext = excluded.fetch_password_ciphertext,
    smtp_config = excluded.smtp_config,
    smtp_password_ciphertext = excluded.smtp_password_ciphertext,
    status = excluded.status,
    last_fetched_at = excluded.last_fetched_at,
    updated_at = excluded.updated_at`;

export function createExternalMailAccountRepository(
  db: SqlDatabase,
): ExternalMailAccountRepository {
  return {
    async findById(id) {
      const rows = await db.query<ExternalMailAccountRow>(
        "SELECT * FROM external_mail_accounts WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToExternalMailAccount(rows[0]);
    },

    async findByMailAddress(mailAddressId) {
      const rows = await db.query<ExternalMailAccountRow>(
        "SELECT * FROM external_mail_accounts WHERE mail_address_id = ?",
        [mailAddressId],
      );
      return rows[0] === undefined ? null : rowToExternalMailAccount(rows[0]);
    },

    async list() {
      const rows = await db.query<ExternalMailAccountRow>(
        "SELECT * FROM external_mail_accounts ORDER BY created_at ASC, id ASC",
      );
      return rows.map(rowToExternalMailAccount);
    },

    async save(account) {
      await db.execute(UPSERT_SQL, [
        account.id,
        account.mailAddressId,
        account.externalAddress,
        account.displayName,
        account.fetch.kind,
        fetchConfigJson(account.fetch),
        account.fetch.passwordCiphertext,
        account.smtp === null ? null : smtpConfigJson(account.smtp),
        account.smtp === null ? null : account.smtp.passwordCiphertext,
        account.status,
        account.lastFetchedAt,
        account.createdAt,
        account.updatedAt,
      ]);
    },

    async delete(id) {
      // `external_message_states` cascades via its `account_id` foreign key.
      await db.execute("DELETE FROM external_mail_accounts WHERE id = ?", [id]);
    },
  };
}
