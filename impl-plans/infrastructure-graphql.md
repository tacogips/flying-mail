# GraphQL Infrastructure Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-graphql-api.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
The executable GraphQL schema, its resolvers, per-request loaders, error
mapping and the yoga server wrapper.

### Scope
**Included**: `packages/infrastructure/src/graphql/**`.
**Excluded**: hono app, auth middleware, REST routes, composition.

---

## Modules

### 1. SDL

#### packages/infrastructure/src/graphql/schema.graphql.ts

**Status**: NOT_STARTED

```typescript
/** The full SDL from design-graphql-api.md, as a template literal. */
export const typeDefs: string;
```

Must match `design-docs/specs/design-graphql-api.md#schema` exactly: the
`DateTime` scalar, ten enums, the `MailDomain` / `Message` / `MailboxAddress` /
`Attachment` / `Tag` / `Thread` / `ApiKey` / `ApiKeyScope` /
`ApiKeyWithSecret` / `FileLink` / `MessagePage` / `DnsRecord` / `Viewer` /
`AuthPayload` types, the `MessageFilter` / `SendMessageInput` /
`CreateApiKeyInput` / `ApiKeyScopeInput` / `HeaderInput` inputs, and every
listed `Query`/`Mutation` field.

**Checklist**:
- [ ] SDL constant
- [ ] A test that `buildGraphQLSchema()` parses it and that every design-doc
      field name is present (guards against drift between doc and schema)

---

### 2. Context and loaders

#### packages/infrastructure/src/graphql/context.ts

**Status**: NOT_STARTED

```typescript
type SessionCookieIntent =
  | { readonly kind: "set"; readonly token: string; readonly expiresAt: Date }
  | { readonly kind: "clear" };

interface SessionCookieCollector {
  setSession(token: string, expiresAt: Date): void;
  clearSession(): void;
  readonly intents: readonly SessionCookieIntent[];
}

interface GraphQLContext {
  readonly viewer: Viewer | null;
  readonly token: string | null;
  readonly requestOrigin: string | null;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly loaders: RequestLoaders;
  readonly sessionCookies: SessionCookieCollector;
}

function buildGraphQLContext(params: { /* viewer, token, requestOrigin, deps, usecases */ }):
  GraphQLContext;
```

Resolvers record cookie *intent* only; `http/app.ts` renders the header,
because only it knows whether `Secure` applies.

#### packages/infrastructure/src/graphql/loaders.ts

**Status**: NOT_STARTED

```typescript
interface RequestLoaders {
  readonly recipientsByMessage: BatchLoader<MessageId, readonly MessageRecipient[]>;
  readonly attachmentsByMessage: BatchLoader<MessageId, readonly Attachment[]>;
  readonly tagsByMessage: BatchLoader<MessageId, readonly Tag[]>;
  readonly fetchStateByMessage: BatchLoader<MessageId, MessageFetchState | null>;
  readonly domainById: BatchLoader<DomainId, MailDomain | null>;
  readonly scopesByApiKey: BatchLoader<ApiKeyId, readonly ApiKeyScope[]>;
  readonly messageCountByTag: BatchLoader<TagId, number>;
}
function createRequestLoaders(deps: AppDependencies, viewer: Viewer | null): RequestLoaders;
```

A minimal hand-rolled batch loader (microtask-coalesced, per-request cache
only, no cross-request caching -- stale authorization data must never survive
a request).

**Checklist**:
- [ ] Context + cookie collector
- [ ] Seven loaders over a shared `createBatchLoader` helper
- [ ] Unit tests: coalescing (one repository call for N keys), missing key
      yields the empty/null default, no cache leaks between loader instances

---

### 3. Errors and limits

#### packages/infrastructure/src/graphql/errors.ts

**Status**: NOT_STARTED

```typescript
type ErrorCode = ApplicationErrorCode | "INTERNAL_SERVER_ERROR";

function unauthenticatedError(message?: string): GraphQLError;
function forbiddenError(message?: string): GraphQLError;
function notFoundError(entity: string, id: string): GraphQLError;
function badUserInputError(message: string, field?: string): GraphQLError;
function conflictError(message: string): GraphQLError;
function serviceUnavailableError(message: string): GraphQLError;
/** Maps any thrown value onto a coded GraphQLError; unknown errors are
 *  masked as INTERNAL_SERVER_ERROR with no original message. */
function toGraphQLError(err: unknown): GraphQLError;
```

`toGraphQLError` must unwrap `GraphQLError.originalError` (graphql-js's
`locatedError` re-wraps every resolver throw and drops `extensions`), re-wrap
the mapped result with the outer error's `path`/`locations`, match
`GraphQLError` and `MailDeliveryError` **structurally by `.name`** rather than
`instanceof` (duplicate module identities and cross-package classes), and map
`MailDeliveryError` to `SERVICE_UNAVAILABLE`.

#### packages/infrastructure/src/graphql/{depth-limit,selection-limit}.ts

**Status**: NOT_STARTED

```typescript
function useDepthLimit(maxDepth?: number): Plugin;        // default 12
function useSelectionLimit(maxSelections?: number): Plugin; // default 2000
```

