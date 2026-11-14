# Mail Pipeline

How mail enters and leaves mailcal. Both directions are implemented as
application-layer use cases over ports, so the same pipeline runs under
`wrangler dev`, under Bun locally, and in tests with fakes.

## Inbound

Cloudflare Email Routing is configured with a catch-all rule per managed
domain that delivers to the mailcal Worker. The Worker's `email()` handler
hands the message to `receiveMessage`.

```
email(message, env, ctx)
  |
  1. resolve the managed domain from the envelope recipient (message.to)
  |     unknown / DISABLED domain, or a non-catch-all domain with no
  |     matching mailbox      ->  message.setReject(reason); return
  |
  2. stream message.raw into R2 at raw/<messageId>.eml
  |
  3. parse the MIME source (postal-mime)
  |     -> subject, from, to/cc/bcc, date, text, html, attachments,
  |        Message-ID / In-Reply-To / References
  |
  4. resolve the thread id (see "Threading")
  |
  5. store each attachment body in R2 at att/<attachmentId>/<fileName>
  |
  6. score spam signals; apply the SPAM system tag above the threshold
  |
  7. insert message + recipients + attachments + tags in one batch()
```

Every step after (2) runs inside `ctx.waitUntil()`-safe async code; a failure
after the raw source is stored is retried by Email Routing without losing the
message, because the raw object key is derived deterministically from the
generated message id and re-put is idempotent.

### Address resolution

The envelope recipient (`message.to`) is the authoritative delivery address.
Its domain part is looked up in `domains`. A domain with `catchAll: true`
accepts any local part. A domain with `catchAll: false` accepts a local part
only if some existing `message_recipients` row or an explicit mailbox
allowlist covers it -- otherwise the message is rejected at SMTP time with
`550`-style semantics via `setReject`, which is strictly better than silently
black-holing mail.

### MIME parsing

`postal-mime` is the parser: it is dependency-free, targets exactly this
serverless environment, and returns attachments as `ArrayBuffer`s. It is
wrapped behind a `MimeParser` port so the application layer never imports it
directly and tests can supply canned parse results.

```typescript
interface MimeParser {
  parse(raw: ReadableStream | Uint8Array): Promise<ParsedMime>;
}
```

Guards applied to the parse result: attachment count cap (32), per-message
total attachment size cap (25 MiB), and a body length cap beyond which the
text/html bodies are truncated in D1 while the untouched original remains
reachable through the raw `.eml` file link.

### Threading

`threadId` is resolved in this order:

1. If `In-Reply-To` matches a known `messages.rfc_message_id`, reuse that
   message's `threadId`.
2. Otherwise, if any entry of `References` matches a known message, reuse the
   most recent match's `threadId`.
3. Otherwise start a new thread whose id is the new message's own id.

Outbound replies created through `sendMessage(inReplyToMessageId: ...)` join
the referenced message's thread and populate `In-Reply-To`/`References`
accordingly.

### Spam signals

Deliberately simple, self-hosted, and explainable rather than a trained
classifier. `scoreSpam` combines:

| Signal | Weight |
|--------|--------|
| `Authentication-Results` reports SPF or DKIM failure | 0.4 |
| DMARC failure | 0.3 |
| Envelope sender domain differs from the `From:` header domain | 0.15 |
| Subject/body matches the configured phrase list | 0.15 each, capped |
| Sender address or domain on the blocklist | 1.0 (immediate) |

A total score at or above `0.6` applies the `SPAM` system tag. The score is
stored on the message so a client can show why, and `markNotSpam` removes the
tag and adds the sender to the allowlist. The threshold and phrase list are
instance config, not hard-coded constants.

## Outbound

```
Mutation.sendMessage(input)
  |
  1. authorize MAIL_SEND for input.from  (scope match)
  2. require the from-domain to be ACTIVE and verified
  3. build the MIME source (mimetext) incl. threading headers
  4. persist the message as OUTBOUND / QUEUED with its recipients
  5. env.EMAIL.send({ from, to, subject, text, html, headers })
  6. markMessageSent, or markMessageFailed with the masked error
```

The message row is written **before** the send attempt so a Worker eviction
between (4) and (5) leaves a `QUEUED` row that is visible and retryable rather
than a silently lost send. Steps (4)-(6) are not a transaction across the
network boundary; `deliveryStatus` is the reconciliation point.

The `MailSender` port has one implementation for the Cloudflare Email Service
binding and one `createUnavailableMailSender()` that fails with a generic
`MailDeliveryError`, used when the deployment has no verified sender
configured. That failure surfaces to GraphQL as `SERVICE_UNAVAILABLE` -- an
operator problem, distinguishable from a masked internal error.

### Attachments on outbound mail

`sendMessage` accepts attachments by referencing already-uploaded blobs
(`attachmentIds` from a prior `uploadAttachment` REST call) rather than
inlining base64 in the GraphQL document, which keeps mutation payloads small
and lets an agent reuse a file across several sends. Cloudflare's limits (32
attachments, 5 MiB total for the send binding) are validated before the MIME
source is built, so an oversized send fails as `BAD_USER_INPUT` rather than a
provider error.

## Limits summary

| Limit | Value | Enforced at |
|-------|-------|-------------|
| Inbound raw size | 25 MiB | ingest, before parse |
| Attachments per message | 32 | ingest and send |
| Outbound total size | 5 MiB | send, before binding call |
| Recipients per outbound message | 50 | send |
| Stored body text/html | 256 KiB each | ingest, truncated with a flag |


## Non-catch-all accept semantics (updated 2026-08-23)

For a non-catch-all domain, an inbound recipient address is accepted when it
is a *known local part*: mail has previously been delivered to it on this
domain, **or mail has previously been sent from it**. The second clause
breaks the bootstrap deadlock -- without it a fresh non-catch-all domain
could never receive its first message. Sending once from a mailbox is the
act that establishes it.

## Login-link throttle (updated 2026-08-23)

`requestEmailAuth` issues at most 3 challenges per address per 15-minute
window. When throttled it still returns `true` and simply does not send:
a distinguishable throttle response would reintroduce the user-enumeration
oracle the uniform response exists to close.

## Ingest classification (updated 2026-08-23)

Between parsing and storage the pipeline now:

1. Detects mailing-list signals from the standard headers (List-Id,
   List-Unsubscribe, List-Post, Precedence: list|bulk) into
   `messages.list_id` / `messages.is_mailing_list`.
2. Evaluates the operator's classification rules for the receiving domain
   (sender address / sender domain / subject / list id; exact, contains or
   regex). Rule outcomes: mark spam (attributed RULE), flag as mailing
   list, apply tags.
3. Writes the spam verdict as a `message_spam` row in the same atomic
   batch as the message -- rule mark first, else scorer mark when the
   score crosses the threshold. The SPAM tag no longer exists.
