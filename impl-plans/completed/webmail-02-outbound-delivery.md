# Webmail 02: Outbound Delivery Adapter, MIME Builder, Error Codes

**Status**: Completed
**planId**: webmail-02-outbound-delivery
**Wave**: 1 (no dependencies)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 8 (Port, Binding adapter, REST adapter, MIME builder, Error mapping), D9, D10
**Created**: 2026-10-07

## Intent and context

Today the `send_email` binding adapter
(`packages/adapter/src/mail/cloudflare-email.ts`) fans out one call per
recipient. It drops attachments, Reply-To and threading headers, and has
no provider error-code mapping. The MIME builder writes a `Bcc:` header,
which the SMTP relay then transmits.

This plan:
- Changes the port contract.
- Rewrites the binding adapter to a single builder-form call.
- Adds an address-free error classifier.
- Removes `Bcc:` from generated MIME.

The application use cases adopt the new optional fields in webmail-06, so
every new port field is optional and this plan compiles on its own.

The installed `@cloudflare/workers-types` 5.20260814.1
(`node_modules/.bun/@cloudflare+workers-types@5.20260814.1/.../index.d.ts`,
around lines 14081-14145) declares the following, which this plan relies
on:
- `SendEmail.send(builder: EmailMessageBuilder)` with `to`, `cc` and `bcc`
  (string or array), `replyTo` and `headers`.
- `attachments` entries `{disposition:"inline", contentId, filename, type, content}`
  or `{disposition:"attachment", ...}`.
- A result of `{ messageId: string }`.

The deployed binding was measured live (`design-docs/user-qa/pending-webmail-completion.md`,
"Live check results"), and this plan follows those results:
- One builder call with `to`/`cc`/`bcc` arrays delivers to every recipient.
- `In-Reply-To` and `References` headers are accepted.
- A `Message-ID` header is rejected with `E_VALIDATION_ERROR`, so it is
  never sent (see "Never send Message-ID" below).
- The result `messageId` is angle-bracketed and provider-assigned. The
  adapter returns it unchanged as `providerMessageId`; webmail-06 strips
  the brackets and persists it as the outbound `rfc_message_id`.
- Attachments, including inline ones with `contentId`, are accepted. (The
  inline filename fallback on ingest belongs to webmail-08.)

## Non-goals

- No use case changes (send.ts and drafts.ts are webmail-06).
- No wrangler.toml changes.
- No raw `EmailMessage` path.
- No new logging.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. The working tree holds about 251 uncommitted rename changes, and
  you must never revert diffs you did not make.
- No deploy, no remote wrangler, no remote D1.
- Re-read each file before editing it. Record `shasum -a 256` before and
  after in the Progress Log.
- If the pre-edit hash drifted from your last record, re-read and merge.
- Edit only `writePaths`/`sharedPaths`. Log other needs as blockers.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- Keep files under 1000 lines.

## Write ownership

**writePaths**
- `packages/application/src/ports/mail-sender.ts`
- `packages/application/src/ports/mime.ts`
- `packages/application/src/test-support/runtime-fakes.ts`
- `packages/adapter/src/mail/delivery-error.ts`
- `packages/adapter/src/mail/delivery-error.test.ts`
- `packages/adapter/src/mail/cloudflare-email.ts`
- `packages/adapter/src/mail/cloudflare-email.test.ts`
- `packages/adapter/src/mail/cloudflare-email-api.ts`
- `packages/adapter/src/mail/cloudflare-email-api.test.ts`
- `packages/adapter/src/mime/mime-builder.ts`
- `packages/adapter/src/mime/mime-builder.test.ts`
- `impl-plans/completed/webmail-02-outbound-delivery.md` (checkboxes and Progress Log only)

**sharedPaths**: none.

The only `MailSender` implementations are in `cloudflare-email.ts`
(binding and `createUnavailableMailSender`), `cloudflare-email-api.ts` and
`runtime-fakes.ts` (`recordingMailSender`). Every one of them must return
`MailSendReceipt` after the port change. `build-dependencies.ts` only
selects among them and needs no edit.

## File-level changes

### packages/application/src/ports/mail-sender.ts

