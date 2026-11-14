-- SQLite cannot widen a CHECK constraint in place. Rebuild users and every
-- table that references it so existing data survives adding the VIEWER role.
CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','MEMBER','VIEWER')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deactivated_at TEXT
);

INSERT INTO users_new
SELECT id, email, name, role, created_at, updated_at, deactivated_at FROM users;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO sessions_new
SELECT id, token_hash, user_id, expires_at, created_at FROM sessions;

CREATE TABLE api_keys_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users_new(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

INSERT INTO api_keys_new
SELECT id, name, key_hash, key_prefix, created_by_user_id, created_at,
       last_used_at, expires_at, revoked_at FROM api_keys;

CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys_new(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes;

CREATE TABLE message_fetch_states_new (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys_new(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('NOT_FETCHED','FETCHED')),
  fetched_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, api_key_id)
);

INSERT INTO message_fetch_states_new
SELECT message_id, api_key_id, status, fetched_at, updated_at
FROM message_fetch_states;

CREATE TABLE file_links_new (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL CHECK (target IN ('ATTACHMENT','RAW_MESSAGE')),
  attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_by_api_key_id TEXT REFERENCES api_keys_new(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users_new(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((target = 'ATTACHMENT' AND attachment_id IS NOT NULL AND message_id IS NULL)
      OR (target = 'RAW_MESSAGE' AND message_id IS NOT NULL AND attachment_id IS NULL))
);

INSERT INTO file_links_new
SELECT id, token_hash, target, attachment_id, message_id, expires_at,
       max_downloads, download_count, created_by_api_key_id,
       created_by_user_id, created_at, revoked_at FROM file_links;

DROP TABLE file_links;
DROP TABLE message_fetch_states;
DROP TABLE api_key_scopes;
DROP TABLE sessions;
DROP TABLE api_keys;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE api_keys_new RENAME TO api_keys;
ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;
ALTER TABLE message_fetch_states_new RENAME TO message_fetch_states;
ALTER TABLE file_links_new RENAME TO file_links;

CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);
CREATE INDEX idx_fetch_states_key ON message_fetch_states(api_key_id, status);
CREATE INDEX idx_file_links_token ON file_links(token_hash);
CREATE INDEX idx_file_links_expires_at ON file_links(expires_at);

CREATE TABLE user_mail_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_user_mail_permissions_user
  ON user_mail_permissions(user_id, effect);
CREATE INDEX idx_user_mail_permissions_domain
  ON user_mail_permissions(domain_id, effect);
CREATE UNIQUE INDEX idx_user_mail_permissions_rule
  ON user_mail_permissions(
    user_id,
    effect,
    ifnull(domain_id, ''),
    address_pattern
  );
