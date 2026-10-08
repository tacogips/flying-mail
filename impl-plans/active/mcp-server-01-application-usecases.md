# MCP Server 01: Application Use Cases (API-key-only resolution, trash, attachments)

**Status**: Not Started
**Plan ID**: mcp-server-01-application-usecases
**Wave**: 1 (phase 30)
**Depends On**: none
**Design Reference**: design-docs/specs/design-mcp-server.md sections 1, 3.1, 4.6; design-docs/user-qa/pending-mcp-server.md M4
**Created**: 2026-10-08

## Intent and context

The MCP layer must call only `UseCases`, never repositories, for anything
that needs authorization. Three operations it needs have no use case today:

- API-key-only viewer resolution. The existing `resolveViewerFromToken`
  checks sessions first, so a session token sent as Bearer would resolve to
  a USER viewer.
- A trash that never purges. `deleteMessages` purges messages already in
  Trash, and hard-deletes everything when the Trash tag is missing.
- Attachment staging and reading. Both live inline in the HTTP route
  `packages/infrastructure/src/http/attachments.ts`.

This plan adds four `UseCases` members and refactors the two REST
attachment routes onto them **with byte-identical responses**.

Repository context:

- `packages/application/src/usecases/auth.ts`: functions
  `createResolveViewerFromTokenUseCase` and `resolveViewerFromTokenHash`.
  Sessions are checked first; the API-key branch is lines ~72-87
  (`findByKeyHash`, `isApiKeyUsable`, `listScopes`, fire-and-forget
  `recordApiKeyUsage`).
- `packages/application/src/usecases/messages.ts:createDeleteMessagesUseCase`,
  lines ~391-470. The trash branch uses `findBySystemSlug(SystemTagSlug.Trash)`,
  `listTagIds`, `addTags` and `recordMailEvents(MessageUpdated)`.
  `loadReadableMessages` and `loadReadableMessage` are exported from
  `messages.ts`.
- `packages/infrastructure/src/http/attachments.ts`:
  - `POST /attachments`: Content-Length precheck, then formData, then the
    `MAX_ATTACHMENT_UPLOAD_BYTES` check, then
    `blobs.put` + `createAttachment` + `messageRepository.saveAttachment`.
  - `GET /attachments/:id`: `findAttachmentById`, then the staged check,
    then `usecases.getMessage`, then `blobs.get`, then
    `buildDownloadResponse`.
- `packages/application/src/usecases.ts`: `UseCases` interface (699 lines)
  and `createUseCases`.

## Non-goals

- Do not modify `messages.ts`, `createDeleteMessagesUseCase` or its
  two-stage behavior. `trashMessages` reimplements only the add-Trash-tag
  part.
- Do not change `resolveViewerFromToken` behavior or the auth middleware.
- Do not change `policies/authorization.ts`. `viewerHoldsCapability` belongs
  to plan 03.
- No MCP code, no GraphQL change, no migration.
- Do not bind staged attachments to the uploader. This existing behavior is
  an accepted residual risk.

## writePaths

- packages/application/src/usecases/auth.ts
- packages/application/src/usecases/auth.test.ts
- packages/application/src/usecases/trash.ts (new)
- packages/application/src/usecases/trash.test.ts (new)
- packages/application/src/usecases/attachment-uploads.ts (new)
- packages/application/src/usecases/attachment-uploads.test.ts (new)
- packages/application/src/usecases.ts
- packages/infrastructure/src/http/attachments.ts
- impl-plans/active/mcp-server-01-application-usecases.md (progress log only)

sharedPaths: none.

## File-level changes

### TASK-001: `resolveApiKeyViewerFromToken` (auth.ts)

Pin this signature, since plan 10 consumes it:

```
export type ApiKeyViewer = Extract<Viewer, { kind: "API_KEY" }>;
export function createResolveApiKeyViewerFromTokenUseCase(deps: AppDependencies): (token: string) => Promise<ApiKeyViewer | null>;
```

- Extract the API-key branch of `resolveViewerFromTokenHash` into a private
  `resolveApiKeyViewerFromHash(deps, tokenHash, { recordUsage })`.
  `resolveViewerFromTokenHash` calls it after the session check. Its
  behavior is unchanged.
- The new use case:
  - returns `null` without hashing or reading anything when the token does
    not match `/^ybm_[0-9a-f]{12}_\S+$/`;
  - otherwise calls `deps.tokenHasher.hash(token)` and then the extracted
    helper with `recordUsage: true`.
