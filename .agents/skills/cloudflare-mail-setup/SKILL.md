---
name: cloudflare-mail-setup
description: Use when a mailcal deployment cannot send or receive mail, when adding a sending domain or recipient, or when a send fails with MailDeliveryError or SERVICE_UNAVAILABLE. Covers Cloudflare Email Routing vs Email Sending, destination verification, and the mise/wrangler commands that configure both.
allowed-tools: Bash, Read
---

# Cloudflare mail setup for mailcal

Everything on the Cloudflare side that outbound and inbound mail depend on.
All of it runs through `wrangler email`, wrapped as `mise run mail-*` tasks,
so a new sending domain never needs the dashboard.

## The distinction that explains most failures

Two separate Cloudflare products, and picking the wrong one is the usual
cause of "the API says SENT but nothing arrives" or a flat
`MailDeliveryError`:

| | Email Routing | Email Sending |
|---|---|---|
| What mailcal uses it for | receiving, and the `send_email` Worker binding | outbound only |
| Recipients | **only addresses verified as destinations on the account** | anyone |
| Cost | free | Workers Paid |
| mailcal adapter | `mail/cloudflare-email.ts` | `mail/cloudflare-email-api.ts` |

The binding's recipient restriction is not a misconfiguration to work
around — it is what the binding is for. A deployment that must mail people
who have never clicked a Cloudflare verification link **needs Email
Sending**. `resolveMailSender` in `composition/build-dependencies.ts`
prefers Email Sending whenever `MAILCAL_EMAIL_SENDING_ACCOUNT_ID` and
`MAILCAL_EMAIL_SENDING_TOKEN` are both set, and falls back to the binding.

`MAILCAL_MAIL_FROM` gates neither. It is the sender for *system* mail
(passwordless login links) only. Each user message leaves as the mailbox its
sender was authorized for.

## Start here

```bash
mise run mail-status
```

Prints, in order: which zones have Email Routing, which destination
addresses exist and whether each is verified, and which domains have Email
Sending. Read it before changing anything — most questions are answered by
the `verified` column alone.

Authentication is the same OAuth session `wrangler deploy` uses. If commands
fail with `Unauthorized [code: 2036]`, run `mise exec -- wrangler login`, or
use an API token whose permissions include the product you are touching —
`whoami` scopes for Workers do **not** imply Email Sending access.

## Receiving, and sending to your own operators (free)

```bash
mise run mail-setup-receiving <domain> <destination-email>
```

Which is `mail-routing-enable` plus `mail-dest-add`. Then:

1. Publish the MX and SPF records it prints (`mise run mail-routing-dns
   <domain>` reprints them).
2. **A human must click the verification link** Cloudflare mails to the
   destination address. There is no API that skips this; it is anti-abuse.
   Until then every send to that address fails with `MailDeliveryError`.
3. Confirm with `mise run mail-dest-list` — look for a timestamp in
   `verified`, not `null`.

## Sending to arbitrary recipients (Workers Paid)

First re-authenticate, once. `wrangler login` grants a fixed scope set that
omits **both** email scopes, so every `wrangler email sending ...` call
fails with `Unauthorized [code: 2036]` until the session is re-minted:

```bash
mise run mail-login     # opens a browser; a human must approve
```

The flag replaces the scope set rather than adding to it, which is why the
task re-lists the Workers/D1/Pages scopes alongside `email_routing:write`
and `email_sending:write`. Confirm with `wrangler whoami`.

Then:

```bash
mise run mail-sending-enable <domain>
```

Then publish the SPF/DKIM/DMARC records it prints, and configure mailcal:

```bash
wrangler secret put MAILCAL_EMAIL_SENDING_TOKEN     # never a plaintext var
# add MAILCAL_EMAIL_SENDING_ACCOUNT_ID to [vars] in wrangler.toml
mise run cf-deploy
```

`email.sending.error.email.sending_disabled` from the API means the feature
is not enabled for the account. Enabling it is a **billing decision** —
surface it to the operator rather than enabling it for them.

## Then, in mailcal itself

Cloudflare-side wiring is not enough; mailcal needs its own registration:

1. `createDomain(name:)` — returns a `_mailcal` TXT record.
2. Publish that record, then `verifyDomain(id:)`. It does a real DoH lookup;
   an unverified domain can neither send nor receive.
3. `createMailAddress(input: { domainId, localPart })` — provisions a
   mailbox. Without one, a non-catch-all domain only accepts addresses it
   has already seen.
4. `viewer { sendableAddresses }` should now list the concrete mailbox. Pass
   one of those verbatim as `SendMessageInput.from`.

Do **not** shortcut step 2 by writing `verified_at` into D1. It is possible
with `wrangler d1 execute --remote` and it does work, but it bypasses the
ownership check for everyone who reads the row afterwards. If you ever do it
under time pressure, say so explicitly and re-verify properly later.

## Attachments

Binary never goes through GraphQL. Upload first, reference by id:

```bash
curl -X POST "$ENDPOINT/api/attachments" \
  -H "authorization: Bearer $KEY" -F "file=@./report.pdf;type=application/pdf"
# -> { "id": "...", ... }
```

then `sendMessage(input: { ..., attachmentIds: ["<id>"] })`. Staged uploads
never bound to a send are swept after 24h along with their R2 blobs.

## Diagnosing a failed send

Read `deliveryStatus` and `deliveryError` on the returned `Message` — the
row is written before delivery is attempted, so a failure is always visible
and retryable rather than lost.

| Symptom | Cause |
|---|---|
| `SERVICE_UNAVAILABLE` on any send | neither Email Sending nor the `EMAIL` binding is configured |
| `FAILED` / `MailDeliveryError`, binding path | recipient is not a verified destination |
| `sending_disabled` | Email Sending not enabled for the account |
| `is not on a managed domain` | no `createDomain` for the sender's domain |
| `not verified and active for sending` | `verifyDomain` never succeeded, or status is not ACTIVE |
| `Unauthorized [code: 2036]` from wrangler | OAuth session lacks that product's permission |

Provider error text is deliberately discarded rather than surfaced: it
echoes recipients and subjects, and that reaches API clients including keys
scoped to a single mailbox.
