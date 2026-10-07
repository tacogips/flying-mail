# Webmail Completion: Compose, Forward, Drafts, Multi-Domain Delivery

Status: Approved for implementation planning (2026-10-07)

This document closes the gaps between the existing mail backend and a
production-ready multi-domain webmail. One account sends and receives for
several managed domains (target test domains `tacoserve.online` and
`mutvar-test.online`) from one unified UI. GraphQL carries every data
operation; REST stays limited to binary attachment upload/download and
`/files/:token`.

It builds on, and does not replace, `design-mail-pipeline.md`,
`design-graphql-api.md`, `design-storage-and-file-links.md`,
`design-web-client.md` and `design-domain-model.md`. Where this document
changes a rule stated there, this document wins and the older document
carries a pointer here.

## 1. Audit baseline (verified against the code, 2026-10-07)

| # | Area | Present | Gap |
|---|------|---------|-----|
| 1 | Compose | From select over `viewer.sendableAddresses`, To, Cc, Subject, plain textarea, multi-file upload | No Bcc, no HTML editing, no attachment removal, no progress, no autosave; pattern entries such as `*@domain` are offered as literal From values |
| 2 | Forward | Client-side `Fwd:` subject and text "Forwarded message" block (`apps/web/src/lib/quote-reply.ts`) | Original attachments not carried; no API input; no forward linkage; HTML ignored |
| 3 | Reply / reply-all | `buildReplyRecipients` (`apps/web/src/lib/address-format.ts`), `inReplyToMessageId` threading on the server | Logic only in the UI; Reply-To ignored; quote is text-only; `resolveThreadContext` does not check read access on the parent (`send.ts:231`) |
| 4 | Drafts | `saveDraft` / `sendDraft`, Drafts folder (`statuses: [DRAFT]`) | No `deleteDraft`; reopen drops attachments, reply linkage and HTML; update ignores `inReplyToMessageId`, never moves `domain_id`, only adds attachments; `sendDraft` loses `rfc_message_id` (upsert omits it, `message-repository.ts:214-233`) and delivers without attachments; no guard against save/send races |
| 5 | Attachments REST | `POST /api/attachments` (one file per request, 5 MiB, 413), `GET /api/attachments/:id` with RFC 5987 `filename*`, nosniff, CSP sandbox, inline-safe allowlist | 413 body has no machine code; limits not discoverable; **any existing attachment id can be bound to a new message, which moves it off its original message** (`send.ts:147-177`, `message-repository.ts:390-411`) |
| 6 | HTML receive | DOMPurify + sandboxed `srcdoc` iframe without `allow-scripts`, CSP `default-src 'none'`, cid rewrite to data URIs, remote-image block with "Load images", text fallback; postal-mime tests cover alternative and related | Inline attachments also render as download tiles |
| 7 | Outbound adapter | Builder-form binding, per-recipient fan-out (`cloudflare-email.ts:134-152`); REST adapter | Binding path drops attachments, cc/bcc semantics, threading headers; no Reply-To anywhere; no provider error-code mapping; MIME builder emits a `Bcc:` header that the SMTP relay transmits (`mime-builder.ts:48-50`, `send.ts:302-333`) |
| 8 | Inbound | Catch-all per ACTIVE domain plus `mail_addresses` precedence, SMTP-time reject | Multi-recipient mail records only the first envelope recipient; dedup by global `rfc_message_id` swallows the inbound copy of our own outbound mail to another managed mailbox; DUPLICATE leaves an orphaned raw blob |
| 9 | Admin UI | `/settings/domains` (create, DNS table with `_mailcal` TXT, verify, enable/disable, mailboxes), `/settings/users` (ALLOW/DENY rules) | None beyond verification tests |
| 10 | Branding | Web title, login, sidebar, CLI help say flying-mail | README "Deployed instance" section is stale; nothing else |
| 11 | Calendar | No calendar code paths remain; `packages/adapter/src/caldav` and `ics` are empty untracked directories | Remove the two empty directories only |
| 12 | API docs | Partial schema in `design-graphql-api.md` | Stale signatures, no complete operation catalogue, no curl examples |

The intake's calendar hits are not calendar features: `AttachmentKind.CALENDAR`
classifies `text/calendar` / `.ics` mail attachments, `sameCalendarDay` is
date arithmetic, and `calendarserver.org/ns/` is the CardDAV `getctag`
namespace. All three stay (see Decision D11).

## 2. Data model changes (migration `0013_webmail_completion.sql`)

Existing migrations are never edited. The runner splits on the statement
terminator, so the new file must not contain that character inside comments.

| Change | Purpose |
|--------|---------|
| `messages.reply_to TEXT` (nullable, first address only) | Inbound: parsed `Reply-To`; outbound/draft: requested Reply-To |
| `messages.forwarded_from_message_id TEXT` (nullable, no FK) | Forward linkage on drafts and sent mail; survives source deletion as a dangling id |
| Drop `idx_messages_rfc_id`; create unique `idx_messages_rfc_id_direction_domain ON messages(rfc_message_id, direction, domain_id) WHERE rfc_message_id IS NOT NULL` | Allows one INBOUND row per recipient domain (D8), and lets the inbound copy of our own outbound mail coexist with the outbound row. Outbound rows keep their single from-domain `domain_id`, so the index still guarantees one outbound row per Message-ID in practice |
| `CREATE INDEX idx_attachments_blob_key ON attachments(blob_key)` | Reference check before any blob delete (shared blobs, section 4) |

Domain entity `Message` gains `replyTo: EmailAddress | null` and
`forwardedFromMessageId: MessageId | null`. No other table changes.

