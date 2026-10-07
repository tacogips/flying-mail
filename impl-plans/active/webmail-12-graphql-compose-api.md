# Webmail 12: GraphQL Compose API (SDL extension, resolvers, use-case wiring)

**Status**: Ready
**planId**: webmail-12-graphql-compose-api
**Wave**: 3 (depends on webmail-06-send-drafts-forward, webmail-09-compose-prefill, webmail-04-rest-attachments-limits, webmail-05-web-api-contract)
**Design Reference**: design-docs/specs/design-webmail-completion.md section 3 (exact SDL), D12; section 6 (deleteDraft); section 4 (forward inputs)
**Created**: 2026-10-07

## Intent and context

This plan exposes the new behavior through GraphQL, which is the only data
API. Every UI capability needs a GraphQL operation. The SDL is split
across `typeDefs` documents merged in
`packages/infrastructure/src/graphql/schema.ts:buildGraphQLSchema`.

`schema.graphql.ts` is 841 lines and `resolvers/mutation.ts` is 740, so
new SDL goes in a new extension document and new resolvers in a new
module (D12).

The web client mirror (webmail-05) already expects these exact field
names. Do not rename anything.

Use cases available:
- webmail-06: `usecases.deleteDraft`; `SendMessageInput`/`SaveDraftInput`
  now accept `replyTo`, `forwardedFromMessageId`, `forwardAttachmentIds`.
- webmail-09: `createComposeUseCases(deps)` returning
  `{composeFromMessage, listReadableAddresses, getMailLimits}`.

## Non-goals

- No changes to existing SDL types beyond `extend`.
- No CLI changes.
- No REST changes.

## Shared rules (all webmail plans)

- English only, no emojis. Never run git commit, stash, reset, checkout or
  push. Preserve the 251 uncommitted rename changes.
- No deploy, no remote wrangler.
- Re-read each file before editing it, and record its sha256 before and
  after in the Progress Log. If it drifted, re-read and merge.
- Edit only `writePaths`/`sharedPaths`.
- Update only this plan's checkboxes and Progress Log. Never edit
  `impl-plans/PROGRESS.json` or `impl-plans/README.md`.

## Write ownership

**writePaths**
- `packages/infrastructure/src/graphql/schema-compose.graphql.ts`
- `packages/infrastructure/src/graphql/schema-compose.test.ts`
- `packages/infrastructure/src/graphql/resolvers/compose.ts`
- `packages/infrastructure/src/graphql/schema.ts`
- `packages/infrastructure/src/graphql/resolvers/mutation.ts` (sendMessage/saveDraft input mapping only)
- `impl-plans/active/webmail-12-graphql-compose-api.md` (checkboxes and Progress Log only)

**sharedPaths**
- `packages/application/src/usecases.ts`: add the compose use cases only.
  webmail-06 already added `deleteDraft`; keep it.
- `apps/web/src/api/schema-types.ts`: fix field-name drift against the
  SDL only. webmail-05 created it, and this plan depends on webmail-05 so
  the edit is serialized. webmail-11, which may run in the same wave, does
  not edit this file.

## File-level changes

### packages/infrastructure/src/graphql/schema-compose.graphql.ts (new)

Export `composeTypeDefs`, imitating `schema-templates.graphql.ts`. Use the
SDL from design section 3 verbatim:
- `enum ComposeMode`
- `extend input SendMessageInput` and `extend input SaveDraftInput`, each
  with `replyTo: String`, `forwardedFromMessageId: ID`,
  `forwardAttachmentIds: [ID!]`
- `extend type Message { replyTo: String forwardedFromMessageId: ID }`
- `extend type Viewer { readableAddresses: [String!]! }`
- `type ComposePrefill` and `type MailLimits`
- `extend type Query { composeFromMessage(messageId: ID!, mode: ComposeMode!): ComposePrefill! mailLimits: MailLimits! }`
- `extend type Mutation { deleteDraft(id: ID!): Boolean! }`

Add doc strings that say:
- `SaveDraftInput.attachmentIds` is the complete set of the draft's own
  attachments.
- `forwardAttachmentIds` must belong to `forwardedFromMessageId`.

### packages/infrastructure/src/graphql/resolvers/compose.ts (new)

- `composeQueryResolvers`:
  - `composeFromMessage`: map args to
    `createMessageId(args.messageId)` and the mode.
  - `mailLimits`: no viewer required beyond authentication. Call
    `requireViewerOrThrow`.
- `composeMutationResolvers.deleteDraft`.
- `composeViewerResolvers.readableAddresses`: calls
  `ctx.usecases.listReadableAddresses(source.viewer)`.
- `ComposePrefill` needs no resolvers. `forwardAttachments` returns domain
  `Attachment` objects, which the existing `Attachment` type resolvers
  handle (url and so on).