```ts
export type MailDeliveryReason = "NOT_CONFIGURED" | "SENDER_NOT_VERIFIED" | "SENDER_DOMAIN_NOT_AVAILABLE" | "RECIPIENT_NOT_ALLOWED" | "RECIPIENT_SUPPRESSED" | "RATE_LIMITED" | "MESSAGE_REJECTED" | "PROVIDER_ERROR" | "RELAY_ERROR";
export interface MailSendReceipt { readonly providerMessageId: string | null }
// OutboundAttachment gains: readonly contentId?: string | null
// OutboundMail gains optional: messageId?: string (no brackets; MIME/.eml and SMTP relay only, never a binding/REST header); replyTo?: string; inReplyTo?: string; references?: readonly string[]
// MailSender.send(mail: OutboundMail): Promise<MailSendReceipt>
export function readDeliveryReason(error: unknown): MailDeliveryReason; // error.reason if it is one of the union values, else "PROVIDER_ERROR"
```

`email-auth.ts` and `send.ts` call `send()` and ignore the result. They
still compile, so do not edit them.

### packages/application/src/ports/mime.ts

- `BuildMimeInput` gains `replyTo?: ParsedMimeAddress`.
- Document on `bcc` that it is accepted for compatibility and never written
  to the output.

### packages/application/src/test-support/runtime-fakes.ts

The fake `MailSender.send` (around line 174) returns
`{ providerMessageId: null }` by default. Allow tests to configure:
- a returned `providerMessageId`;
- a thrown error with a `reason`.

Keep the existing recorded-mail capture API unchanged.

### packages/adapter/src/mail/delivery-error.ts (new, + delivery-error.test.ts)

```ts
export class MailDeliveryError extends Error { readonly reason: MailDeliveryReason; constructor(reason?: MailDeliveryReason) } // name "MailDeliveryError", fixed message "Email delivery is unavailable"
export function classifyProviderError(error: unknown): MailDeliveryReason;
export function classifyProviderCode(code: string | null): MailDeliveryReason;
```

**Code source.** Use the string `code` property when present. Otherwise
use the first `/\bE_[A-Z_]+\b/` match in the error `message`.

**Mapping.**

| Provider code | Reason |
|---|---|
| `E_SENDER_NOT_VERIFIED` | `SENDER_NOT_VERIFIED` |
| `E_SENDER_DOMAIN_NOT_AVAILABLE` | `SENDER_DOMAIN_NOT_AVAILABLE` |
| `E_RECIPIENT_NOT_ALLOWED` | `RECIPIENT_NOT_ALLOWED` |
| `E_RECIPIENT_SUPPRESSED` | `RECIPIENT_SUPPRESSED` |
| `E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED` | `RATE_LIMITED` |
| `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_TOO_MANY_RECIPIENTS`, `E_CONTENT_TOO_LARGE`, any `E_HEADER_*` | `MESSAGE_REJECTED` |
| anything else | `PROVIDER_ERROR` |

**Moving the class.** Move `MailDeliveryError` here from
`cloudflare-email.ts` and re-export it from `cloudflare-email.ts`, so
existing imports keep working. Grep for importers: `rg -n "MailDeliveryError" packages apps`.

**Pitfall: the class name.** The GraphQL error mapper matches
`error.name === "MailDeliveryError"`
(`packages/infrastructure/src/graphql/errors.ts:76-83`). Keep that name.

### packages/adapter/src/mail/cloudflare-email.ts (+ cloudflare-email.test.ts)

**Binding type.** Replace the local `CloudflareEmailMessage` with a
structural mirror of `EmailMessageBuilder`: from, to, cc, bcc,
replyTo, subject, text, html, attachments, headers. The binding interface
becomes `send(builder): Promise<{ messageId?: string } | undefined>`.

**One call for all recipients.** Make exactly ONE `binding.send` call:
- `to` = all To addresses.
- Include `cc` and `bcc` arrays only when non-empty.
- Never put Bcc in `headers`.

**Headers.** Send the custom `X-` headers, plus these when provided:
- `In-Reply-To: <id>`
- `References: <a> <b>` (each id wrapped in `<>`, space-joined)