## 3. GraphQL surface delta

New SDL lives in a new extension document
`packages/infrastructure/src/graphql/schema-compose.graphql.ts` (using
`extend type` / `extend input`) because `schema.graphql.ts` is already 841
lines. Resolvers go in a new `resolvers/compose.ts` (`mutation.ts` is 740).

```graphql
enum ComposeMode { REPLY REPLY_ALL FORWARD }

extend input SendMessageInput {
  replyTo: String
  forwardedFromMessageId: ID
  forwardAttachmentIds: [ID!]
}
extend input SaveDraftInput {
  replyTo: String
  forwardedFromMessageId: ID
  forwardAttachmentIds: [ID!]
}
extend type Message {
  replyTo: String
  forwardedFromMessageId: ID
}
extend type Viewer {
  "ACTIVE provisioned addresses the viewer may MAIL_READ, across all domains."
  readableAddresses: [String!]!
}

type ComposePrefill {
  from: String              # null when the viewer has no sendable address
  to: [String!]!
  cc: [String!]!
  subject: String!
  inReplyToMessageId: ID    # REPLY / REPLY_ALL
  forwardedFromMessageId: ID # FORWARD
  forwardAttachments: [Attachment!]!  # FORWARD: every attachment of the source
  quotedText: String!
  quotedHtml: String        # null when the source has no HTML body
}

type MailLimits {
  maxAttachmentBytes: Int!        # per uploaded file (5 MiB)
  maxOutboundTotalBytes: Int!     # all attachments of one send (5 MiB)
  maxAttachmentsPerMessage: Int!  # 32
  maxRecipientsPerMessage: Int!   # 50, to + cc + bcc
}

extend type Query {
  composeFromMessage(messageId: ID!, mode: ComposeMode!): ComposePrefill!
  mailLimits: MailLimits!
}
extend type Mutation {
  deleteDraft(id: ID!): Boolean!
}
```

`apps/web/src/api/schema-types.ts` is hand-mirrored and must be updated in
the same change as the SDL.

## 4. Attachments: binding, forwarding, shared blobs

### Binding rules (all send and draft paths)

- `attachmentIds` may reference only (a) a staged upload (`message_id IS
  NULL`) or (b) an attachment already bound to the draft being saved.
  Anything else fails `NOT_FOUND` with `field: "attachmentIds"`. This closes
  the existing move-an-attachment hole.
- `SaveDraftInput.attachmentIds` is the **complete** set of the draft's own
  attachments after the save. Rows on the draft that are absent are deleted
  (row, then blob if unreferenced). `null`/omitted means "no attachments".
- Limits (32 files, 5 MiB total including forwarded copies) are checked
  before any write and fail `BAD_USER_INPUT`.

### Forwarding original attachments

- `forwardAttachmentIds` requires `forwardedFromMessageId`; otherwise
  `BAD_USER_INPUT`.
- Authorization is exactly "may read the source message":
  `loadReadableMessage(viewer, forwardedFromMessageId, MAIL_READ)` must
  return the message, else `NOT_FOUND` (`field: "forwardedFromMessageId"`).
  A draft cannot be a forward source (`BAD_USER_INPUT`). Each
  `forwardAttachmentIds` entry must belong to that source, else `NOT_FOUND`
  (`field: "forwardAttachmentIds"`). MAIL_SEND on `from` is checked as today;
  API keys need both scopes.
- Each forwarded attachment becomes a **new attachment row** on the target
  message with a new id, the same `blob_key`, `file_name`, `content_type`,
  `size`, `kind`, and `inline = false`, `content_id = NULL` (inline images
  of the source travel as ordinary attachments, because the composed quote
  drops cid images, D7). No R2 write occurs.
- Order within one save: first apply the `attachmentIds` replacement set,
  then create forward copies.
- Idempotency for autosave: a forward copy is skipped when the target draft
  already has an attachment row with the same `blob_key`.
- The save response returns the copies' new ids. Clients send
  `forwardAttachmentIds` only until they have adopted those ids, and from
  then on send them in `attachmentIds`, so removing one is an ordinary
  attachment removal. Removing a forwarded chip before the first save just
  drops its id from `forwardAttachmentIds`.
- `forwarded_from_message_id` is persisted on the draft/message.

### Shared-blob deletion rule

Every path that deletes attachment rows (message purge, `deleteDraft`,
removal from a draft, the 24-hour staged-upload sweep) collects the blob keys
first, deletes the rows, and deletes a blob only when no remaining
`attachments` row references its `blob_key`. A failed blob delete leaves an
orphan (cheap), never a dangling row.

### REST adjustments

- `POST /api/attachments` stays one file per request. The 413 body becomes
  `{ "error": "...", "code": "PAYLOAD_TOO_LARGE", "maxBytes": 5242880 }`.
- `GET /api/attachments/:id` is unchanged; tests must pin `Content-Type`,
  `Content-Disposition` with `filename*=UTF-8''...` for a non-ASCII name, and
  the ASCII fallback.
- Attachment ids are generated with a CSPRNG (verify; staged uploads have no
  owner column, so unguessability is the protection for staged ids).

## 5. Reply, reply-all and forward prefill

A pure application module (`packages/application/src/usecases/compose-prefill.ts`)
computes the prefill. `composeFromMessage` exposes it, and the web client
uses it, so the UI and API cannot diverge. Authorization:
`loadReadableMessage` (else `NOT_FOUND`); a DRAFT source is `BAD_USER_INPUT`.

