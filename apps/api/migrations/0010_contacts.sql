-- Contacts feature: address books owned by provisioned mail addresses,
-- their contacts (with position-ordered child rows for emails, phones,
-- postal addresses and URLs), and CardDAV client sync state.
--
-- SQLite cannot widen a CHECK constraint in place, so api_key_scopes is
-- rebuilt with the same `_new` + rename pattern migrations 0005, 0006 and
-- 0007 used, admitting the two contact capabilities. Every existing scope
-- row is copied verbatim: mail, calendar and template keys must come out of
-- this migration behaving exactly as they went in.
CREATE TABLE api_key_scopes_new (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN','CALENDAR_READ','CALENDAR_WRITE','TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE','CONTACT_READ','CONTACT_WRITE')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);

INSERT INTO api_key_scopes_new
SELECT id, api_key_id, capability, domain_id, address_pattern
FROM api_key_scopes;

DROP TABLE api_key_scopes;

ALTER TABLE api_key_scopes_new RENAME TO api_key_scopes;

CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);

-- One or more books per mail address. The partial unique index below is
-- what makes "one default book per address" a repository-surfaced CONFLICT
-- rather than an application-only check: SQLite supports indexing a subset
-- of rows, so only the `is_default = 1` rows compete for uniqueness.
CREATE TABLE address_books (
  id TEXT PRIMARY KEY,
  mail_address_id TEXT NOT NULL REFERENCES mail_addresses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_address_books_default
  ON address_books(mail_address_id)
  WHERE is_default = 1;

CREATE INDEX idx_address_books_mail_address
  ON address_books(mail_address_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  address_book_id TEXT NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  display_name TEXT NOT NULL,
  given_name TEXT,
  family_name TEXT,
  nickname TEXT,
  organization TEXT,
  title TEXT,
  note TEXT,
  birthday TEXT,
  extra_vcard_lines TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_contacts_uid ON contacts(address_book_id, uid);

CREATE INDEX idx_contacts_address_book ON contacts(address_book_id);

-- Emails/phones/addresses/URLs are child tables rather than JSON because the
-- cross-address "who is this?" view needs an indexed reverse lookup by
-- email, which a JSON blob cannot offer without parsing every row.
CREATE TABLE contact_emails (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (contact_id, position)
);

CREATE INDEX idx_contact_emails_address ON contact_emails(address);

CREATE TABLE contact_phones (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  number TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (contact_id, position)
);

CREATE TABLE contact_postal_addresses (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  formatted TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (contact_id, position)
);

CREATE TABLE contact_urls (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (contact_id, position)
);

-- CardDAV client sync state, same shape as the CalDAV tables in 0006: a
-- CardDAV account belongs to a user (it holds that user's remote
-- credential), a book link binds one local address book to one remote
-- collection, a contact state tracks the remote href/etag per local
-- contact, and a tombstone survives the contact-state row's own cascade
-- delete so the pending remote DELETE is not forgotten.
CREATE TABLE carddav_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  principal_url TEXT,
  home_set_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_carddav_accounts_user ON carddav_accounts(user_id);

CREATE TABLE carddav_book_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES carddav_accounts(id) ON DELETE CASCADE,
  address_book_id TEXT NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  remote_url TEXT NOT NULL,
  display_name TEXT,
  ctag TEXT,
  sync_token TEXT,
  last_synced_at TEXT
);

CREATE UNIQUE INDEX idx_carddav_book_links_remote
  ON carddav_book_links(account_id, remote_url);

CREATE UNIQUE INDEX idx_carddav_book_links_book
  ON carddav_book_links(address_book_id, account_id);

CREATE INDEX idx_carddav_book_links_account
  ON carddav_book_links(account_id);

CREATE TABLE carddav_contact_states (
  contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  carddav_book_id TEXT NOT NULL REFERENCES carddav_book_links(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  etag TEXT,
  last_synced_at TEXT NOT NULL,
  remote_unsupported INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_carddav_contact_states_book
  ON carddav_contact_states(carddav_book_id);

CREATE UNIQUE INDEX idx_carddav_contact_states_href
  ON carddav_contact_states(carddav_book_id, href);

-- Deleting a synced contact cascades its `carddav_contact_states` row away,
-- so the pending remote DELETE has to be remembered somewhere that
-- survives it.
CREATE TABLE carddav_deletions (
  carddav_book_id TEXT NOT NULL REFERENCES carddav_book_links(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  etag TEXT,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (carddav_book_id, href)
);
