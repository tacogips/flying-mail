# Storage and File Links

## Ports

Two ports isolate every storage decision, exactly as in the reference project:

```typescript
interface SqlDatabase {
  query<T>(sql: string, params?: readonly SqlValue[]): Promise<readonly T[]>;
  execute(sql: string, params?: readonly SqlValue[]): Promise<{ rowsAffected: number }>;
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

interface BlobStore {
  put(key: string, body: Uint8Array | ReadableStream,
      opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}
```

There is no interactive `transaction(fn)` API because D1 does not support one.
`batch()` is the atomic primitive available on both D1 and SQLite, and any use
case needing read-then-write consistency (message ingest, tag application
across many messages) composes its writes into a single `batch()`.

| Backend | SQL | Blob |
|---------|-----|------|
| Workers (production) | D1 (`DB`) | R2 (`BLOB`) |
| Local Bun/Node | libsql file (`./data/mailcal.db`) | S3/MinIO or memory |
| Tests | in-memory libsql | in-memory map |

## R2 key layout

| Key | Contents |
|-----|----------|
| `raw/<messageId>.eml` | Untouched RFC 5322 source of an inbound message, and the generated source of an outbound one |
| `att/<attachmentId>/<sanitizedFileName>` | Decoded attachment body |

Keys are derived from IDs the application generated, so a retried ingest
overwrites rather than duplicates. Deleting a message deletes its raw object
and every attachment object in the same use case, after the D1 rows are gone,
so a partial failure leaves orphaned bytes (cheap, reclaimable) rather than
rows pointing at missing objects.

## D1 schema

```sql
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','DISABLED')),
  catch_all INTEGER NOT NULL DEFAULT 1,
  verification_token TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  thread_id TEXT NOT NULL,
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  from_address TEXT NOT NULL,
  from_name TEXT,
  text_body TEXT,
  html_body TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  raw_key TEXT,
  raw_size INTEGER NOT NULL DEFAULT 0,
  spam_score REAL,
  delivery_status TEXT NOT NULL
    CHECK (delivery_status IN ('RECEIVED','QUEUED','SENT','FAILED')),
  delivery_error TEXT,
  read_at TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_messages_listing ON messages(occurred_at DESC, id DESC);
CREATE INDEX idx_messages_domain  ON messages(domain_id, occurred_at DESC);
CREATE INDEX idx_messages_thread  ON messages(thread_id, occurred_at ASC);
CREATE UNIQUE INDEX idx_messages_rfc_id ON messages(rfc_message_id)
  WHERE rfc_message_id IS NOT NULL;

CREATE TABLE message_recipients (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('TO','CC','BCC','ENVELOPE')),
  address TEXT NOT NULL,
  name TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (message_id, kind, position)
);
CREATE INDEX idx_recipients_address ON message_recipients(address, message_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  content_id TEXT,
  inline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('USER','SYSTEM')),
  system_slug TEXT UNIQUE
    CHECK (system_slug IS NULL
           OR system_slug IN ('SPAM','TRASH','ARCHIVED','STARRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE message_tags (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tagged_at TEXT NOT NULL,
  PRIMARY KEY (message_id, tag_id)
);
CREATE INDEX idx_message_tags_tag ON message_tags(tag_id, message_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

CREATE TABLE api_key_scopes (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('MAIL_READ','MAIL_SEND','MAIL_MANAGE','FILE_LINK','DOMAIN_ADMIN','KEY_ADMIN')),
  domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address_pattern TEXT NOT NULL DEFAULT '*'
);
CREATE INDEX idx_api_key_scopes_key ON api_key_scopes(api_key_id);

CREATE TABLE message_fetch_states (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('NOT_FETCHED','FETCHED')),
  fetched_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, api_key_id)
);
CREATE INDEX idx_fetch_states_key ON message_fetch_states(api_key_id, status);

CREATE TABLE file_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL CHECK (target IN ('ATTACHMENT','RAW_MESSAGE')),
  attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_by_api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((target = 'ATTACHMENT' AND attachment_id IS NOT NULL AND message_id IS NULL)
      OR (target = 'RAW_MESSAGE' AND message_id IS NOT NULL AND attachment_id IS NULL))
);
CREATE INDEX idx_file_links_token ON file_links(token_hash);
```

`users`, `sessions` and `email_auth_challenges` mirror the reference project's
shapes and are created by the same initial migration.

## Temp file links

A file link is a bearer capability URL. It exists so an AI agent can hand a
plain HTTPS URL to a tool, a human, or another service without also handing
over its API key -- and so that the URL stops working shortly afterwards.

```
mutation { createAttachmentLink(attachmentId: "...", ttlSeconds: 900,
                                maxDownloads: 3) { url expiresAt } }
-> { "url": "https://mail.example.com/files/8fK2...", ... }
```

Properties:

- The token is 32 random bytes, base64url-encoded. Only its SHA-256 hash is
  stored, so a database read never yields a working URL.
- `GET /files/:token` is **unauthenticated by design** -- the token is the
  credential. It never consults the session cookie or bearer header, so a
  link behaves identically for an agent, a shell, and a browser.
- Minting requires `FILE_LINK` **plus** read authorization on the owning
  message, so a link can never widen what its creator could already reach.
- Expiry (`expiresAt`, default 1 hour, capped at 7 days) and an optional
  `maxDownloads` are both enforced on every request; the download counter is
  incremented before the body is streamed.
- Every failure mode -- unknown token, expired, revoked, exhausted, missing
  blob, or an unexpected storage error -- collapses to the same `404`, so the
  route never reveals whether a token ever existed.
- Responses carry `nosniff`, `Content-Security-Policy: sandbox` and an
  `attachment` disposition outside the inline-safe allowlist, identical to the
  authenticated attachment route.

Expired links are swept opportunistically (once per isolate, registered with
`ctx.waitUntil()`), never on the request's critical path.


## Concurrency and cleanup (updated 2026-08-23)

- **Atomic consumption.** Download-count enforcement is one conditional
  `UPDATE` (`consumeByTokenHash`): the WHERE clause carries revocation,
  expiry and the `max_downloads` guard, so concurrent downloads of a
  one-download link admit exactly one request. D1 has no interactive
  transactions; the row's own predicate is the only available lock.
- **Sweep.** The once-per-isolate expiry sweep deletes expired sessions,
  auth challenges and file links, plus staged attachment uploads older
  than 24 hours that were never bound to a send -- blobs first, so a
  failed blob delete leaves the row as a marker for the next sweep rather
  than stranding an unreferenced blob.
- **Attachment kind.** `attachments.kind` is classified once at receive
  (or upload) time by `classifyAttachmentKind(contentType, fileName)` and
  stored (migration 0003), so kind filters are stable even if the
  classification table later changes. It is search metadata only; the
  download routes make security decisions from the stored content type.
