ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'OTHER';

CREATE INDEX idx_attachments_kind ON attachments(kind, message_id);
