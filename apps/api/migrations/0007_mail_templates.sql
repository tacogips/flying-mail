-- Mail templates: an instance-wide catalogue of Eta-sourced mail bodies with
-- a declared variable set, plus the per-user grants that decide who may
-- create, update or delete one.
--
-- SQLite cannot widen a CHECK constraint in place, so api_key_scopes is
-- rebuilt with the same `_new` + rename pattern migrations 0005 and 0006
-- used, admitting the four template capabilities. Every existing scope row
-- is copied verbatim: mail and calendar keys must come out of this migration
-- behaving exactly as they went in.
CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN','CALENDAR_READ','CALENDAR_WRITE','TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes;

DROP TABLE api_key_scopes;

ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);

-- Recipient slots are stored as JSON arrays: they are only ever read and
-- written as a whole list, and nothing queries an individual entry.
CREATE TABLE mail_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  from_address TEXT,
  to_addresses_json TEXT NOT NULL DEFAULT '[]',
  cc_addresses_json TEXT NOT NULL DEFAULT '[]',
  bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (text_body IS NOT NULL OR html_body IS NOT NULL)
);

CREATE UNIQUE INDEX idx_mail_templates_name ON mail_templates(lower(name));

-- Variables live in their own table so the database itself enforces one key
-- per template, and so the set keeps the order the editor saved -- which is
-- the order the generated variable form renders its fields in.
CREATE TABLE mail_template_variables (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES mail_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN
    ('TEXT','MULTILINE_TEXT','NUMBER','BOOLEAN','DATE','EMAIL')),
  required INTEGER NOT NULL DEFAULT 1,
  default_value TEXT,
  description TEXT,
  position INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_mail_template_variables_key
  ON mail_template_variables(template_id, key);

CREATE INDEX idx_mail_template_variables_template
  ON mail_template_variables(template_id, position);

-- One rule per (user, capability): re-granting replaces rather than stacks,
-- so a user's rule list can never hold a contradictory ALLOW/DENY pair whose
-- outcome would depend on evaluation order.
CREATE TABLE user_template_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE')),
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_user_template_permissions_rule
  ON user_template_permissions(user_id, capability);