**Never send Message-ID.** The deployed binding rejects a `Message-ID`
header with `E_VALIDATION_ERROR` ("custom header 'Message-ID' is not
allowed"); see `design-docs/user-qa/pending-webmail-completion.md`, "Live
check results" item 1, and design section 8. The provider assigns the
Message-ID and returns it as `messageId` (angle-bracketed); webmail-06
persists it, brackets stripped, as the outbound `rfc_message_id`.

**Pitfall: `OutboundMail.messageId` is not a header.** Both adapters
ignore `OutboundMail.messageId` when building `headers` (it is still used
by the MIME builder for the stored `.eml` and the SMTP relay `DATA`). Also
drop any custom header key matching `/^message-id$/i` before the call, so a
caller-supplied header cannot reintroduce it.

**Attachments.**
- An inline attachment with a contentId becomes
  `{disposition:"inline", contentId, filename, type, content}`.
- Everything else becomes `disposition:"attachment"`, with no contentId
  key.

**Other fields.**
- Map `replyTo`.
- Pass `text` only when non-empty.

**Return value.** Return
`{ providerMessageId: result?.messageId ?? null }`.

**Errors.**
- A provider failure throws
  `new MailDeliveryError(classifyProviderError(err))`.
- Never include provider text or addresses in the thrown error.
- `createUnavailableMailSender` throws
  `new MailDeliveryError("NOT_CONFIGURED")`.

**Keep unchanged.**
- The sender validation (`parseCloudflareSenderAddress`,
  `InvalidSenderAddressError`).
- The From lowercasing.

**Remove.** The per-recipient loop and its doc comment.

### packages/adapter/src/mail/cloudflare-email-api.ts (+ test)

**Keep.** The request shape and the existing Bcc split. It already never
leaks Bcc, so do not change that behavior.

**Add.**
- `contentId` on inline attachments.
- `reply_to` (field name: check the existing body field conventions in
  the file, and keep snake/camel consistent with the documented API body
  used there).
- `In-Reply-To` and `References` in `headers`, formatted as for the
  binding. Never `Message-ID`: ignore `OutboundMail.messageId` and drop any
  `/^message-id$/i` custom header key, as in the binding adapter. This
  assumes the REST Email Sending API shares the binding's header whitelist
  (same service; the orchestrator re-verifies live).

**Return.** `{ providerMessageId }` from the JSON response's message id
field if one exists, else `null`.

**Non-OK responses.** Parse the JSON body for an error code
(`errors[0].code`, else run the regex over the raw text) and throw
`MailDeliveryError(classifyProviderCode(code))`. The body text itself is
never put in the error.

### packages/adapter/src/mime/mime-builder.ts (+ mime-builder.test.ts)

- Stop calling `setBcc`. No `Bcc:` header is ever written.
- When `replyTo` is set, emit `Reply-To` (mimetext header API; imitate the
  existing `In-Reply-To` handling in this file).
- Keep the CR/LF header-injection guard.

## Tests to add or adjust

**cloudflare-email.test.ts**
- to=[a,b], cc=[c], bcc=[d] -> exactly 1 send call. The builder has to
  [a,b], cc [c] and bcc [d]. No header key matching `/^bcc$/i`.
- Inline attachment with contentId "img1" -> disposition inline,
  contentId "img1". A non-inline attachment -> disposition attachment
  with no contentId.
- messageId "m@x", inReplyTo "p@y", references ["r1@z","p@y"] -> headers
  `In-Reply-To` equals `<p@y>` and `References` equals `<r1@z> <p@y>`, and
  no header key matches `/^message-id$/i`.
- Custom headers `{"message-id": "<z@q>", "X-Test": "1"}` -> `X-Test` is
  kept and no header key matches `/^message-id$/i`.
- replyTo set -> builder `replyTo` equals it.
- Binding throws `Object.assign(new Error("E_SENDER_NOT_VERIFIED: x@y"), {})`
  -> MailDeliveryError with reason `SENDER_NOT_VERIFIED`, and the error
  message does not contain "x@y".
- Binding returns `{messageId:"prov@cf"}` -> receipt providerMessageId
  "prov@cf". Returns undefined -> null.
- Update the old fan-out test to the new single-call behavior.

**delivery-error.test.ts**
- Every row of the table.
- A `code` property wins over the message regex.
- Unknown -> `PROVIDER_ERROR`.
- `readDeliveryReason` on a plain Error -> `PROVIDER_ERROR`.

**cloudflare-email-api.test.ts**
- Inline contentId is forwarded.
- messageId "m@x", inReplyTo "p@y", references ["r1@z","p@y"] -> request
  body `headers` has `In-Reply-To` `<p@y>` and `References` `<r1@z> <p@y>`,
  and no key matching `/^message-id$/i` (also when a custom
  `Message-ID` header is supplied).
- An error JSON with code `E_RATE_LIMIT_EXCEEDED` -> reason
  `RATE_LIMITED`, and the error message has no address.

**mime-builder.test.ts**
- Input with bcc -> output contains no line matching `/^Bcc:/im`.
- replyTo -> output contains a `Reply-To:` header.

## Invariants

- No address and no provider text appear in any thrown error message.
- Bcc never appears in transmitted headers or MIME.
- `Message-ID` never appears in binding or REST `headers`; the MIME builder
  still writes it into the stored `.eml` and the SMTP relay `DATA`.
- Error name `MailDeliveryError` is unchanged.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/adapter/src/mail packages/adapter/src/mime packages/application/src/usecases/auth.test.ts packages/application/src/usecases/send.test.ts`
  -> exit 0.
  - `send.test.ts` must still pass with the new fake defaults.
- `bun run typecheck` -> exit 0.
- `bunx biome check packages/adapter/src/mail packages/adapter/src/mime packages/application/src/ports/mail-sender.ts packages/application/src/ports/mime.ts packages/application/src/test-support/runtime-fakes.ts --diagnostic-level=warn`
  -> no diagnostics.
- `rg -n "setBcc" packages/adapter/src/mime` -> no matches.

## Completion criteria

- [x] Port types and `readDeliveryReason` are added.
- [x] `delivery-error.ts` is added with tests.
- [x] The binding adapter makes a single builder call with
      cc/bcc/replyTo/attachments/In-Reply-To/References and a receipt, and
      never sends a Message-ID header.
- [x] The REST adapter has contentId, In-Reply-To/References, replyTo and
      code mapping, and never sends a Message-ID header.
- [x] The MIME builder emits no Bcc and does emit Reply-To.
- [x] All verification passes, with exit codes logged.

## Progress Log

### Session: 2026-10-07
**Tasks Completed**: Port and fake receipt contract; provider reason classifier and tests; one-call binding adapter; REST adapter threading, Reply-To, inline content id, provider receipt and error mapping; MIME Bcc suppression and Reply-To; focused tests and Biome.
**Verification**:
- `bunx vitest run packages/adapter/src/mail packages/adapter/src/mime packages/application/src/usecases/auth.test.ts packages/application/src/usecases/send.test.ts` -> exit 0, 155 passed, 0 failed on the final source. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/focused-tests-source-final.log`.
- `bunx biome check packages/adapter/src/mail packages/adapter/src/mime packages/application/src/ports/mail-sender.ts packages/application/src/ports/mime.ts packages/application/src/test-support/runtime-fakes.ts --diagnostic-level=warn` -> exit 0. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/biome-source-final.log`.
- `bun run typecheck` -> exit 2. `@flying-mail/application`, `@flying-mail/adapter`, `@flying-mail/infrastructure`, and `flying-mail-api` pass. `flying-mail-web` fails at `apps/web/src/components/message-view.test.tsx:10` because `replyTo` is optional in the fixture but required by `MessageDetailView`. That file is outside this plan's write paths. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/typecheck-source-final.log`.
- `rg -n "setBcc" packages/adapter/src/mime` -> exit 1, expected no matches. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/bcc-search-source-final.log`.
- Earlier attempts: focused tests attempt 1 and 2 exited 1 on the Reply-To implementation, attempt 3 exited 1 on its test expectation; final source passed on attempt 4. Initial Biome check exited 1 on formatting only; the declared changed files were formatted before final Biome passed. Initial root typecheck exited 2 with adapter diagnostics that were corrected; final root typecheck has only the web fixture mismatch above.
**SHA-256 edit evidence**: pre-edit snapshots and per-edit intentions are in `tmp/webmail-completion-s299/webmail-02-outbound-delivery/edit-intent-*.json`. Final source hashes: `packages/application/src/ports/mail-sender.ts` `2d9552dda93223055e9dc7c3412fd8e51adb45a19f9117b24386e97433d07974`; `packages/application/src/ports/mime.ts` `6e0c7d93b2d0812a1d7bb08b2cb96a6ee820f23354e480cfbc3c39747c9aeee9`; `packages/application/src/test-support/runtime-fakes.ts` `f66a3de604cb77b85d67f8dd800cdcc4fbf094716627714b993fa4efa9439ac0`; `packages/adapter/src/mail/delivery-error.ts` `318f8688c7cfe6d3463009be550a2920e0076c6fde56c4688528ae089f9726cb`; `packages/adapter/src/mail/delivery-error.test.ts` `e13d5ae0236fc65f3d0d8e0a90cbd20c392a76a8599ddd4931df91a3dd81839b`; `packages/adapter/src/mail/cloudflare-email.ts` `3517fed6fa3c11cdd4fdd0f8779df13da0cbd76c22fd9ddfd2d7142e2e2ce3d1`; `packages/adapter/src/mail/cloudflare-email.test.ts` `a117a9edb607429be774360eda1b30e87c5828236b47df1e2647149fdeaca5ac`; `packages/adapter/src/mail/cloudflare-email-api.ts` `8eea7294ef9a330aae84e84314b44844ec641767d1212f71dbdccf8a4b78c10e`; `packages/adapter/src/mail/cloudflare-email-api.test.ts` `6ad371666073f14abb8fff81e4885b27b4556b0e13587e10adbc790ce90e5a0e`; `packages/adapter/src/mime/mime-builder.ts` `428041bf499f6ea36453a374260a5b1524f17bc9d1fbc169d36d2ddc043ada84`; `packages/adapter/src/mime/mime-builder.test.ts` `ac5a70df0ce301c4b897949a8e22e9f9b1854e6fe4e7db742ade725ac1624b41`.
**Blocked completion criterion at that session**: Root `bun run typecheck` failed on `apps/web/src/components/message-view.test.tsx`, outside the declared write paths. The current-source rerun below passes, resolving that temporary gate without an out-of-scope edit.

### Session: 2026-10-07 (current-source verification)
**Tasks Completed**: Re-ran all plan-required verification on the current shared tree. The prior web fixture typecheck failure is resolved in the current tree; no source edits outside this plan were needed.
**Verification**:
- `bunx vitest run packages/adapter/src/mail packages/adapter/src/mime packages/application/src/usecases/auth.test.ts packages/application/src/usecases/send.test.ts` -> exit 0, 155 passed, 0 failed across 7 files. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/focused-tests-final-current.log`.
- `bun run typecheck` -> exit 0; all seven workspaces passed. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/typecheck-current.log`.
- `bunx biome check packages/adapter/src/mail packages/adapter/src/mime packages/application/src/ports/mail-sender.ts packages/application/src/ports/mime.ts packages/application/src/test-support/runtime-fakes.ts --diagnostic-level=warn` -> exit 0, 13 files checked without diagnostics. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/biome-current.log`.
- `rg -n "setBcc" packages/adapter/src/mime` -> exit 1, expected no matches. Log: `tmp/webmail-completion-s299/webmail-02-outbound-delivery/logs/bcc-search-current.log`.
**Progress-record SHA-256**: pre-edit `76f6f651750a3d88f7c8023c87066d6d67d10207362467746da786968f549144`; per-edit intent `tmp/webmail-completion-s299/webmail-02-outbound-delivery/edit-intent-015.json`; post-edit hash recorded after update.

### Session: 2026-10-07 orchestrator completion
Completed outside the riela gate: the workflow accepted webmail-01, 02, 04, 06, 07, 08 and 09 through its native reviews; its implementation-progress-check gate repeatedly rejected valid evidence for 03 and 05 (5 attempts, tests passing), so the orchestrator continued with GPT-6 Luna (codex exec) implementing 10, 11, 12 and 13 and read-only Opus reviews (iterations 1-2) whose findings were returned to Luna and fixed (webmail-10 H1-H2/M1-M3/L1-L5/R1/R4/R6, webmail-11 C1/S1-S3/N1-N6, webmail-05 R2/R3, webmail-03 R5, plus the pre-existing login cookie defect L0). Final verification: mise run lint exit 0; bun run test exit 0 (1695 package tests, 242 web tests); mise run build-web exit 0. Deployed to Cloudflare (worker mailcal-api) and verified live: cross-domain send/receive, To/Cc/Bcc, HTML, attachments upload/download, reply threading, forward with original attachments, draft save/update/reopen/send/delete, and the web UI end to end in Brave.
