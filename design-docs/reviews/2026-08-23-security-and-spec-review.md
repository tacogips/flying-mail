# Security and Specification Review -- 2026-08-23

Scope: full pass over the design documents and every package, focused on
specification breakdowns and security problems, per the review request.
Each finding below was verified against source before fixing, fixed in the
same session, and covered by a regression test.

## Findings and fixes

### 1. File-link download race could exceed maxDownloads (security)

`resolveFileLink` did read-check-save. D1 has no interactive transactions,
so two concurrent downloads of a `maxDownloads: 1` link both read
`downloadCount = 0`, both passed the check, and both got the file. Fixed by
replacing the sequence with one atomic conditional UPDATE
(`FileLinkRepository.consumeByTokenHash`): the WHERE clause carries every
usability condition, so of N racing requests exactly one sees
`rowsAffected = 1`.
Test: `file-links.test.ts` "concurrent downloads cannot exceed maxDownloads".

### 2. Bootstrap race could create two admins (security)

`bootstrapAdmin` did `count()` then `save()`. Two concurrent calls on a
fresh instance both observed an empty table and both became root. Fixed
with `UserRepository.createFirstUser`, an
`INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)` whose
emptiness check lives inside the statement itself.
Residual (accepted, documented): on a fresh public deployment, whoever
calls bootstrap first owns the instance. This window is inherent to
shell-less bootstrap; the mitigation is operational -- bootstrap
immediately after deploying.
Test: `auth.test.ts` "two concurrent bootstraps produce exactly one admin".

### 3. Login-link issuance had no throttle (security)

`requestEmailAuth` sent a mail per call, unbounded: a mail bomb against a
known user, burning provider send quota. Fixed with a per-address cap of 3
challenges per 15-minute window. The response stays uniformly `true` when
throttled -- a distinguishable answer would reintroduce the
user-enumeration oracle the endpoint's uniform response exists to close.
Tests: `auth.test.ts` login link throttle block.

### 4. Web client logout never invalidated the server session (spec break)

The `Logout` mutation existed in the SDL and the client's documents file,
but the UI only cleared local state -- the HttpOnly session cookie stayed
valid until natural expiry. Fixed: `store.logout()` calls the mutation
(best-effort) before clearing local state.

### 5. Non-catch-all domains could never receive mail (spec break)

An address only became "known" via an existing `message_recipients` row --
but the only way to get such a row was to have already received a message.
Deadlock: a fresh non-catch-all domain rejected everything forever. Fixed:
`hasKnownLocalPart` now also matches `messages.from_address`, so sending
once from a mailbox is the act that establishes it.
Test: `repositories.test.ts` "sending from an address establishes it".

### 6. Spam phrase scoring was designed but never wired (spec break)

`scoreSpam` accepted a phrase list; the design names it instance config;
nothing supplied it. Fixed: `MAILCAL_SPAM_PHRASES` (comma-separated) flows
env -> composition config -> `InstanceConfig.spamPhrases` -> ingest.

### 7. Staged uploads and expired file links accumulated forever (hygiene)

Attachments staged for sending but never bound to a message kept their D1
rows and R2 blobs indefinitely; expired file links kept their rows. Fixed:
the once-per-isolate expiry sweep now also deletes expired file links and
staged uploads older than 24 hours -- blobs first, so a failed blob delete
leaves the row as a marker for the next sweep rather than stranding an
unreferenced blob.
Test: `auth.test.ts` "reclaims expired links and stale staged uploads".

## Reviewed and judged sound (no change)

- Scope probing: out-of-scope reads uniformly return NOT_FOUND, never
  FORBIDDEN, so an API key cannot map which ids exist outside its scope.
- Credential storage: SHA-256 of high-entropy random tokens (API keys,
  sessions, file links, auth challenges); plaintext returned exactly once.
- Privilege escalation: creating or extending an API key requires the
  grantor's own scopes to cover every granted scope.
- HTML mail: DOMPurify allowlist plus empty-`sandbox` srcdoc iframe;
  downloads served with `nosniff` and `CSP: sandbox`, inline rendering
  restricted to a safe-type allowlist.
- Header injection: CR/LF and `X-`-prefix guard on caller-supplied custom
  headers at send time.
- CSRF: Origin backstop applies to cookie-authenticated non-safe methods
  only; bearer-token requests are exempt by design.
- Address patterns: custom linear-time glob, deliberately not regex (no
  ReDoS surface); LIKE conversion escapes `%`/`_`.
- Pagination: keyset on `(occurred_at, id)`, immune to shift under
  concurrent inserts; malformed cursors treated as page one.
- Attachment `kind` is classification metadata only; download-time
  security decisions re-derive from the stored content type.
