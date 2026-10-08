# Realtime Push 05: GraphQL Surface, Subscription Executor and CSP

**Status**: Ready
**Plan ID**: realtime-push-05-graphql-surface-and-executor
**Wave**: 2 (phase 23)
**Depends On**: realtime-push-01-contracts-and-persistence
**Design Reference**: design-docs/specs/design-realtime-push.md sections 5.1-5.4, 6.2 (subscribe validation, per-subscription scope/after), 6.3 (executor, per-subscription validated args), 9.3 (CSP)
**Created**: 2026-10-08

## Intent and context

This plan:

- adds the subscription SDL and resolvers, with the HTTP/SSE path closed;
- builds the runtime-neutral executor that validates one `subscribe`
  payload and executes one event for one subscription (graphql-js 17
  `validateSubscriptionArgs` and `executeSubscriptionEvent`);
- adds `connect-src 'self'` to both CSP strings.

The hub (plan 08) consumes the executor through the contract pinned below.

## Non-goals

- No protocol or socket handling and no drain (plan 08).
- No `apps/api` edits.
- No change to any existing Query/Mutation SDL or resolver behaviour.
- Do not widen CSP beyond the single `connect-src 'self'` directive.

## writePaths

- packages/infrastructure/src/graphql/schema-realtime.graphql.ts (new)
- packages/infrastructure/src/graphql/resolvers/realtime.ts (new)
- packages/infrastructure/src/graphql/schema.ts
- packages/infrastructure/src/graphql/schema-realtime.test.ts (new)
- packages/infrastructure/src/realtime/mail-event-payload.ts (new)
- packages/infrastructure/src/realtime/executor.ts (new)
- packages/infrastructure/src/realtime/executor.test.ts (new)
- packages/infrastructure/package.json (exports entry `./realtime/*`)
- packages/infrastructure/src/http/security-headers.ts
- packages/infrastructure/src/http/security-headers.test.ts
- apps/web/public/_headers
- impl-plans/active/realtime-push-05-graphql-surface-and-executor.md (progress log only)

sharedPaths: none.

## Pinned contracts (plan 08 depends on these)

```ts
// realtime/mail-event-payload.ts
export type MailEventPayloadType = MailEventType | "LIVE";
export interface MailEventPayload {
  readonly cursor: string;
  readonly type: MailEventPayloadType;
  readonly messageId: string | null;     // null only for LIVE
  readonly domainId: string | null;      // null only for LIVE
  readonly addresses: readonly string[]; // full stored set; the resolver filters per viewer
  readonly occurredAt: string;
}
// realtime/executor.ts
export interface SubscribeRequest { readonly query: string; readonly operationName?: string | null; readonly variables?: Record<string, unknown> | null }
export interface PreparedSubscription { readonly scope: MailEventScope; readonly after: string | null; /* + opaque validated args, private */ }
export type PrepareResult = { readonly ok: true; readonly prepared: PreparedSubscription } | { readonly ok: false; readonly errors: readonly GraphQLFormattedError[] };
export interface SubscriptionExecutor {
  prepare(request: SubscribeRequest, viewer: Viewer): PrepareResult;
  execute(prepared: PreparedSubscription, payload: MailEventPayload, viewer: Viewer): Promise<FormattedExecutionResult>;
}
export function createSubscriptionExecutor(options: { readonly schema: GraphQLSchema; readonly deps: AppDependencies; readonly usecases: UseCases; readonly publicOrigin: string | null }): SubscriptionExecutor;
```

## File-level changes

### SDL (`schema-realtime.graphql.ts`)

- Exactly design 5.1: `enum MailEventType` (including `LIVE`),
  `input MailEventScope`, `type MailEvent`, `type Subscription`.
- Add doc strings that state that `scope` is a filter and not a grant, and
  that `message` is null when the message was deleted or is unreadable.

### Resolvers (`resolvers/realtime.ts`)

- `subscriptionResolvers.mailEvents`:
  - `subscribe` always throws `badUserInputError("Subscriptions are served only over WebSocket (graphql-transport-ws) at /graphql")`,
    using the helper in `graphql/errors.ts:42`.
  - `resolve: (source) => source.mailEvents`.
- `mailEventResolvers`:
  - `addresses`: `[]` for LIVE. Otherwise keep only the entries for which
    `authorizesAnyAddress(ctx.viewer, Capability.MailRead, payload.domainId, [address])`
    holds.
  - `message`: `null` for LIVE or a null viewer. Otherwise call
    `ctx.usecases.getMessage(viewer, id)` (`usecases.ts:270`, same
    signature as the Query resolver in `resolvers/query.ts`). Map a
    `null` result or a `NotFoundError` to `null`, and rethrow anything else.
  - All other fields are plain property access.

### `schema.ts`

Append `realtimeTypeDefs` to `typeDefs`, and add `Subscription:
subscriptionResolvers` and `MailEvent: mailEventResolvers` to the
resolver map.

### Executor (`realtime/executor.ts`)

`prepare` steps, in order. Each failure returns `{ ok: false, errors }`
with `extensions.code`:

1. **Parse.** The `DocumentNode` **may** be cached in a small `Map` keyed by
   the SHA-256 hex of the query text, at most 64 entries, evict oldest.
   Only the parsed document may be cached.
