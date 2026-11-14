-- External mail accounts: JMAP/POP3 fetch and SMTP submission bound to one
-- managed mail address (0009). One managed address can have at most one
-- external account (enforced by the unique index on `mail_address_id`
-- below), and one external account has exactly one fetch protocol and
-- optionally one SMTP submission config.
--
-- `fetch_config`/`smtp_config` hold only non-secret connection parameters as
-- JSON text, and the ciphertexts get their own dedicated columns rather than
-- living inside that JSON, so a future "rotate credential key" migration can
-- find every ciphertext with a plain column scan instead of parsing JSON in
-- every row.
--
-- NOTE for future authors: the migration runner splits statements on the
-- statement terminator with no awareness of comments or string literals, so
-- writing that character anywhere in this file, a comment included, would
-- silently cut a statement in half.
CREATE TABLE external_mail_accounts (
  id TEXT PRIMARY KEY,
  mail_address_id TEXT NOT NULL UNIQUE
    REFERENCES mail_addresses(id) ON DELETE CASCADE,
  external_address TEXT NOT NULL,
  display_name TEXT,
  fetch_kind TEXT NOT NULL CHECK (fetch_kind IN ('JMAP','POP3')),
  fetch_config TEXT NOT NULL,
  fetch_password_ciphertext TEXT NOT NULL,
  smtp_config TEXT,
  smtp_password_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  last_fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_external_mail_accounts_mail_address
  ON external_mail_accounts(mail_address_id);

-- Dedupe ledger: one row per fetched remote message, keyed by the protocol's
-- own id (JMAP Email id / POP3 UIDL) so a re-fetch never double-ingests.
CREATE TABLE external_message_states (
  account_id TEXT NOT NULL
    REFERENCES external_mail_accounts(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, remote_id)
);

CREATE INDEX idx_external_message_states_message
  ON external_message_states(message_id);