- It never calls `sessionRepository`. It never throws for an unusable token
  (returns `null`).

### TASK-002: `trashMessages` (new trash.ts)

```
export function createTrashMessagesUseCase(deps: AppDependencies): (viewer: Viewer, ids: readonly MessageId[]) => Promise<number>;
```

Steps:

1. `loadReadableMessages(deps, viewer, ids, Capability.MailManage)`.
   Unreadable or out-of-scope ids are silently skipped, as in
   `deleteMessages`. An empty result returns `0`.
2. `deps.tagRepository.findBySystemSlug(SystemTagSlug.Trash)`. When it is
   `null`, throw `ServiceUnavailableError("The Trash system tag is missing")`.
   **Never** fall back to a hard delete.
3. `listTagIds` for the authorized ids. Add the Trash tag (`addTags` with
   `deps.clock.now().toISOString()`) only to ids not already tagged.
4. `recordMailEvents(deps, newlyTrashed.map(m => ({ type: MailEventType.MessageUpdated, message: m })))`.
   No event is recorded for messages that were already trashed.
5. Return the number of authorized messages that are in Trash after the
   call (newly trashed plus already trashed).

### TASK-003: attachment use cases (new attachment-uploads.ts)

```
export interface StageAttachmentUploadInput { readonly fileName: string; readonly contentType: string; readonly bytes: Uint8Array }
export interface AttachmentContent { readonly attachment: Attachment; readonly blob: BlobObject | null }
export function createStageAttachmentUploadUseCase(deps): (viewer: Viewer, input: StageAttachmentUploadInput) => Promise<Attachment>;
export function createReadAttachmentUseCase(deps): (viewer: Viewer, id: AttachmentId, options: { readonly includeBody: boolean }) => Promise<AttachmentContent>;
```

**stage**

- If `bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES`, throw
  `BadUserInputError(\`Attachment exceeds the 5 MB size limit\`, "content")`.
- An empty `fileName` becomes `"attachment"`, and an empty `contentType`
  becomes `"application/octet-stream"`.
- Generate the id with `createAttachmentId(deps.random.uuid())` and the key
  with `buildAttachmentBlobKey`, then `blobs.put` with `contentType`.
- Build the attachment with `createAttachment({... messageId: null, contentId: null, inline: false, createdAt: now })`
  and save it with `messageRepository.saveAttachment`.
- Return the `Attachment`.
- The `viewer` parameter is required, but no capability is checked. This
  mirrors the current route; do not add a check.

**read**

- `findAttachmentById`. Throw `NotFoundError("Attachment", id)` when it is
  `null` or when `messageId === null` (staged).
- `loadReadableMessage(deps, viewer, attachment.messageId)` is MAIL_READ by
  default. Throw `NotFoundError` when it is `null`.
- With `includeBody`, `blobs.get(attachment.blobKey)`; a `null` blob throws
  `NotFoundError`. Without `includeBody`, return `blob: null` and **do not
  call `blobs.get`**.

### TASK-004: wiring (usecases.ts)

Add to the `UseCases` interface and to `createUseCases`:

- `resolveApiKeyViewerFromToken`
- `trashMessages`
- `stageAttachmentUpload`
- `readAttachment`

Export the input and output types from their modules. The infrastructure
package imports them via `@flying-mail/application/usecases/attachment-uploads`
(the existing `./usecases/*` export pattern).

### TASK-005: REST refactor (http/attachments.ts)

**`POST /attachments`**

- Keep the existing Content-Length precheck, formData parsing, the missing
  "file" field check and the `file.size > MAX` check, with the **same**
  responses.
- Then call `usecases.stageAttachmentUpload(viewer, { fileName: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) })`.
- Build the same `UploadAttachmentResponse` (201) from the returned
  attachment.

**`GET /attachments/:id`**

- Call `usecases.readAttachment(viewer, id, { includeBody: true })`.
- Map `NotFoundError` to the existing `{ error: "Attachment not found" }`
  404. Do not use `applicationErrorResponse` for this case, because its
  message text differs.
- Other `ApplicationError`s go through `applicationErrorResponse`.
- Pass the blob to `buildDownloadResponse` exactly as now.
- Remove imports that become unused (for example `buildAttachmentBlobKey`
  and `createAttachment`) so Biome stays clean.

## Pitfalls

- Do not copy the `deleteMessages` purge path. A test must prove that a
  second `trashMessages` call leaves the message stored.