2. **Limits.** `documentDepth(doc) <= DEFAULT_MAX_DEPTH` (`depth-limit.ts:86`)
   and `documentSelectionCount(doc) <= DEFAULT_MAX_SELECTIONS`
   (`selection-limit.ts:31`). Otherwise `BAD_USER_INPUT`.
3. **Validate** with `graphql`'s `validate(schema, doc)`.
4. **Shape.** Select the operation by `operationName`. It must be a
   `subscription` with exactly one root selection, the field `mailEvents`
   (an alias is allowed). Fragments at the root are not allowed. Otherwise
   `BAD_USER_INPUT`.
5. **Validated args.** Call `validateSubscriptionArgs({ schema, document,
   variableValues, operationName, contextValue: placeholderContext })`. An
   array result means errors: return them formatted.
6. **Arguments.** Coerce the `mailEvents` field arguments from **this
   request's** variables (graphql 17 `getArgumentValues` on the field
   definition and the selected field node with the validated
   `variableValues`).
   - `scope.address`: trimmed and lower-cased, and must parse with the
     domain `EmailAddress` factory. Otherwise `BAD_USER_INPUT` with
     `field: "scope.address"`.
   - `scope.domainId`: passed through unchanged.
   - `after`: string or null. It is not parsed here; plan 08 validates it.
7. Return a `PreparedSubscription` that holds the validated args and the
   coerced `scope` and `after`. Validated args live **inside this object
   only**. Never put them in a shared cache. Two subscriptions with the
   same query text and different variables must stay independent; this is
   review finding F1.

`execute`:

- `contextValue = buildGraphQLContext({ viewer, token: null, requestOrigin: publicOrigin, clientIp: null, deps, usecases })`,
  built fresh for every call (`graphql/context.ts:53`).
- Call `executeSubscriptionEvent({ ...validatedArgs, rootValue: { mailEvents: payload }, contextValue })`.
- Map errors through `toGraphQLError` (`graphql/errors.ts:103`) and return
  the formatted result. The function never throws for resolver errors.

### `package.json`

Add `"./realtime/*": "./src/realtime/*.ts"` to `exports`.

### CSP

- `security-headers.ts`: add `connect-src 'self'` to `HTML_CSP`,
  immediately after `default-src 'self'`.
- `apps/web/public/_headers`: add the identical directive to the
  `Content-Security-Policy` line.
- `security-headers.test.ts`: extend the existing equality test. Assert:
  - `HTML_CSP` contains `connect-src 'self'` verbatim;
  - neither CSP string contains `ws:` or `wss:`;
  - the only `https:` origin is still `https://challenges.cloudflare.com`
    (existing assertion).

## Pitfalls

- Do not cache `ValidatedSubscriptionArgs` by query text. This is the F1
  defect.
- `rootValue` must be `{ mailEvents: payload }`. The field resolver unwraps
  it.
- yoga's own SSE subscription path must return the error, not hang.
  `subscribe` throws synchronously.
- `schema.graphql.ts` (876 lines) is **not** edited. Everything goes into
  the new SDL file.
- Do not import `apps/*` or any socket types into `executor.ts`.

## Tests

**`schema-realtime.test.ts`** (`createGraphQLHarness`,
`graphql-test-support.ts:83`):

- A `subscription { mailEvents { cursor } }` sent over the HTTP harness ->
  an error with code `BAD_USER_INPUT`, and the request completes.
  - If yoga rejects earlier with its own error, assert that an error is
    returned without data and record the actual code in the progress log.
- Introspection lists `Subscription.mailEvents` with the arguments `scope`
  and `after`.
- An existing `messages` query still works. This is a smoke regression.

**`executor.test.ts`** (fake deps from plan 01, real
`buildGraphQLSchema()`):

- A valid document with `scope: { address: " Support@X.com " }` -> ok, with
  scope address `support@x.com`.
- Depth 13 -> `BAD_USER_INPUT`.
- Two root fields, a query operation, or an unknown field ->
  `ok: false`.
- A bad address -> `BAD_USER_INPUT` with `field: "scope.address"`.
- **F1 regression:**
  - Prepare S1 and S2 from the **identical** query text with
    `$s = {domainId: "A"}` and `$s = {domainId: "B"}` -> `S1.scope.domainId === "A"`
    and `S2.scope.domainId === "B"`.
  - Execute both with a payload whose selection echoes the args -> each
    result reflects its own variables.
- `execute` of a `MESSAGE_RECEIVED` payload for a readable message ->
  `data.mailEvents.message.id` set, and `addresses` filtered to the
  viewer's readable subset (the viewer has an ALLOW only on one of two
  addresses).
- A payload for a deleted message -> `message: null`, no errors.
- A LIVE payload -> `messageId: null`, `addresses: []`, `message: null`.

**CSP:** the extended assertions listed above.

## Verification (repo root)

1. `bunx vitest run packages/infrastructure/src/graphql packages/infrastructure/src/realtime packages/infrastructure/src/http`:
   exit 0.
2. `bun run --cwd packages/infrastructure typecheck`: exit 0.
3. `bunx biome check packages/infrastructure/src`: exit 0.
4. `grep -c "connect-src 'self'" packages/infrastructure/src/http/security-headers.ts apps/web/public/_headers`:
   each prints 1.

## Done criteria

- [ ] The pinned contracts are exported exactly.
- [ ] The F1 regression test passes.
- [ ] Verification steps 1-4 pass, with outputs recorded.

## Progress Log

### Session: (not started)
**Tasks Completed**: none
**Hashes**: -
**Verification evidence**: -
