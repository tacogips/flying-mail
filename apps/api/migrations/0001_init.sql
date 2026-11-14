CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','MEMBER')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deactivated_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE email_auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_email_auth_challenges_token_hash
  ON email_auth_challenges(token_hash);
CREATE INDEX idx_email_auth_challenges_expires_at
  ON email_auth_challenges(expires_at);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  catch_all INTEGER NOT NULL DEFAULT 1,
  verification_token TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  thread_id TEXT NOT NULL,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  from_name TEXT,
  text_body TEXT,
  html_body TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  raw_key TEXT,
  raw_size INTEGER NOT NULL DEFAULT 0,
  spam_score REAL,
  delivery_status TEXT NOT NULL
    CHECK (delivery_status IN ('RECEIVED','QUEUED','SENT','FAILED')),
  delivery_error TEXT,
  read_at TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_listing ON messages(occurred_at DESC, id DESC);
CREATE INDEX idx_messages_domain ON messages(domain_id, occurred_at DESC);
CREATE INDEX idx_messages_thread ON messages(thread_id, occurred_at ASC);
CREATE INDEX idx_messages_from ON messages(from_address, occurred_at DESC);
CREATE UNIQUE INDEX idx_messages_rfc_id ON messages(rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

CREATE TABLE message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('TO','CC','BCC','ENVELOPE')),
  address TEXT NOT NULL,
  name TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind, position)
);
CREATE INDEX idx_recipients_address ON message_recipients(address, message_id);
CREATE INDEX idx_recipients_message ON message_recipients(message_id);

-- `message_id` is nullable: an attachment is uploaded *before* the message
-- that will carry it exists (see the staged-upload route in
-- infrastructure/http/attachments.ts), and is re-pointed at the message when
-- `sendMessage` consumes it.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  content_id TEXT,
  inline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('USER','SYSTEM')),
  system_slug TEXT UNIQUE
    CHECK (system_slug IS NULL
           OR system_slug IN ('SPAM','TRASH','ARCHIVED','STARRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tagged_at TEXT NOT NULL,
  PRIMARY KEY (message_id, tag_id)
);
CREATE INDEX idx_message_tags_tag ON message_tags(tag_id, message_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

CREATE TABLE api_key_scopes (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);
CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);

CREATE TABLE message_fetch_states (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('NOT_FETCHED','FETCHED')),
  fetched_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, api_key_id)
);
CREATE INDEX idx_fetch_states_key ON message_fetch_states(api_key_id, status);

CREATE TABLE file_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL CHECK (target IN ('ATTACHMENT','RAW_MESSAGE')),
  attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_by_api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((target = 'ATTACHMENT' AND attachment_id IS NOT NULL AND message_id IS NULL)
      OR (target = 'RAW_MESSAGE' AND message_id IS NOT NULL AND attachment_id IS NULL))
);
CREATE INDEX idx_file_links_token ON file_links(token_hash);
CREATE INDEX idx_file_links_expires_at ON file_links(expires_at);