- Imitate `resolvers/mutation.ts` (`requireViewerOrThrow`, id
  constructors) and `resolvers/types.ts` (`viewerResolvers`).

### packages/infrastructure/src/graphql/schema.ts

- Add `composeTypeDefs` to `typeDefs`.
- Spread `composeQueryResolvers` and `composeMutationResolvers` into
  Query and Mutation.
- Set `Viewer: { ...viewerResolvers, ...composeViewerResolvers }`.

### packages/infrastructure/src/graphql/resolvers/mutation.ts (sendMessage/saveDraft input mapping only)

- `saveDraft` args and the mapping (around lines 420-460) pass through the
  new fields:
  - `replyTo`
  - `forwardedFromMessageId` (via `createMessageId`)
  - `forwardAttachmentIds` (via `createAttachmentId`)
  - Use the same `== null ? {} : {...}` style.
- `toSendMessageInput` / `SendMessageArg` get the same fields. Locate them
  with `rg -n "toSendMessageInput|SendMessageArg" packages/infrastructure`.
- Make no other changes in this file.

### packages/application/src/usecases.ts

- Add `composeFromMessage`, `listReadableAddresses` and `getMailLimits`
  to the `UseCases` interface, typed via `ComposeUseCases`.
- Spread `...createComposeUseCases(deps)` in the factory.
- Do not touch the `deleteDraft` entry webmail-06 added.

### apps/web/src/api/schema-types.ts (shared; verification only)

- Diff the field names against the new SDL. If webmail-05 deviated, fix
  the mirror here and log it.
- Do not change anything else.

## Tests (new packages/infrastructure/src/graphql/schema-compose.test.ts)

Use `createGraphQLHarness` from `graphql-test-support.ts`, imitating
`schema-templates.test.ts`.
- `composeFromMessage(REPLY_ALL)` on a readable inbound message -> to/cc
  as computed, and `inReplyToMessageId` equals the message id.
- On an unreadable id -> `extensions.code` NOT_FOUND.
- `composeFromMessage(FORWARD)` -> `forwardAttachments` with id and
  fileName, and `forwardedFromMessageId` set.
- `mailLimits` -> `{5242880, 5242880, 32, 50}`.
- `viewer { readableAddresses }` -> the ACTIVE readable addresses.
- `saveDraft` with `forwardedFromMessageId` + `forwardAttachmentIds` ->
  the returned draft has attachments with new ids, and
  `forwardedFromMessageId` is set.
- `sendMessage` with `bcc`, `html`, `replyTo` -> the fake sender received
  `bcc` and `replyTo`.
- `deleteDraft` on a draft -> true. Querying that message afterwards ->
  null.
- `deleteDraft` on a sent message -> NOT_FOUND.
- `saveDraft` updating a draft that was already sent -> CONFLICT or
  NOT_FOUND.
- `sendMessage` with an attachmentId of another message -> NOT_FOUND.
- `Message { replyTo forwardedFromMessageId }` resolves.

## Invariants

- Existing operations and their signatures are unchanged.
- Error codes come from the existing `toGraphQLError` mapping, with
  CONFLICT and NOT_FOUND already mapped.

## Verification (repo root; log exit codes)

- `bunx vitest run packages/infrastructure packages/application` -> exit 0.
- Server-workspace typecheck:
  `bun run --cwd packages/domain typecheck && bun run --cwd packages/application typecheck && bun run --cwd packages/adapter typecheck && bun run --cwd packages/infrastructure typecheck && bun run --cwd apps/api typecheck && bun run --cwd apps/cli typecheck`
  -> exit 0. Do not use the root `bun run typecheck`: webmail-11 may still
  be editing apps/web in this wave.
- Conditional web typecheck: run `bun run --cwd apps/web typecheck` only
  if this plan actually edited `apps/web/src/api/schema-types.ts`.
  - It must report no error in `schema-types.ts`.
  - Errors in webmail-11 writePaths are tolerated only while webmail-11 is
    still in progress. Log them with their file paths.
  - Any other error is a failure of this plan.
  - Never edit webmail-11's files. webmail-13 (`mise run lint`) is the
    final authority for the web typecheck.
- `bunx biome check packages/infrastructure/src/graphql packages/application/src/usecases.ts --diagnostic-level=warn`
  -> no diagnostics.
- `wc -l packages/infrastructure/src/graphql/resolvers/mutation.ts packages/application/src/usecases.ts`
  -> each under 1000.

## Completion criteria

- [ ] The SDL extension and resolvers are wired.
- [ ] The use cases are wired.
- [ ] The input pass-through is in place.
- [ ] All tests pass.
- [ ] The web mirror is verified.
- [ ] Verification is logged with exit codes. The server-workspace
      typecheck exits 0. When `schema-types.ts` was edited, the
      conditional web typecheck shows no error in it, and any tolerated
      webmail-11 errors are logged.

## Progress Log

### Session: (not started)
**Tasks Completed**: None