**Own addresses** = the viewer's concrete sendable addresses, plus the
chosen `from`, compared case-insensitively. Pattern entries match by the
`AddressPattern` matcher. So for an ADMIN holding `*@domain`, every address
on that managed domain counts as an own address. That is intended for a
single-account deployment.

**Default From**, first match wins:
1. Source is OUTBOUND: the source `from`.
2. The source's ENVELOPE recipient, if it is an own address.
3. The first source TO/CC address that is an own address.
4. The first concrete sendable address; else `null`.

**Recipients**

| Mode | Inbound source | Outbound source |
|------|----------------|-----------------|
| REPLY | To = `replyTo ?? from` | To = source TO list |
| REPLY_ALL | To = `replyTo ?? from`; Cc = source TO + CC | To = source TO; Cc = source CC |
| FORWARD | empty | empty |

Every list is de-duplicated case-insensitively, never contains BCC or
ENVELOPE kinds, and REPLY_ALL removes own addresses from To and Cc. If
removal leaves an inbound REPLY_ALL To empty, fall back to the source `from`.

**Subject**: `Re: ` / `Fwd: ` added once (the existing non-stacking rules in
`quote-reply.ts` move server-side).

**Threading**: REPLY/REPLY_ALL return `inReplyToMessageId = source.id`. The
server derives `In-Reply-To`/`References` on send/save, as today. FORWARD
returns `forwardedFromMessageId` and every source attachment. It does not
thread.

**Quoting** (dates rendered `YYYY-MM-DD HH:mm UTC`):
- Reply text: blank line, `On <date>, <Name <addr>> wrote:`, each line of
  `textBody ?? snippet` prefixed `> `.
- Reply HTML (only when `htmlBody` exists): `<p>` attribution, then
  `<blockquote type="cite">` wrapping the source HTML.
- Forward text: `---------- Forwarded message ----------`, From, Date,
  Subject, To, Cc (when present), blank line, body.
- Forward HTML: the same header block as escaped `<div>` lines, then the
  source HTML.
- The server escapes the header values. It does not sanitize the source
  HTML, which is the same untrusted content `Message.htmlBody` already
  exposes. Every client must sanitize before rendering (the web client does,
  section 7).

## 6. Drafts lifecycle and race safety

- **saveDraft create**: persists from, replyTo, to/cc/bcc, subject, text,
  html, attachments (section 4), thread context from `inReplyToMessageId`
  (read-checked), and `forwardedFromMessageId`.
- **saveDraft update**: full replacement of the content fields (from,
  replyTo, to/cc/bcc, subject, text, html, attachments), with `domain_id`
  re-derived from `from`. The linkage fields are sticky: an omitted
  `inReplyToMessageId` keeps the stored thread context (threadId,
  In-Reply-To, References), and an omitted `forwardedFromMessageId` keeps
  the stored value. Only an explicit new id re-resolves either (read-checked).
  The update is conditional (`WHERE id = ? AND status = 'DRAFT'`). Zero rows
  affected returns `CONFLICT` ("draft already sent or deleted").
- **sendDraft**: first a conditional claim (`UPDATE ... SET status='SENT',
  delivery_status='QUEUED', rfc_message_id=?, raw_key=? WHERE id=? AND
  status='DRAFT'`). Zero rows returns `CONFLICT`. Then delivery runs with the
  full outbound assembly (section 8), including attachments. The claim
  persists `rfc_message_id`, fixing the current loss.
- **deleteDraft(id)**: same authority as saveDraft (MAIL_SEND on the draft's
  `from`). A non-draft or unreadable id returns `NOT_FOUND`. Hard delete via
  conditional `DELETE ... WHERE id=? AND status='DRAFT'`, then the
  shared-blob rule for its attachments. It returns `true`. Drafts do not go
  through Trash.
- **Reopen**: the client restores every field from the draft `Message`:
  `from`, `replyTo`, `recipients(kind: TO|CC|BCC)`, `subject`,
  `htmlBody`/`textBody`, `attachments` (as already-bound chips whose ids go
  into `attachmentIds`), `inReplyTo` (non-null means the title reads
  "Reply"), and `forwardedFromMessageId` (title "Forward"). Re-saves omit
  the linkage inputs, so the stored context is kept.
- **Autosave never delivers**: only `saveDraft` is called by autosave.
  Delivery happens only through an explicit user Send (`sendDraft` or
  `sendMessage`).

## 7. Web client

### Compose (`compose-form.tsx` split into focused files)

| File | Responsibility |
|------|----------------|
| `components/compose-form.tsx` | Window shell, field state, send/discard/close orchestration |
| `components/compose-editor.tsx` | contenteditable editor + toolbar + plain-text toggle |
| `components/compose-attachments.tsx` | Chips with progress, error, remove; forwarded chips |
| `lib/compose-html.ts` | `sanitizeComposeHtml`, `htmlToPlainText`, `plainTextToHtml`, link URL validation |
| `lib/draft-autosave.ts` | Serialized debounced saver (framework-free, unit-tested) |
| `lib/upload.ts` | XHR upload with progress callback and 413 mapping |

- **Fields**: From, To, Cc (toggle), Bcc (toggle), Subject, body,
  attachments. The From picker lists concrete sendable addresses grouped by
  domain. A pattern entry (contains `*`) appears as "Other address on
  <domain>" and reveals a local-part input. The value must match the pattern
  client-side, and the server authorizes as usual.
- **Editor**: contenteditable with a toolbar for bold, italic, underline,
  bulleted list, numbered list, link (only `http:`, `https:`, `mailto:`),
  blockquote and clear formatting. Commands go through an injectable
  executor, using `document.execCommand` plus Selection API save/restore, so
  jsdom tests can stub it. No rich-text dependency.
