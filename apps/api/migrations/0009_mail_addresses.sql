-- Explicitly provisioned mailboxes on a managed domain.
--
-- Until now a domain was either catch-all, or accepted only local parts the
-- ingest path could *infer* from message history (`hasKnownLocalPart`: an
-- address counted as real once it had sent or received something). That
-- meant a mailbox could not be created before its first message, could not
-- be listed, and could not be closed. This table makes the set of real
-- addresses something the operator states.
--
-- Delivery precedence on the ingest path. An ACTIVE row accepts. A DISABLED
-- row rejects, even on a catch-all domain, which is the only way to close
-- one mailbox without closing the whole domain. No row at all falls back to
-- the previous behaviour, so domains that predate this migration keep
-- delivering exactly as they did.
--
-- NOTE for future authors: the migration runner splits statements on the
-- statement terminator with no awareness of comments or string literals, so
-- writing that character anywhere in this file, a comment included, would
-- silently cut a statement in half.
CREATE TABLE mail_addresses (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  -- Denormalized `local_part@domain`, so the ingest hot path is one indexed
  -- equality match rather than a join plus string surgery per message.
  address TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Addresses are stored already lower-cased by the domain layer, so a plain
-- unique index is enough and the ingest lookup can stay a plain equality.
CREATE UNIQUE INDEX idx_mail_addresses_address ON mail_addresses(address);

CREATE UNIQUE INDEX idx_mail_addresses_local_part
  ON mail_addresses(domain_id, local_part);

CREATE INDEX idx_mail_addresses_domain
  ON mail_addresses(domain_id, status);