**Checklist**:
- [ ] Error factories and `toGraphQLError`
- [ ] Both envelop plugins
- [ ] Unit tests: each mapping, unwrapping a located error, masking an
      unknown error, a too-deep document rejected before execution

---

### 4. Resolvers

#### packages/infrastructure/src/graphql/resolvers/query.ts
#### packages/infrastructure/src/graphql/resolvers/mutation.ts
#### packages/infrastructure/src/graphql/resolvers/types.ts
#### packages/infrastructure/src/graphql/resolvers/helpers.ts

**Status**: NOT_STARTED

```typescript
const queryResolvers: QueryResolvers;       // viewer, domains, domain,
                                            // messages, message, thread, tags,
                                            // apiKeys, fileLinks
const mutationResolvers: MutationResolvers; // every mutation in the SDL
const messageResolvers, threadResolvers, tagResolvers, mailDomainResolvers,
      attachmentResolvers, apiKeyResolvers, apiKeyScopeResolvers,
      fileLinkResolvers, viewerResolvers: TypeResolvers;

/** helpers.ts */
function requireViewerOrThrow(ctx: GraphQLContext): Viewer;
function toDateTime(iso: string | null): string | null;
function parseIdArg<T>(value: string, create: (v: string) => T, field: string): T;
```

Field resolvers use `ctx.loaders` exclusively -- no resolver may call a
repository directly, or `messages { attachments { ... } }` becomes N+1.
`Message.fetchStatus`/`fetchedAt` resolve through `fetchStateByMessage`
(`FETCHED` for user viewers). `MailDomain.verificationToken` returns `null`
unless the viewer holds `DOMAIN_ADMIN`. `ApiKeyWithSecret.secret` is passed
through from the mutation result and never re-read from storage.

Each resolver module stays under 1000 lines; split `mutation.ts` into
`mutation-mail.ts` / `mutation-admin.ts` re-exported from `mutation.ts` if it
grows past that.

**Checklist**:
- [ ] Query, Mutation and type resolvers for every SDL field
- [ ] Loader-only field resolution
- [ ] Unit tests per resolver group with fake use cases, plus an N+1
      regression test asserting one repository call for a 10-message list

---

### 5. Schema assembly

#### packages/infrastructure/src/graphql/schema.ts

**Status**: NOT_STARTED

```typescript
function buildGraphQLSchema(): GraphQLSchema;
function createGraphQLYoga(schema: GraphQLSchema, options: { graphiql: boolean }):
  ReturnType<typeof createYoga<Record<string, unknown>, GraphQLContext>>;
```

Yoga is configured with `maskedErrors.maskError: toGraphQLError` and the two
limit plugins, and its `context` factory passes the pre-built
`GraphQLContext` through unchanged.

**Checklist**:
- [ ] Both functions
- [ ] An end-to-end test executing a query and a mutation against fakes

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| SDL | `packages/infrastructure/src/graphql/schema.graphql.ts` | NOT_STARTED | - |
| Context | `packages/infrastructure/src/graphql/context.ts` | NOT_STARTED | - |
| Loaders | `packages/infrastructure/src/graphql/loaders.ts` | NOT_STARTED | - |
| Errors | `packages/infrastructure/src/graphql/errors.ts` | NOT_STARTED | - |
| Limits | `packages/infrastructure/src/graphql/{depth,selection}-limit.ts` | NOT_STARTED | - |
| Resolvers | `packages/infrastructure/src/graphql/resolvers/*.ts` | NOT_STARTED | - |
| Schema | `packages/infrastructure/src/graphql/schema.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: SDL, errors and limit plugins

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/infrastructure/src/graphql/{schema.graphql,errors,depth-limit,selection-limit}.ts`
**Dependencies**: application-usecases-admin:TASK-005

**Completion Criteria**:
- [ ] SDL matching the design doc
- [ ] `toGraphQLError` with structural matching and located-error unwrapping
- [ ] Both plugins with tests

### TASK-002: Context and loaders

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/infrastructure/src/graphql/{context,loaders}.ts`
**Dependencies**: application-usecases-admin:TASK-005

**Completion Criteria**:
- [ ] Context with the session-cookie collector
- [ ] Seven batch loaders with coalescing tests

### TASK-003: Resolvers

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/infrastructure/src/graphql/resolvers/*.ts`
**Dependencies**: TASK-001, TASK-002

**Completion Criteria**:
- [ ] Every SDL field resolved
- [ ] Loader-only field resolution, with an N+1 regression test
- [ ] `verificationToken` hidden from non-admins
- [ ] Files under 1000 lines

### TASK-004: Schema assembly

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/infrastructure/src/graphql/schema.ts`
**Dependencies**: TASK-003

**Completion Criteria**:
- [ ] `buildGraphQLSchema` and `createGraphQLYoga`
- [ ] End-to-end query and mutation test

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `application-usecases-admin.md`, `application-usecases-mail.md` | BLOCKED until Phase 3 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: Initial plan

## Related Plans

- **Previous**: `impl-plans/application-usecases-admin.md`
- **Next**: `impl-plans/infrastructure-http.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