- **Compose sanitizer** (`sanitizeComposeHtml`, DOMPurify, a stricter
  profile than received mail because the editor lives in the app document):
  - Allowed tags: `p div br span b strong i em u s ul ol li a blockquote pre
    code hr table thead tbody tr td th`.
  - Allowed attributes: `href title alt colspan rowspan dir`, plus
    `img src` for `data:image/*` only.
  - Removed: `style` elements, `style`, `class` and `id` attributes, remote
    and `cid:` images (alt text kept), and every event handler.
  - Runs on prefill load, on paste (the paste is intercepted and its HTML
    sanitized), on reopen, and once more right before send/save.
- **HTML vs plain**: HTML mode submits `html` = sanitized editor HTML and
  `text` = `htmlToPlainText(html)`. Block elements become line breaks, list
  items become `- ` / `n. `, blockquotes become `> `, and links become
  `text <url>`. Plain mode submits `text` only. Switching HTML to plain
  converts and confirms loss of formatting. Switching plain to HTML escapes
  the text into paragraphs. A reopened draft opens in HTML mode when
  `htmlBody` is non-null.
- **Attachments**: files upload in parallel (at most 3 in flight), each a
  separate `POST`. Every chip shows progress, error, or done, and has a
  remove button. Files over `mailLimits.maxAttachmentBytes` are refused
  before upload. The running total over `maxOutboundTotalBytes` disables
  Send with a message. Forwarded attachments show as chips with a "from
  original" marker and are removable.
- **Autosave** (`draft-autosave.ts`):
  - Debounce 2 s after the last change, and only when content differs from
    the last saved snapshot.
  - Saves are serialized: one in flight, the latest pending content queued.
  - The returned draft id and attachment ids are adopted.
  - **Send** cancels the timer, awaits the in-flight save, then sends: a
    final `saveDraft` plus `sendDraft` when a draft exists, otherwise
    `sendMessage`.
  - **Discard** cancels the timer, awaits in flight, then calls
    `deleteDraft` when a draft exists (after confirmation).
  - **Close** flushes a dirty draft, then closes.
  - After send or discard the saver is disposed and late results are
    ignored. A `CONFLICT` from saveDraft stops autosave and shows a notice.
- **Reply/forward/reopen**: replace the local prefill logic in
  `mailbox-page.tsx` with `composeFromMessage`. The title reads "Reply" or
  "Forward" from the linkage. The existing pure helpers in `quote-reply.ts`
  and `address-format.ts` are deleted once unused.

### Received mail

- `html-body-frame.tsx` and `mail-html.ts` keep their current boundary: no
  `allow-scripts`, CSP `default-src 'none'`, remote images blocked until the
  per-message "Load images", cid rewrite, text/plain fallback. Add tests that
  pin these.
- Attachment tiles list non-inline attachments, plus inline ones whose
  `contentId` is not referenced by a `cid:` in `htmlBody` (or all of them
  when there is no HTML).

### Unified inbox and sidebar

- `MailboxView` becomes `{ folder, scope }`.
  - `folder` is one of INBOX, STARRED, SENT, DRAFTS, ARCHIVED, SPAM, TRASH,
    TAG, SEARCH.
  - `scope` is `{ domainId?: string; address?: string }`.
  - Both are encoded in the URL (`view`, `domain`, `address`).
- The filter is the folder's existing filter combined with the scope:
  - `domainId` maps to `MessageFilter.domainId`.
  - `address` maps to `toAddress` for INBOX, `fromAddress` for SENT and
    DRAFTS, and `address` for every other folder.
- The sidebar's Domains section becomes clickable scope entries. Under each
  domain, its `viewer.readableAddresses` entries are listed as mailbox
  scopes. "All mail" clears the scope. Folders and tags keep working inside
  any scope.

### Admin

The existing `/settings/domains` and `/settings/users` pages already satisfy
create domain, show the `_mailcal` TXT value, verify, create mailboxes per
domain, and grant permissions through existing mutations
(`createDomain`, `verifyDomain`, `createMailAddress`,
`addUserMailPermission`). Work here is limited to tests that pin this flow.

## 8. Outbound delivery

### Port (`packages/application/src/ports/mail-sender.ts`)

`OutboundMail` gains `messageId` (RFC id without brackets), `replyTo?`,
`inReplyTo?`, `references` (string list), and `contentId?` on
`OutboundAttachment`. `MailSender.send` returns `MailSendReceipt {
providerMessageId: string | null }`. A single assembler in the send use
cases builds `OutboundMail` from a stored message (recipients, bodies,
threading, attachment bytes from R2). `sendMessage`, `sendDraft` and
`retrySend` all use it, so they deliver identical content.

### Binding adapter (`cloudflare-email.ts`)

- Uses the workers-types builder form `SendEmail.send(EmailMessageBuilder)`
  (`@cloudflare/workers-types` 5.20260814.1, wrangler 4.123.0). It sends
  **one call** with `to`, `cc`, `bcc` arrays, `replyTo`, `subject`, `text`,
  `html`, `attachments` (`disposition: "inline"` with `contentId`, or
  `"attachment"`), and `headers` = custom `X-` headers plus `In-Reply-To`
  and `References` only (each `<...>`, References space-joined).
