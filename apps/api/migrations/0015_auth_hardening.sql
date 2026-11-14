-- Separate invitation throttling and record the first successful sign-in.
ALTER TABLE email_auth_challenges
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'LOGIN'
  CHECK (purpose IN ('LOGIN', 'INVITATION'));

ALTER TABLE users ADD COLUMN invitation_accepted_at TEXT;

UPDATE users SET invitation_accepted_at = created_at;

CREATE INDEX idx_email_auth_challenges_email_purpose_created
  ON email_auth_challenges(email, purpose, created_at);
