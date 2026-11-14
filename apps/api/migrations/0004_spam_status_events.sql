-- Spam verdicts become first-class rows instead of a system tag. Presence
-- of a row is the verdict, and score and marker are the metadata a tag
-- could never carry.
CREATE TABLE message_spam (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  score REAL,
  marked_by TEXT NOT NULL CHECK (marked_by IN ('SYSTEM','USER','RULE')),
  marked_at TEXT NOT NULL
);

-- Backfill from the retiring SPAM system tag, then remove it. Historic
-- system marks and hand marks are indistinguishable in the tag model, so
-- everything backfills as SYSTEM with the score the scorer stored.
INSERT INTO message_spam (message_id, score, marked_by, marked_at)
SELECT mt.message_id, m.spam_score, 'SYSTEM', mt.tagged_at
FROM message_tags mt
JOIN tags t ON t.id = mt.tag_id
JOIN messages m ON m.id = mt.message_id
WHERE t.system_slug = 'SPAM';

DELETE FROM message_tags
WHERE tag_id IN (SELECT id FROM tags WHERE system_slug = 'SPAM');

DELETE FROM tags WHERE system_slug = 'SPAM';

-- Coarse mail lifecycle. DRAFT is the new state, SENT/RECEIVED backfill
-- from direction. delivery_status keeps carrying transport detail and is
-- only meaningful once status leaves DRAFT.
ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'RECEIVED'
  CHECK (status IN ('DRAFT','SENT','RECEIVED'));

UPDATE messages SET status = 'SENT' WHERE direction = 'OUTBOUND';

CREATE INDEX idx_messages_status ON messages(status, occurred_at DESC);

-- Events attached to a message: deadlines, reminders, follow-ups. A mail
-- that needs an answer by 10/1 gets (kind DEADLINE, due_at 10/1,
-- title "reply"). Multiple events per message by design.
CREATE TABLE message_events (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('DEADLINE','REMINDER','FOLLOW_UP','OTHER')),
  due_at TEXT,
  title TEXT NOT NULL,
  note TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_message_events_message ON message_events(message_id, due_at);
CREATE INDEX idx_message_events_due ON message_events(due_at, completed_at);

-- Mailing-list traffic is a field, not a tag: an intrinsic property
-- detected deterministically from list headers (or asserted by a rule),
-- carrying data (the List-Id) and immune to tag renames or deletions.
ALTER TABLE messages ADD COLUMN list_id TEXT;
ALTER TABLE messages ADD COLUMN is_mailing_list INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_mailing_list
  ON messages(is_mailing_list, occurred_at DESC);

-- Operator-defined ingest rules: per sender address or sender domain (or
-- subject / list id), exact, substring or regex match, and a verdict --
-- mark spam, flag as mailing list, or apply a tag. domain_id null means
-- the rule applies to every receiving domain.
CREATE TABLE classification_rules (
  id TEXT PRIMARY KEY,
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  field TEXT NOT NULL
    CHECK (field IN ('SENDER_ADDRESS','SENDER_DOMAIN','SUBJECT','LIST_ID')),
  matcher TEXT NOT NULL CHECK (matcher IN ('EXACT','CONTAINS','REGEX')),
  pattern TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('SPAM','MAILING_LIST','TAG')),
  tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_classification_rules_domain
  ON classification_rules(domain_id, enabled);
