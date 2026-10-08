CREATE TABLE mail_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'DRAFT_SAVED', 'DRAFT_DELETED')),
  message_id TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  addresses TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_mail_events_occurred_at ON mail_events(occurred_at);

CREATE TABLE mail_event_log_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch TEXT NOT NULL,
  pruned_through_seq INTEGER NOT NULL DEFAULT 0
);

INSERT INTO mail_event_log_state (id, epoch, pruned_through_seq) VALUES (1, lower(hex(randomblob(8))), 0);
