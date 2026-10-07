# Webmail 04: Attachment REST Response and Mail Limits

**Status**: Ready
**planId**: webmail-04-rest-attachments-limits
**Wave**: 1 (no dependencies)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 4 (REST adjustments), section 3 (MailLimits)
**Created**: 2026-10-07

## Intent and context

The compose UI must surface size limits. Two changes support that:
- The upload route's 413 response must carry a machine-readable code and
  limit.
- The single source of truth for limits must be importable by GraphQL
  (webmail-12) and by the REST route.

The upload route is `packages/infrastructure/src/http/attachments.ts`. It
currently hard-codes `MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024` (line 25) and
returns 413 `{error}`. Download headers already use RFC 5987
(`packages/infrastructure/src/http/downloads.ts:33-43`); this plan pins
that with tests.

Attachment ids come from `crypto.randomUUID()`
(`packages/adapter/src/crypto.ts:36-41`). Record that as verified: no
change is needed.

## Non-goals

- No multi-file POST (one file per request stays).
- No changes to the GET authorization.
- No GraphQL changes.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `packages/application/src/usecases/mail-limits.ts`
- `packages/application/src/usecases/mail-limits.test.ts`
- `packages/infrastructure/src/http/attachments.ts`
- `packages/infrastructure/src/http/attachments.test.ts`
- `impl-plans/active/webmail-04-rest-attachments-limits.md` (checkboxes and Progress Log only)

**sharedPaths**: none. `packages/application/src/usecases/send.ts` is only
imported (its exported constants), never edited; webmail-06 owns it.

## File-level changes

### packages/application/src/usecases/mail-limits.ts (new, + mail-limits.test.ts)

```ts
export const MAX_ATTACHMENT_UPLOAD_BYTES = 5 * 1024 * 1024;
export interface MailLimits { readonly maxAttachmentBytes: number; readonly maxOutboundTotalBytes: number; readonly maxAttachmentsPerMessage: number; readonly maxRecipientsPerMessage: number }
export function getMailLimits(): MailLimits;
```

`getMailLimits` reads `MAX_OUTBOUND_TOTAL_BYTES`,
`MAX_OUTBOUND_ATTACHMENTS` and `MAX_RECIPIENTS_PER_MESSAGE` from
`./send` (exports at send.ts:50-52). Import them; do not redefine them.

Test: `getMailLimits()` returns
`{5242880, 5242880, 32, 50}`.

### packages/infrastructure/src/http/attachments.ts

- Replace the local constant with an import of
  `MAX_ATTACHMENT_UPLOAD_BYTES` from
  `@flying-mail/application/usecases/mail-limits`. The package exports
  `./usecases/*` (`packages/application/package.json`).
- Both 413 paths (the Content-Length precheck and the `file.size` check)
  return:

  `{ "error": "Attachment exceeds the 5 MB size limit", "code": "PAYLOAD_TOO_LARGE", "maxBytes": 5242880 }`

- Keep the status 413 and the existing message text.

### packages/infrastructure/src/http/attachments.test.ts (new)

`app.test.ts` is 657 lines, so put these in a new file. Imitate how
`app.test.ts` builds the app and authenticates.

Cases:
- Upload over the limit (file.size) -> 413, JSON `code`
  `PAYLOAD_TOO_LARGE`, `maxBytes` 5242880.
- Content-Length precheck over the limit -> the same body.
- Download of an attachment bound to a readable message, with file name
  `"報告書 2026.pdf"` -> `Content-Disposition` contains
  `filename*=UTF-8''%E5%A0%B1%E5%91%8A%E6%9B%B8%202026.pdf`, and the ASCII
  fallback `filename="___ 2026.pdf"`.
- The same download with `content-type` `application/pdf` -> header
  `content-type: application/pdf`, `x-content-type-options: nosniff`.
- A non-allowlisted type (`text/html`) -> disposition `attachment`.

## Invariants

- The upload limit value is unchanged (5 MiB).
- The download security headers are unchanged.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/infrastructure/src/http packages/application/src/usecases/mail-limits.test.ts`
  -> exit 0.
- `bun run typecheck` -> exit 0.
- `bunx biome check packages/infrastructure/src/http packages/application/src/usecases/mail-limits.ts packages/application/src/usecases/mail-limits.test.ts --diagnostic-level=warn`
  -> no diagnostics.

## Completion criteria

- [ ] `mail-limits.ts` exists and is used by `attachments.ts`.
- [ ] The 413 body carries `code` and `maxBytes`.
- [ ] RFC 5987 and the content-type behavior are pinned by tests.
- [ ] Verification passes, with exit codes logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
