# MCP Server 07: Attachment Tools (upload_attachment, get_attachment)

**Status**: Not Started
**Plan ID**: mcp-server-07-attachment-tools
**Wave**: 2 (phase 31)
**Depends On**: mcp-server-01-application-usecases, mcp-server-02-content-shaping, mcp-server-03-protocol-core
**Design Reference**: design-docs/specs/design-mcp-server.md sections 3.4, 4.4 (rows 13-14 and the get_attachment note), 4.6; design-docs/user-qa/pending-mcp-server.md M5
**Created**: 2026-10-08

## Intent and context

This plan fills the stub file
`packages/infrastructure/src/mcp/tools/attachment-tools.ts` with two tools.

- `upload_attachment` stages base64 content through
  `usecases.stageAttachmentUpload` (plan 01).
- `get_attachment` reads through `usecases.readAttachment` (plan 01).
  - Bodies up to `MCP_INLINE_ATTACHMENT_BYTES` are returned as base64.
  - Larger attachments get a single-download file link from
    `usecases.createAttachmentLink(viewer, id, ttl, 1)`. FILE_LINK is
    enforced by that use case.

Contracts consumed:

- `stageAttachmentUpload(viewer, { fileName, contentType, bytes: Uint8Array }) -> Attachment`;
- `readAttachment(viewer, id, { includeBody }) -> { attachment, blob: BlobObject | null }`;
- `createAttachmentLink(...)`, which returns `CreatedFileLink { link, token, url }`;
- `toAttachmentView` (plan 02);
- `MCP_INLINE_ATTACHMENT_BYTES` (plan 03);
- `MAX_ATTACHMENT_UPLOAD_BYTES` (`@flying-mail/application/usecases/mail-limits`);
- `defineTool` and `createMcpTestHarness` (plan 03).

## Non-goals

- No edits outside the writePaths. Do not change `attachments.ts` (the REST
  route; plan 01 owns that refactor).
- No link minting for staged uploads. No streaming. No content sniffing.

## writePaths

- packages/infrastructure/src/mcp/tools/attachment-tools.ts
- packages/infrastructure/src/mcp/tools/attachment-tools.test.ts (new)
- impl-plans/active/mcp-server-07-attachment-tools.md (progress log only)

sharedPaths: none.

## Tool specifications (export `ATTACHMENT_TOOLS` in this order)

### 1. `upload_attachment`

- **Visibility:** MAIL_SEND. **Annotations:** F/F/F/F.
- **Inputs:**
  - `file_name` (string 1-255, required);
  - `content_type` (string, max 255, required);
  - `content_base64` (string, required). Its `maxLength` is
    `Math.ceil(MAX_ATTACHMENT_UPLOAD_BYTES / 3) * 4`.
- **Validation:**
  - `content_type` must match `^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$`;
    otherwise BAD_USER_INPUT, field `content_type`.
  - `content_base64` must be strict standard base64
    (`^[A-Za-z0-9+/]*={0,2}$`, with length % 4 === 0); otherwise
    BAD_USER_INPUT, field `content_base64`.
  - Decode with `atob` into a `Uint8Array`. A decoded length above
    `MAX_ATTACHMENT_UPLOAD_BYTES` is rejected by the use case (also
    BAD_USER_INPUT).
- **Structured:** `{ attachment: { id, content_type, size, untrusted_content: { file_name } } }`.
- **Summary:** `Staged attachment <id> (<size> bytes). Pass its id in attachment_ids.`

### 2. `get_attachment`

- **Visibility:** MAIL_READ. **Annotations:** F/F/F/F. It is not read-only,
  because it may mint a link.
- **Inputs:**
  - `attachment_id` (id, required);
  - `create_link` (boolean, default true);
  - `link_ttl_seconds` (integer 60-3600, default 600).
