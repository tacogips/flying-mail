-- Ledger rows for remote messages that were deliberately NOT ingested
-- (currently: larger than the fetch size cap). Recording them keeps the
-- fetch from re-listing and re-skipping the same message on every run.
-- A skipped row has no local message, so message_id becomes nullable and
-- skip_reason names why. SQLite cannot drop NOT NULL in place, so the table
-- is rebuilt.
CREATE TABLE external_message_states_new (
  account_id TEXT NOT NULL
    REFERENCES external_mail_accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  message_id TEXT,
  fetched_at TEXT NOT NULL,
  skip_reason TEXT,
  PRIMARY KEY (account_id, remote_id),
  CHECK ((message_id IS NOT NULL AND skip_reason IS NULL)
      OR (message_id IS NULL AND skip_reason IS NOT NULL))
);

INSERT INTO external_message_states_new
  (account_id, remote_id, message_id, fetched_at, skip_reason)
SELECT account_id, remote_id, message_id, fetched_at, NULL
FROM external_message_states;

DROP TABLE external_message_states;

ALTER TABLE external_message_states_new RENAME TO external_message_states;

CREATE INDEX idx_external_message_states_message
  ON external_message_states(message_id);
