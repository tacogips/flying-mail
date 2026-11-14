-- SQLite cannot widen a CHECK constraint in place. Rebuild the scope table
-- while preserving every existing capability grant.
CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN','TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE','CONTACT_READ','CONTACT_WRITE','USER_ADMIN')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes;

DROP TABLE api_key_scopes;

ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);
