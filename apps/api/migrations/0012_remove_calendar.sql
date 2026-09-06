-- Retire the calendar schema without rewriting its historical migrations.
-- Blob deletion is deferred through a durable queue because SQL migrations
-- cannot call the configured object store. Only event-owned staged uploads
-- are queued and removed. Message-backed attachments are retained regardless
-- of MIME type, including text/calendar.
CREATE TABLE blob_cleanup_queue (
  attachment_id TEXT PRIMARY KEY,
  blob_key TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);

INSERT INTO blob_cleanup_queue (attachment_id, blob_key, enqueued_at)
SELECT attachments.id, attachments.blob_key, CURRENT_TIMESTAMP
FROM attachments
INNER JOIN event_attachments
  ON event_attachments.attachment_id = attachments.id
WHERE attachments.message_id IS NULL;

DELETE FROM file_links
WHERE attachment_id IN (SELECT attachment_id FROM blob_cleanup_queue);

DELETE FROM attachments
WHERE id IN (SELECT attachment_id FROM blob_cleanup_queue);

DROP TABLE caldav_deletions;
DROP TABLE caldav_event_states;
DROP TABLE caldav_calendars;
DROP TABLE caldav_accounts;
DROP TABLE event_mentions;
DROP TABLE event_links;
DROP TABLE event_attachments;
DROP TABLE calendar_events;
DROP TABLE calendars;
DROP TABLE user_calendar_permissions;

-- SQLite cannot narrow a CHECK constraint in place. Rebuild the scope table,
-- filtering the retired values while preserving every current capability.
CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN','TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE','CONTACT_READ','CONTACT_WRITE')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes
WHERE capability NOT IN ('CALENDAR_READ','CALENDAR_WRITE');

DROP TABLE api_key_scopes;

ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);