- **Steps:**
  1. `readAttachment(viewer, id, { includeBody: false })` gets the metadata
     and authorizes (NOT_FOUND when unreadable or staged).
  2. If `attachment.size <= MCP_INLINE_ATTACHMENT_BYTES`:
     - call `readAttachment(..., { includeBody: true })`;
     - read the stream fully (`new Response(blob.body).arrayBuffer()`) and
       base64-encode it in chunks. Do not spread a large array into
       `String.fromCharCode`.
     - **Structured:** `{ attachment: AttachmentView, delivery: "inline", untrusted_content: { content_base64 } }`.
  3. Else if `create_link`:
     - `createAttachmentLink(viewer, id, link_ttl_seconds, 1)`;
     - **Structured:** `{ attachment, delivery: "link", url, expires_at, max_downloads: 1 }`.
  4. Else: `{ attachment, delivery: "omitted", content_omitted: true }`.
- `containsUntrusted: true` (file name and content).

## Pitfalls

- Never call `readAttachment` with `includeBody: true` for an attachment
  above the inline cap. A test spies on `deps.blobs.get` to prove it.
- FORBIDDEN from `createAttachmentLink` (a key without FILE_LINK) must
  propagate. Do not fall back to inline for large files.
- The base64 alphabet must be checked before `atob`. `atob` accepts
  whitespace and would let malformed input through.
- The link URL is a bearer credential intended for the caller. Never log
  it. The audit already excludes results.
- Keep `attachment-tools.ts` under 300 lines.

## Tests (`attachment-tools.test.ts`, using `createMcpTestHarness`)

Each test case is `situation -> expected outcome`.

- MAIL_SEND key: `upload_attachment` with `aGVsbG8=` -> success, `size` 5,
  and a staged attachment exists in the fake store with `messageId null`.
- Base64 containing spaces or `*` -> BAD_USER_INPUT, field `content_base64`.
- `content_type` of `text` -> BAD_USER_INPUT.
- Decoded size `MAX + 1` (built from a large zero buffer) -> BAD_USER_INPUT.
  Keep the test buffer at the cap plus 3 bytes to limit memory.
- MAIL_READ key: `get_attachment` on a 5-byte attachment of a readable
  message -> `delivery` is `"inline"`, and the decoded content equals
  `hello`.
- A 300 KiB attachment with a key holding MAIL_READ plus FILE_LINK ->
  `delivery` is `"link"`, the url is present, `max_downloads` is 1, and
  `blobs.get` is not called.
- The same with MAIL_READ only -> `isError` FORBIDDEN.
- The same with `create_link:false` -> `delivery` is `"omitted"`.
- A staged attachment id -> NOT_FOUND.
- An attachment of an out-of-scope message -> NOT_FOUND.
- `listTools`: a MAIL_SEND-only key sees `upload_attachment` and not
  `get_attachment`; a MAIL_READ-only key sees the reverse.

## Verification (repo root; record exit code and log path)

1. `bunx vitest run packages/infrastructure/src/mcp/tools/attachment-tools.test.ts 2>&1 | tee /tmp/mcp-server-07-unit.log`
   - Expected: exit 0, "Tests N passed" with N > 0.
2. `bun run typecheck 2>&1 | tee /tmp/mcp-server-07-typecheck.log`
   - Expected: exit 0. Cross-plan transients are recorded and re-run.
3. `bunx biome check packages/infrastructure/src/mcp/tools/attachment-tools.ts packages/infrastructure/src/mcp/tools/attachment-tools.test.ts`
   - Expected: exit 0.

## Done criteria

- [ ] `ATTACHMENT_TOOLS` has exactly the 2 tools, as specified.
- [ ] Verification steps 1-3 pass, with logs recorded.

## Worker protocol

- Before each edit, re-read the file and record its sha256. Record it again
  after the edit. On drift, re-read and merge only this plan's intent.
- Edit only the writePaths. Update only this plan's Progress Log.
- No git commit, push, stash, reset or checkout. No worktrees.
- No repository-wide formatter.
- Contract defects go to plans 01, 02 and 03 as repair requests.
- Put evidence under `tmp/mcp-server-s316/mcp-server-07-attachment-tools/<attempt>/`.

## Progress Log

(empty)