- `resolveApiKeyViewerFromToken` must not hash or query for malformed
  tokens. Assert this with `vi.spyOn(fake.deps.tokenHasher, "hash")`.
- The REST GET must keep returning 404 with the exact JSON body
  `{"error":"Attachment not found"}` in all four not-found cases. Existing
  `app.test.ts` "attachment routes" tests must pass **unchanged**. Do not
  edit `app.test.ts`.
- Keep `exactOptionalPropertyTypes` happy. Never assign `undefined` to
  optional fields; omit them instead.
- Use `withAsyncDomainErrorTranslation` only if the imitated code does. Do
  not introduce new error classes.

## Tests (input -> expected)

`auth.test.ts`, new `describe("resolveApiKeyViewerFromToken")`. Imitate the
existing `describe("resolveViewerFromToken")` setup in the same file.

- Valid issued key -> an `API_KEY` viewer with its scopes.
- Revoked key -> `null`.
- Expired key -> `null`.
- Unknown well-formed key -> `null`.
- A session stored under a token string `ybm_0123456789ab_x` -> `null`; the
  session table is never consulted.
- `"session-token"` (malformed) -> `null`, and `tokenHasher.hash` is not
  called.
- The existing `resolveViewerFromToken` tests are still green.

`trash.test.ts`:

- MAIL_MANAGE key on the message domain -> returns `1`; the message carries
  the Trash tag; one MessageUpdated event.
- A second call -> returns `1`; the message still exists; no new event.
- MAIL_READ-only key -> returns `0`; no tag added.
- Out-of-scope address -> `0`.
- Trash tag deleted from the fake store -> `SERVICE_UNAVAILABLE`, and the
  message is still stored.

`attachment-uploads.test.ts`:

- Stage 3 bytes -> a staged attachment with `messageId null` and the blob
  stored.
- `bytes.byteLength = MAX + 1` -> `BAD_USER_INPUT`, nothing stored.
- Empty name and type -> `attachment` and `application/octet-stream`.
- `readAttachment` on a staged id -> `NOT_FOUND`.
- Unreadable message -> `NOT_FOUND`.
- `includeBody: false` -> `blob: null`, and the blob store `get` is not
  called (spy).
- Missing blob with `includeBody: true` -> `NOT_FOUND`.

## Verification (run from repo root; record exit code and log path)

1. `bunx vitest run packages/application/src/usecases/auth.test.ts packages/application/src/usecases/trash.test.ts packages/application/src/usecases/attachment-uploads.test.ts 2>&1 | tee /tmp/mcp-server-01-unit.log`
   - Expected: exit 0, with a "Tests N passed" line where N > 0.
2. `bunx vitest run packages/infrastructure/src/http 2>&1 | tee /tmp/mcp-server-01-http.log`
   - Expected: exit 0. Proves the REST behavior is unchanged.
3. `bunx vitest run packages/application 2>&1 | tee /tmp/mcp-server-01-app.log`
   - Expected: exit 0. No regression.
4. `bun run typecheck 2>&1 | tee /tmp/mcp-server-01-typecheck.log`
   - Expected: exit 0.
   - A failure located only in files owned by a concurrently running wave-1
     plan is recorded and re-run after that plan reports done.
5. `bunx biome check <each writePaths source file> 2>&1 | tee /tmp/mcp-server-01-biome.log`
   - Expected: exit 0.
6. `wc -l packages/application/src/usecases.ts packages/application/src/usecases/auth.ts packages/infrastructure/src/http/attachments.ts`
   - Expected: every file under 1000 lines.

## Done criteria

- [ ] Four new `UseCases` members exist, with the pinned signatures.
- [ ] Verification steps 1-6 pass, with logs recorded.
- [ ] `git diff --quiet -- packages/application/src/usecases/messages.ts packages/infrastructure/src/http/app.test.ts`
      exits 0 (both files untouched).

## Worker protocol

- Before each edit, re-read the file and record `shasum -a 256 <file>`.
  Record it again after the edit.
- On drift (the hash differs from your last post-edit hash), re-read and
  merge only this plan's intent. Never revert another plan's edits.
- Edit only the writePaths. Update only this plan's Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.
- No git commit, push, stash, reset or checkout. No worktrees or branches.
- No repository-wide formatter. Use `bunx biome check --write <own files>`
  only.
- Put evidence under `tmp/mcp-server-s316/mcp-server-01-application-usecases/<attempt>/`.

## Progress Log

(empty)