- `Message-ID` is **never** passed to the binding. The deployed binding
  rejects it with `E_VALIDATION_ERROR` ("custom header 'Message-ID' is not
  allowed"), recorded in `design-docs/user-qa/pending-webmail-completion.md`
  "Live check results" item 1. `OutboundMail.messageId` is ignored for
  headers, and any custom header key matching `/^message-id$/i` is dropped
  before the call. The provider assigns the Message-ID (see reconciliation).
- The per-recipient fan-out is removed. Bcc is passed only as the `bcc`
  envelope field and never as a header.
- The local `CloudflareEmailMessage` type is replaced by a structural mirror
  of `EmailMessageBuilder`.
- A returned `messageId` becomes `providerMessageId`.

### REST adapter (`cloudflare-email-api.ts`)

Keeps its request shape and its Bcc-split. It adds `contentId` on inline
attachments, `reply_to`, the `In-Reply-To` and `References` headers, and
the same error classifier. It also omits `Message-ID` from `headers` and
drops any `/^message-id$/i` custom header key. Assumption (same Email
Sending service and header whitelist as the binding; re-verify live): the
REST API rejects `Message-ID` the same way.

### MIME builder and SMTP relay

`mime-builder.ts` never emits `Bcc:`. Bcc recipients live only in
`message_recipients`. This makes the stored `.eml` and the SMTP-relay
`DATA` Bcc-free, while the relay still includes Bcc in `RCPT TO`. The
builder also emits `Reply-To` when set.

### Message-ID reconciliation

The use case generates `<id@from-domain>` and stores it as the initial
`rfc_message_id`. That id is written into the stored `.eml` and the
SMTP-relay `DATA` only; it is never sent as a binding or REST header.

General rule: if the receipt carries a `providerMessageId` that, normalized
(surrounding `<>` stripped, trimmed), is non-empty and differs from the
stored id, the normalized value is persisted as `rfc_message_id` when the
message is marked sent, so external replies still thread.

On the binding path the provider always assigns the Message-ID (live check
item 2: the result is `{ messageId: "<AE8o...@tacoserve.online>" }`, and
recipients see exactly that value). So the provider id is expected to
always differ, and the stored `rfc_message_id` always becomes the provider
value without brackets (for example `AE8o...@tacoserve.online`). The SMTP
relay path returns no provider id and keeps ours.

### Error mapping

Adapters classify provider failures without addresses or provider text. The
code comes from the error's `code` property, else the first
`/\bE_[A-Z_]+\b/` match in the message:

| Provider code | `deliveryError` value |
|---------------|-----------------------|
| (no sender configured) | `NOT_CONFIGURED` |
| `E_SENDER_NOT_VERIFIED` | `SENDER_NOT_VERIFIED` |
| `E_SENDER_DOMAIN_NOT_AVAILABLE` | `SENDER_DOMAIN_NOT_AVAILABLE` |
| `E_RECIPIENT_NOT_ALLOWED` | `RECIPIENT_NOT_ALLOWED` |
| `E_RECIPIENT_SUPPRESSED` | `RECIPIENT_SUPPRESSED` |
| `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED` | `RATE_LIMITED` |
| `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_CONTENT_TOO_LARGE`, any `E_HEADER_*` | `MESSAGE_REJECTED` |
| anything else, transport failure | `PROVIDER_ERROR` |
| SMTP relay failure | `RELAY_ERROR` |

- `MailDeliveryError` carries this `reason` and a fixed message.
- `deliver()` stores the reason, instead of `error.name`, in
  `messages.delivery_error`, which is exposed unchanged as
  `Message.deliveryError: String`.
- Adapters may log the provider code only.
- The SMTP client's error text, which embeds `RCPT TO:<addr>`, is never
  persisted or returned. It is mapped to `RELAY_ERROR`.
- The web client maps each code to a human message.

### Sender rules

- `from` must be authorized MAIL_SEND on its ACTIVE domain, as today.
- A `from` that matches a DISABLED `mail_addresses` row is refused with
  `BAD_USER_INPUT` (`field: "from"`).
- `listSendableAddresses` for a USER without matching mailbox rows falls
  back to that user's ALLOW patterns on the domain, or `*@domain` for an
  ADMIN without a matching DENY. It no longer falls back to `*@domain` for
  every USER.

## 9. Inbound multi-domain delivery

Cloudflare invokes `email()` once per envelope recipient.
`resolveRecipient` is unchanged: catch-all or provisioned mailbox on an
ACTIVE domain, DISABLED mailbox rejects. Recipient storage is **one INBOUND
message row per (Message-ID, recipient domain), with one ENVELOPE recipient
row per delivered mailbox on that domain** (Decision D8).

Why per domain: `messages.domain_id` has a single value. It is the key for
the domain-scope filter (`messages.domain_id IN ...`,
`message-repository-queries.ts:215-219`) and for every mail-permission rule,
which pairs `(rule.domainId, addressPattern)` with `messages.domain_id`
(`message-repository-queries.ts:94-103`, `authorization.ts:148-232`).
Each per-domain row therefore filters and authorizes correctly with no
change to the filter SQL or the per-rule pairing.

Steps:

1. `resolveRecipient` yields the recipient domain D. Then read `Message-ID`
   from the envelope headers, before touching R2.
2. Retry fast path: if a row exists with `direction = INBOUND AND
   domain_id = D AND rfc_message_id = <id>` and it already has an ENVELOPE
   row for this envelope recipient, return DUPLICATE and write no blob.
   A Message-ID match alone never adds a recipient, because the
   Message-ID header is sender-controlled.
3. Otherwise ingest as today, with `domain_id = D`. Two cases may merge
   into the existing row:
   - dedup after parse, using the same `(INBOUND, D, rfc_message_id)` scope;
   - a conflict on the `(rfc_message_id, direction, domain_id)` unique
     index from a concurrent delivery to the same domain.

   In both cases the new raw message is compared with the stored raw
   message after skipping only the unbroken leading run of MTA trace
   fields (`Received`, `X-Received`, `Return-Path`, `Delivered-To`,
   `X-Original-To`, `Received-SPF`, `Authentication-Results`, `ARC-*`).
   The remaining bytes must be identical. Only then is an ENVELOPE row
   added, as a single statement: `INSERT ... SELECT ...
   COALESCE(MAX(position), -1) + 1 ... WHERE NOT EXISTS` for the same
   message, kind and address. Either way the call returns DUPLICATE and
   deletes the blobs it wrote. A new recipient therefore costs one R2
   put, a parse, a read of the stored raw message and a delete. The trace
   allowlist must be confirmed against a live two-recipient Cloudflare
   delivery; a per-recipient field outside it stops genuine copies from
   merging (fail-safe for confidentiality).
4. Dedup never matches OUTBOUND rows or rows on another domain. As a
   result:
   - The inbound copy of our own outbound mail to a managed mailbox is its
     own INBOUND row on the recipient's domain, so sending from one managed
     domain to another lands in the recipient Inbox.
   - A mail to mailboxes on different managed domains gets one row per
     domain.
5. Threading adds a step 0 before the existing In-Reply-To/References
   rules: an existing row with the same `rfc_message_id` (OUTBOUND, or
   INBOUND on another domain) supplies `thread_id`. Every per-domain copy,
   and the sender's outbound row, therefore share one thread.
6. The parsed `Reply-To` (first address) is stored in `messages.reply_to`.

Visible consequences:

- A mail delivered to N mailboxes on the same domain is one row: it shows
  once in "All mail", in the domain scope, and in each mailbox scope.
- A mail delivered to mailboxes on N different domains is N rows. Each row
  appears in its own domain and mailbox scopes and is readable by anyone
  authorized on that domain and address. "All mail" shows N entries, which
  is the "store once per recipient mailbox" storage the intake asks for at
  domain granularity.
- Each row has independent read state, tags, spam verdict and Trash state.
- Spam scoring and classification rules run on the first delivery per
  domain, using that domain's rules. Later same-domain recipients inherit
  the verdict.
- Inbound mail without a `Message-ID` is not deduplicated: one row per
  `email()` call, which is the existing behavior.

## 10. Branding, calendar, documentation

- **Branding**: user-visible names already read flying-mail. The README
  "Deployed instance" paragraph is rewritten to describe the multi-domain
  setup without claiming the instance is idle. The following stay unchanged
  by rule: `MAILCAL_*`, `_mailcal`, `mailcal-verification=`, `mailcal-api`,
  `mailcal-db`, `mailcal-mail`, `~/.config/mailcal`, `data/mailcal.db`,
  `data-mailcal-blocked-src`, and existing migrations.
- **Calendar**: delete the empty `packages/adapter/src/caldav` and
  `packages/adapter/src/ics` directories. Nothing else changes.
- **API documentation**:
  - `design-graphql-api.md` gains a complete "Operation catalogue" listing
    every Query and Mutation from all four SDL documents with their current
    signatures. It also corrects the stale `addUserMailPermission(userId,
    input): UserMailPermission!` and `removeUserMailPermission(id)`
    signatures, and adds the section 3 delta.
  - `README.md` gains an "API" section with curl examples for:
    - Authentication headers.
    - Listing messages with domain and mailbox filters.
    - `sendMessage` with cc, bcc and html.
    - `saveDraft`, `sendDraft` and `deleteDraft`.
    - `composeFromMessage`, then a forward send with
      `forwardAttachmentIds`.
    - `createDomain`, `verifyDomain`, `createMailAddress` and
      `addUserMailPermission`.
    - `POST /api/attachments` and `GET /api/attachments/:id`.
    - `createAttachmentLink` with `/files/:token`.

## 11. Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Forward reuses blobs through new attachment rows sharing `blob_key`, with reference-checked deletion | No re-upload or R2 copy. The schema already allows a shared key, and an index makes the check cheap |
| D2 | Forward authorization = `loadReadableMessage` on the source, and each attachment must belong to it | Exactly "may read the source message". Reuses the single policy path |
| D3 | `attachmentIds` limited to staged rows or rows already on the same draft | Closes the existing IDOR that moves another message's attachment |
| D4 | `SaveDraftInput.attachmentIds` is a full replacement set | Remove-before-send must work for API callers. "Only adds" cannot express removal |
| D5 | Reply/forward prefill computed server-side and exposed as `composeFromMessage` | One implementation for UI and API parity |
| D6 | Draft races closed with conditional `UPDATE`/`DELETE` on `status='DRAFT'` plus a serialized client saver | D1 has no transactions. A row predicate is the only lock |
| D7 | Composed HTML sanitized client-side with a strict allowlist (no style, class, id, remote or cid images); no server-side HTML sanitization | The editor runs in the app document, so the strict profile protects the app UI. Recipients' clients and our own reader sanitize received HTML anyway, and Workers has no DOM |
| D8 | Multi-recipient inbound = one INBOUND row per (Message-ID, recipient domain), plus one ENVELOPE row per delivered mailbox on that domain; dedup scoped to `(INBOUND, domain_id)`; per-domain copies share `thread_id` | `messages.domain_id` is single-valued, and both the domain filter and the `(domainId, addressPattern)` permission pairing key on it. Per-domain rows keep filtering and authorization correct without changing either. Same-domain recipients still share one row, so it shows once. A single cross-domain row was rejected: it would hide the mail from the second domain's scope and from users authorized only there |
| D9 | Builder-form binding with one call (to, cc, bcc arrays); `In-Reply-To` and `References` via `headers`; Message-ID provider-assigned (rejected as a custom header) and persisted without brackets as `rfc_message_id` | workers-types 5.20260814.1 declares cc, bcc, replyTo, contentId attachments and headers. One call removes partial fan-out. The live check (user-qa "Live check results" items 1-2) showed `Message-ID` in `headers` fails with `E_VALIDATION_ERROR`, while `In-Reply-To`/`References` are accepted |
| D10 | `deliveryError` keeps type `String` and carries a stable reason code | No schema break. Codes are address-free by construction |
| D11 | Keep `AttachmentKind.CALENDAR`, `sameCalendarDay`, the CardDAV calendarserver namespace | They are mail attachment classification, date math and CardDAV protocol, not calendar features. Removing CALENDAR would break stored rows and `kind:` search |
| D12 | New SDL and resolvers in `schema-compose.graphql.ts` / `resolvers/compose.ts`; new ingest and schema tests in new files | `schema.graphql.ts` (841), `schema.test.ts` (825), `mutation.ts` (740) and `ingest.test.ts` (798) would otherwise near or cross 1000 lines |
| D13 | Sender rules (section 8): a DISABLED mailbox `from` is refused with `BAD_USER_INPUT`; the sendable-address fallback uses only the USER's own ALLOW patterns (ADMIN `*@domain` unless DENY) | The From picker and send must agree with authorization; the old `*@domain` fallback for every USER offered addresses the user cannot send from |

## 12. Validation and rollout

- **Verification**: `mise run lint`, `bun run test` (baseline 1579 + 192
  passing, all must stay green), `mise run build-web`, and `bun run --cwd
  apps/api cf:deploy -- --dry-run --outdir /tmp/flying-mail-dryrun`.
- **Required new tests**:
  - Adapter: one builder call carries to, cc and bcc; no Bcc in headers or
    stored raw; inline `contentId`; Reply-To, `In-Reply-To` and
    `References` headers; the binding builder and the REST body never carry
    a `Message-ID` header key (case-insensitive), even when
    `OutboundMail.messageId` or a custom header provides one; the
    error-code table; no address appears in any error.
  - Application: forward authorization (unreadable source, foreign
    attachment, missing source); attachment IDOR rejection; draft
    full-replacement; conditional save/send/delete conflicts; `sendDraft`
    persists `rfc_message_id` and delivers attachments; a provider receipt
    `<AE8o@tacoserve.online>` is stored as `AE8o@tacoserve.online`; the
    outbound-to-managed inbound copy; no orphan blob on DUPLICATE;
    shared-blob deletion; `composeFromMessage` recipient table.
  - Multi-domain inbound (application plus repository-backed integration):
    - (a) A same-domain multi-recipient message produces one row with N
      ENVELOPE rows, including under concurrent duplicate delivery.
    - (b) A message to `alice@T` and `bob@M` produces one row per domain
      (`domain_id` T and M) sharing one `thread_id`, and is listed under
      both the T and M domain scopes.
    - (c) A USER whose only rule is ALLOW (domainId=M,
      `bob@mutvar-test.online`) can list and read the M copy. The same USER
      sees no T copy.
    - (d) A DENY on T does not hide the M copy from a reader allowed on M.
    - (e) Dedup ignores OUTBOUND rows and rows on other domains.
  - REST: the 413 code body; the non-ASCII `filename*`.
  - Web (vitest):
    - `compose-html` sanitize and plain-text derivation.
    - The autosave saver: debounce, serialization, no send, dispose.
    - Upload progress and limits.
    - The scope-to-filter mapping and the tile filtering.
- **Rollout**: migration 0013 applies locally and in tests only. Remote D1
  migration and deployment belong to the orchestrating session. No DNS or
  remote wrangler changes.
- **Live verification is owned by the orchestrator** (recorded in
  `design-docs/user-qa/pending-webmail-completion.md`). The pre-implementation
  checks are already answered there ("Live check results"): the binding
  accepts `In-Reply-To` and `References`, rejects `Message-ID`
  (`E_VALIDATION_ERROR`), returns an angle-bracketed provider `messageId`,
  and delivers one to/cc/bcc call between `tacoserve.online` and
  `mutvar-test.online`. After deployment it must still check:
  - End-to-end send/receive between the two domains through the
    implemented adapter, with the Sent row's `rfc_message_id` equal to the
    Message-ID the recipient stores.
  - That the REST Email Sending API also rejects (or is not sent) a
    `Message-ID` header, if the REST adapter is configured.

## 13. Suggested implementation waves

| Wave | Units (parallel within a wave) | Depends on |
|------|-------------------------------|------------|
| A | A1 migration 0013 + domain fields + repository methods (conditional draft ops, blob-key reference check, ENVELOPE insert, (direction, domain_id)-scoped rfc lookup); A2 outbound port, adapters, MIME builder, error classifier; A3 web pure libs (`compose-html`, `draft-autosave`, `upload`) | - |
| B | B1 attachment binding, forward, drafts, `deleteDraft`, assembler, Message-ID reconciliation, sender rules; B2 ingest multi-recipient and dedup; B3 `compose-prefill` + `mailLimits` + `readableAddresses` use cases | A1, A2 |
| C | GraphQL `schema-compose` SDL + resolvers + REST 413 body + `schema-types.ts` mirror | B |
| D | D1 compose UI (editor, attachments, autosave, From picker); D2 reply/forward/reopen wiring, tiles, sidebar scopes | C, A3 |
| E | Docs (operation catalogue, README API, pointers), empty-dir cleanup, full verification | C (docs), D (verification) |

## 14. Addendum (2026-10-07): domain rail and inbound MX readiness

Requested by the user after the first live deployment:

- Domains whose mail cannot reach flying-mail (for example `tacogips.me`,
  whose MX is Google Workspace) must not be usable.
- Domain switching moves to a Discord-style left-most rail, and the
  selected domain's addresses are listed in the next pane.

### 14.1 Inbound MX readiness (server)

Managed-domain inbound mail arrives only through the Cloudflare Email
Routing Worker `email()` handler, so a domain whose MX does not point at
Cloudflare can never receive.

- Ownership stays TXT-only.
- MX readiness is a second, separate **activation gate**.

**`DnsResolver.lookupMx`**
- Signature: `lookupMx(name: string): Promise<readonly MxRecord[]>`, where
  `MxRecord = { priority: number; exchange: string }`.
- `exchange` is lowercased with any trailing dot stripped.
- It rejects on transport failure, the same as `lookupTxt`.
- The DoH adapter queries `type=MX`.

**`MAILCAL_INBOUND_MX_SUFFIX`**
- Deployment config. Default `mx.cloudflare.net`. An empty string disables
  the gate, for deployments that feed inbound some other way.
- Resolved in `composition/config.ts` and exposed to use cases as
  `inboundMxSuffix: string | null`.

**`verifyDomain`**
1. Check the TXT record (unchanged).
2. If `inboundMxSuffix` is not null, look up MX for the domain apex. At
   least one exchange must equal the suffix or end with `.` + suffix.
3. If none does, throw `ConflictError` and leave the domain PENDING. The
   message is "MX records for <domain> do not point to Cloudflare Email
   Routing (*.<suffix>); enable Email Routing for the zone (mise run
   mail-routing-enable <domain>) and retry. Current MX: <comma list or
   none>".
4. If the MX lookup itself fails, throw `ServiceUnavailableError`.
5. Already verified domains return early, as before.

**`MailDomain.inboundMx: InboundMxStatus!`**
- Enum values `READY | NOT_CLOUDFLARE | NONE | UNKNOWN`, resolved lazily
  per selected field.
- `UNKNOWN` means the lookup failed or the gate is disabled.
- Requires `DOMAIN_ADMIN`, like the other domain admin fields.
- Used by Settings > Domains.

### 14.2 Domain rail (web)

**Layout:** `DomainRail | MailboxSidebar | MessageList | Reader`.

**`components/domain-rail.tsx` (+ css)** is a vertical rail about 64 px
wide:
- Top: an "All" item (the unified mailbox).
- Then one item per **ACTIVE** domain the viewer can read. The source of
  truth is the domains of `viewer.readableAddresses`, joined with `domains`
  for id and status, and sorted by name.
- Each item is a rounded avatar: two-letter initials of the first label,
  background colour hashed from the domain name, tooltip and `aria-label`
  with the full name, a Discord-style selection pill on the left edge, and
  an unread badge from the same data the sidebar counts use today.
- Bottom: a settings link to `/settings/domains` (admins only).
- Selecting an item sets the scope `{domainId}` through the existing
  `fullSearchParamsForView` URL mechanism. "All" clears the scope.

**`MailboxSidebar`**
- Header shows the selected domain name, or "All mail".
- Then New message / From template, the MAIL folders, and an **ADDRESSES**
  section:
  - With a domain selected: that domain's readable addresses. Clicking one
    sets scope `{domainId, address}`.
  - With "All" selected: all readable addresses, grouped under small
    domain headers.
- The DOMAINS section is removed from this pane, because it now lives in
  the rail.

**PENDING / DISABLED domains** never appear in the rail, the sidebar, or
the compose From picker groups. They are shown only in Settings > Domains,
together with:
- the TXT record to publish,
- the `inboundMx` badge (Ready / MX not on Cloudflare / No MX / Unknown),
- a Verify button that surfaces the server error text.

**Compose default From:** New message pre-selects the scoped address if
one is selected; otherwise the first sendable address on the selected
domain; otherwise the current default.

**Phone (< 760 px):** the drawer contains the rail and the sidebar side by
side.

### 14.3 Recent-address list (user request, 2026-10-07)

The ADDRESSES list in `MailboxSidebar` sits **above** the "All mail" and
folder entries, so that selecting an address is the first action.

**Order: most recently used first.** "Used" means the latest message
activity of the address:
- the newest OUTBOUND message it sent (non-DRAFT, `from` = the address), or
- the newest INBOUND message delivered to it (an ENVELOPE recipient row).

Addresses with no activity sort last, alphabetically.

**Server field: `Viewer.addressActivity: [AddressActivity!]!`**
- `AddressActivity { address: String!, domainId: ID!, lastActivityAt: DateTime, unreadCount: Int! }`.
- Covers exactly the viewer's readable ACTIVE addresses on ACTIVE domains.
- Ordered by `lastActivityAt` descending, nulls last, then by address.
- `unreadCount` counts unread, non-spam, non-trashed INBOUND messages
  delivered to that address.
- One aggregate SQL query per call. No N+1.

**Display**
- Show the top 7, scoped to the selected rail domain, or across all
  domains when "All" is selected.
- A "Show all (N)" toggle expands the rest.
- A filter input (shown when there are more than 7) narrows by substring,
  case-insensitive, over all addresses.
- The selected address is always visible even when it is beyond the top 7.
- Each row shows the address, a domain hint under "All", and an unread
  badge.
- The expanded state is remembered per browser in `localStorage`, wrapped
  in try/catch.
