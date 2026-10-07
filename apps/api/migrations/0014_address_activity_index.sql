CREATE INDEX idx_messages_from_activity
  ON messages(from_address, direction, occurred_at);
