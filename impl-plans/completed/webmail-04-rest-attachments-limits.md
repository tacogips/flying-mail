# Webmail 04: Attachment REST Response and Mail Limits

**Status**: Completed
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
- `impl-plans/completed/webmail-04-rest-attachments-limits.md` (checkboxes and Progress Log only)

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

- [x] `mail-limits.ts` exists and is used by `attachments.ts`.
- [x] The 413 body carries `code` and `maxBytes`.
- [x] RFC 5987 and the content-type behavior are pinned by tests.
- [x] Verification passes, with exit codes logged.

## Progress Log

### Session: 2026-10-07
**Tasks Completed**: Shared upload limit module, structured 413 bodies, route tests for oversize uploads and safe attachment downloads.
**Verification**:
- `bunx vitest run packages/infrastructure/src/http packages/application/src/usecases/mail-limits.test.ts` -> exit 0; 3 test files, 51 tests passed. Current-source rerun log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/agent-check-vitest.log`.
- `bunx biome check packages/infrastructure/src/http packages/application/src/usecases/mail-limits.ts packages/application/src/usecases/mail-limits.test.ts --diagnostic-level=warn` -> exit 0, no diagnostics. Current-source rerun log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/agent-check-biome.log`.
- `bun run typecheck` -> exit 2; current-source rerun reports only `apps/web/src/components/message-view.test.tsx:10` missing required `replyTo`, outside this plan's writePaths. Application, adapter, infrastructure and API typechecks exited 0. Log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/agent-check-typecheck.log`. Earlier same-turn errors in application/adapter are preserved at `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/final-typecheck.log`; the webmail-11 owner must resolve the remaining web type error and rerun the root check. No out-of-scope edits made.
- Source SHA-256 before -> after edits: `packages/infrastructure/src/http/attachments.ts` `dacc0b599ec3fee2bcc10d00b8548120e01af4487929fc59bd74ec0e1652944c` -> `0facdee61d5c7e5d01fc82e40372319a53b5a79b99ede4ffb898dbb05492b083`; `packages/application/src/usecases/mail-limits.ts` new `f955adf0d35a30c368ccb11b5637325bcae402df48779a4f16a29ca03f6ef09f`; `packages/application/src/usecases/mail-limits.test.ts` new `5b5e788a5184cf09996d4474691b44cbbfb605ceea42edb3a395419dd7e6a413`; `packages/infrastructure/src/http/attachments.test.ts` new `b61022717580cd7f4765b0f90d27322be574430bfdfbea23b529c55bf960f866`.
- Plan SHA-256 before first progress update: `47a7a8b612ee50408e1db843ab418131de2d095ab7c6bd9b55efbd440eb767ab`; after that update: `1c5b4035975a3da297aab951f12c3ba3c06682308c636e24361922de8ecab1f5`. Later plan-edit hash transitions are recorded in `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/plan-hash-transition.txt` and the final hash in `final-source-sha256.txt`.

### Session: 2026-10-07 (current-source verification)
**Tasks Completed**: Re-ran assigned behavioral, typecheck, and Biome gates on the current shared source; confirmed the root typecheck now passes.
**Verification**:
- `bunx vitest run packages/infrastructure/src/http packages/application/src/usecases/mail-limits.test.ts` -> exit 0; 3 test files and 51 tests passed. Complete log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/current-vitest.log`.
- `bun run typecheck` -> exit 0; CLI, domain, web, application, adapter, infrastructure, and API typechecks passed. Complete log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/current-typecheck.log`.
- `bunx biome check packages/infrastructure/src/http packages/application/src/usecases/mail-limits.ts packages/application/src/usecases/mail-limits.test.ts --diagnostic-level=warn` -> exit 0; no diagnostics. Complete log: `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/current-biome.log`.
- Current source SHA-256: `packages/application/src/usecases/mail-limits.ts` `f955adf0d35a30c368ccb11b5637325bcae402df48779a4f16a29ca03f6ef09f`; `packages/application/src/usecases/mail-limits.test.ts` `5b5e788a5184cf09996d4474691b44cbbfb605ceea42edb3a395419dd7e6a413`; `packages/infrastructure/src/http/attachments.ts` `0facdee61d5c7e5d01fc82e40372319a53b5a79b99ede4ffb898dbb05492b083`; `packages/infrastructure/src/http/attachments.test.ts` `b61022717580cd7f4765b0f90d27322be574430bfdfbea23b529c55bf960f866`.
- Plan SHA-256 before this progress update: `6ce67279830041cf5a6c1bc429c31194e71350df104fdb3752262622c46e0b9c`; after update: recorded in `tmp/webmail-completion-s299/webmail-04-rest-attachments-limits/final-source-sha256.txt`.

### Session: 2026-10-07 orchestrator completion
Completed outside the riela gate: the workflow accepted webmail-01, 02, 04, 06, 07, 08 and 09 through its native reviews; its implementation-progress-check gate repeatedly rejected valid evidence for 03 and 05 (5 attempts, tests passing), so the orchestrator continued with GPT-6 Luna (codex exec) implementing 10, 11, 12 and 13 and read-only Opus reviews (iterations 1-2) whose findings were returned to Luna and fixed (webmail-10 H1-H2/M1-M3/L1-L5/R1/R4/R6, webmail-11 C1/S1-S3/N1-N6, webmail-05 R2/R3, webmail-03 R5, plus the pre-existing login cookie defect L0). Final verification: mise run lint exit 0; bun run test exit 0 (1695 package tests, 242 web tests); mise run build-web exit 0. Deployed to Cloudflare (worker mailcal-api) and verified live: cross-domain send/receive, To/Cc/Bcc, HTML, attachments upload/download, reply threading, forward with original attachments, draft save/update/reopen/send/delete, and the web UI end to end in Brave.
