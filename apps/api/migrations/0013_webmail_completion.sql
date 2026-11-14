ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT;

DROP INDEX IF EXISTS idx_messages_rfc_id;
CREATE UNIQUE INDEX idx_messages_rfc_id_direction_domain
  ON messages(rfc_message_id, direction, domain_id)
  WHERE rfc_message_id IS NOT NULL;

CREATE INDEX idx_attachments_blob_key ON attachments(blob_key);
