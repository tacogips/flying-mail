-- Per-user calendar rules.
--
-- Before this, a USER viewer's calendar access was hardcoded to
-- "is an admin, or owns the calendar". That conflated two separate things:
-- an admin's power to *administer* permissions, and an admin's *access* to
-- the data. Mail already separates them -- a DENY beats an admin's default
-- access to every mailbox -- and calendars now do the same.
--
-- A rule names a calendar *owner* rather than a calendar, because owner is
-- the axis calendar authorization already turns on: an API key's
-- CALENDAR_READ scope is matched against the owner's account email, so a
-- user rule naming an owner expresses the same decision for the other
-- credential kind. `owner_user_id` NULL means every owner.
--
-- Depends only on `users`, so it is independent of the calendar tables in
-- 0006 and can be applied to a deployment whose calendars are still empty.
CREATE TABLE user_calendar_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('CALENDAR_READ','CALENDAR_WRITE')),
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- `ifnull(owner_user_id, '')` is what makes the all-owners row participate:
-- SQLite treats distinct NULLs as unequal, so without it a second
-- all-owners rule for the same capability could stack on the first and the
-- pair's outcome would depend on evaluation order.
CREATE UNIQUE INDEX idx_user_calendar_permissions_rule
  ON user_calendar_permissions(
    user_id,
    capability,
    ifnull(owner_user_id, '')
  );

CREATE INDEX idx_user_calendar_permissions_user
  ON user_calendar_permissions(user_id, capability);

CREATE INDEX idx_user_calendar_permissions_owner
  ON user_calendar_permissions(owner_user_id);
