-- Calendar feature: calendars, events (recurrence, mentions, links,
-- attachments) and CalDAV client sync state.
--
-- SQLite cannot widen a CHECK constraint in place, so api_key_scopes is
-- rebuilt with the 0005 `_new` + rename pattern to admit the two calendar
-- capabilities. Every existing scope row is copied verbatim: mail keys must
-- come out of this migration behaving exactly as they went in.
CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN','CALENDAR_READ','CALENDAR_WRITE')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes;

DROP TABLE api_key_scopes;

ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_calendars_owner ON calendars(owner_user_id);

-- `range_start_utc` / `range_end_utc` are denormalized query columns, always
-- populated: for a non-recurring event they are its own UTC bounds, for a
-- recurring master the first occurrence's bounds. Together with
-- `recurrence_until_utc` (NULL = unbounded) they let a range query select
-- candidate rows in SQL before the domain expands them.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER,
  ends_at INTEGER,
  time_zone TEXT,
  start_date TEXT,
  end_date_exclusive TEXT,
  range_start_utc INTEGER NOT NULL,
  range_end_utc INTEGER NOT NULL,
  rrule TEXT,
  exdates_json TEXT NOT NULL DEFAULT '[]',
  recurrence_until_utc INTEGER,
  override_of_event_id TEXT REFERENCES calendar_events(id) ON DELETE CASCADE,
  recurrence_instance_start TEXT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((all_day = 0 AND starts_at IS NOT NULL AND ends_at IS NOT NULL
          AND time_zone IS NOT NULL AND start_date IS NULL
          AND end_date_exclusive IS NULL)
      OR (all_day = 1 AND start_date IS NOT NULL
          AND end_date_exclusive IS NOT NULL AND starts_at IS NULL
          AND ends_at IS NULL AND time_zone IS NULL)),
  CHECK (override_of_event_id IS NULL OR rrule IS NULL)
);

-- `ifnull(...)` rather than a plain UNIQUE on the three columns: SQLite
-- treats NULLs as distinct, so a bare unique index would let two masters
-- share a UID within one calendar -- exactly the collision CalDAV sync maps
-- events by.
CREATE UNIQUE INDEX idx_calendar_events_uid
  ON calendar_events(calendar_id, uid, ifnull(recurrence_instance_start, ''));

CREATE INDEX idx_calendar_events_range
  ON calendar_events(calendar_id, range_start_utc);

CREATE INDEX idx_calendar_events_override
  ON calendar_events(override_of_event_id);

CREATE TABLE event_mentions (
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, address)
);

CREATE INDEX idx_event_mentions_address ON event_mentions(address);

CREATE TABLE event_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_event_links_event ON event_links(event_id, position);

-- Events claim staged uploads through this join table. The `attachments`
-- table itself is untouched, so the existing R2 layout and upload route are
-- reused unchanged. Note for future authors: the migration runner splits
-- this file on every semicolon, comments included, so a semicolon may
-- appear only as a statement terminator.
CREATE TABLE event_attachments (
  event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, attachment_id)
);

CREATE UNIQUE INDEX idx_event_attachments_attachment
  ON event_attachments(attachment_id);

CREATE TABLE caldav_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  principal_url TEXT,
  home_set_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_caldav_accounts_user ON caldav_accounts(user_id);

CREATE TABLE caldav_calendars (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES caldav_accounts(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL UNIQUE REFERENCES calendars(id) ON DELETE CASCADE,
  remote_url TEXT NOT NULL,
  display_name TEXT,
  ctag TEXT,
  sync_token TEXT,
  last_synced_at TEXT
);

CREATE INDEX idx_caldav_calendars_account ON caldav_calendars(account_id);

CREATE TABLE caldav_event_states (
  event_id TEXT PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  caldav_calendar_id TEXT NOT NULL REFERENCES caldav_calendars(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  etag TEXT,
  last_synced_at TEXT NOT NULL,
  remote_unsupported INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_caldav_event_states_calendar
  ON caldav_event_states(caldav_calendar_id);

CREATE UNIQUE INDEX idx_caldav_event_states_href
  ON caldav_event_states(caldav_calendar_id, href);

-- Deleting a synced event cascades its `caldav_event_states` row away, so
-- the pending remote DELETE has to be remembered somewhere that survives it.
CREATE TABLE caldav_deletions (
  caldav_calendar_id TEXT NOT NULL REFERENCES caldav_calendars(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  etag TEXT,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (caldav_calendar_id, href)
);
