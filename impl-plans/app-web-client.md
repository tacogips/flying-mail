# Web Mail Client Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-web-client.md
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
`apps/web`: the SolidJS mail client -- GraphQL transport, app store, routes,
shell, mailbox/message views, compose, tagging, and the domain/API-key
settings pages.

### Scope
**Included**: `apps/web/src/**`.
**Excluded**: server code; the CLI's proxy (see `app-cli.md`).

---

## Modules

### 1. Transport and types

#### apps/web/src/api/graphql-client.ts

**Status**: NOT_STARTED

```typescript
type GraphQLErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_USER_INPUT"
  | "CONFLICT" | "SERVICE_UNAVAILABLE" | "UNKNOWN";

interface GraphQLClientError {
  readonly message: string; readonly code: GraphQLErrorCode;
  readonly path?: readonly (string | number)[];
}
type GraphQLResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly errors: readonly GraphQLClientError[] };

interface SessionStore {
  isEstablished(): boolean; markEstablished(): void; clear(): void;
}

function graphqlRequest<TData, TVariables extends Record<string, unknown>>(
  query: string, variables?: TVariables,
  options?: { signal?: AbortSignal }): Promise<GraphQLResult<TData>>;
function publicGraphqlRequest<TData, TVariables extends Record<string, unknown>>(
  /* same */): Promise<GraphQLResult<TData>>;
```

The session credential is the server-set `HttpOnly` cookie -- the client never
holds a token. `sessionStore` is an in-memory signal meaning "the last viewer
query succeeded", re-derived on every load. Any `UNAUTHENTICATED` response
clears it centrally so `AuthGuard` redirects without every call site checking.
`publicGraphqlRequest` uses `credentials: "omit"` so an unauthenticated-by-
design call is never influenced by an existing session.

#### apps/web/src/api/schema-types.ts

**Status**: NOT_STARTED

Hand-written TypeScript mirrors of the GraphQL types the client selects, plus
the query/mutation document constants. No codegen step -- one file, kept in
sync with `schema.graphql.ts`.

#### apps/web/src/api/documents.ts

**Status**: NOT_STARTED

Every GraphQL document string used by the app, named
`MESSAGES_QUERY`, `MESSAGE_QUERY`, `THREAD_QUERY`, `SEND_MESSAGE_MUTATION`,
`TAG_MESSAGES_MUTATION`, `MARK_SPAM_MUTATION`, `CREATE_ATTACHMENT_LINK_MUTATION`,
`DOMAINS_QUERY`, `CREATE_DOMAIN_MUTATION`, `API_KEYS_QUERY`,
`CREATE_API_KEY_MUTATION`, and so on.

**Checklist**:
- [ ] Client, types, documents
- [ ] Unit tests: error mapping per code, network failure, missing `data`,
      `UNAUTHENTICATED` clearing the session store, public request omitting
      credentials

---

### 2. Store

#### apps/web/src/store/app-store.ts (+ `-documents.ts`, `-helpers.ts`)

**Status**: NOT_STARTED

```typescript
interface AppStore {
  readonly viewer: Accessor<ViewerView | null>;
  readonly domains: Accessor<readonly MailDomainView[]>;
  readonly tags: Accessor<readonly TagView[]>;
  readonly messages: Accessor<readonly MessageView[]>;
  readonly selectedMessageIds: Accessor<ReadonlySet<string>>;
  readonly filter: Accessor<MessageFilterView>;
  readonly loading: Accessor<boolean>;
  rehydrateSession(): Promise<void>;
  loadMessages(reset: boolean): Promise<void>;
  loadMore(): Promise<void>;
  setFilter(filter: Partial<MessageFilterView>): void;
  toggleSelection(id: string): void;
  tagSelected(tagIds: readonly string[]): Promise<void>;
  untagSelected(tagIds: readonly string[]): Promise<void>;
  markSelectedSpam(spam: boolean): Promise<void>;
  markSelectedRead(read: boolean): Promise<void>;
  deleteSelected(): Promise<void>;
  send(input: SendMessageFormValues): Promise<GraphQLResult<MessageView>>;
  createAttachmentLink(attachmentId: string, ttlSeconds: number):
    Promise<string | null>;
}
function createAppStore(): AppStore;
```

Tag, read and spam mutations apply optimistically and roll back on error with
a toast. Split across three files so none exceeds 1000 lines.

**Checklist**:
- [ ] Store with all members
- [ ] Unit tests: optimistic apply and rollback, cursor accumulation on
      `loadMore`, filter change resetting the list

---

### 3. Shell, routes and guards

#### apps/web/src/{main.tsx,app.tsx,routes.tsx}
#### apps/web/src/lib/route-guards.tsx
#### apps/web/src/components/{app-shell,topbar,mailbox-sidebar,toast-shelf,route-error-boundary}.tsx

**Status**: NOT_STARTED

Routes exactly as listed in `design-web-client.md#routes`, page components
lazily imported, `AuthGuard`/`AdminGuard` wrapping the protected ones, and a
route error boundary around each.

**Checklist**:
- [ ] Entry, app, routes, guards, shell components with their `.css` files
- [ ] Unit test: guard redirects an unauthenticated viewer to `/login`

---

### 4. Mail views

#### apps/web/src/components/{message-list,message-view,html-body-frame,attachment-tile,tag-chip,tag-picker,spam-banner,compose-form}.tsx
#### apps/web/src/pages/{mailbox-page,thread-page,message-page,compose-page,search-page,login-page,email-auth-verify-page}.tsx

**Status**: NOT_STARTED

`html-body-frame.tsx` is the security-critical one:

```typescript
interface HtmlBodyFrameProps {
  readonly html: string;
  readonly loadRemoteImages: boolean;
}
/** Sanitizes with DOMPurify, then renders into a sandboxed iframe with
 *  `sandbox` set to no tokens at all (no allow-same-origin, no
 *  allow-scripts). Remote image sources are stripped and stashed on a
 *  data attribute until `loadRemoteImages` is true. */
function HtmlBodyFrame(props: HtmlBodyFrameProps): JSX.Element;
```

**Checklist**:
- [ ] All components and pages with their `.css` files
- [ ] Unit tests for `sanitizeMailHtml`: `<script>` removed, `onerror=`
      attribute removed, `javascript:` href removed, remote `<img src>`
      stripped when images are blocked and restored when allowed

#### apps/web/src/lib/*.ts

**Status**: NOT_STARTED

Pure helpers, each independently tested: `mail-html.ts` (sanitize + image
gating), `relative-time.ts`, `address-format.ts` (display of
`Name <addr@example.com>`), `filter-params.ts` (URL query <-> filter),
`scope-format.ts` (rendering an `ApiKeyScope` as a readable line),
`quote-reply.ts` (building a quoted reply body and subject prefix),
`mutation-error.ts`, `toast.ts`.

**Checklist**:
- [ ] Eight helper modules
- [ ] Unit tests for each

---

### 5. Settings

#### apps/web/src/pages/settings/{settings-layout,domains-page,api-keys-page,tags-page}.tsx
#### apps/web/src/components/{domain-form,dns-record-table,api-key-form,scope-builder,secret-reveal}.tsx

**Status**: NOT_STARTED

`scope-builder` edits rows of `(capability, domain, addressPattern)` and
validates the pattern client-side with the same grammar the server enforces.
`secret-reveal` shows a newly issued key exactly once with a copy button and
an explicit "you will not see this again" warning; the value lives in a signal
cleared on navigation and is never persisted.

**Checklist**:
- [ ] All settings pages and components with `.css`
- [ ] Unit test: the client-side address-pattern validator agrees with the
      grammar in `design-domain-model.md` (same accept/reject table)

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| GraphQL client | `apps/web/src/api/graphql-client.ts` | NOT_STARTED | - |
| Documents/types | `apps/web/src/api/{documents,schema-types}.ts` | NOT_STARTED | - |
| Store | `apps/web/src/store/app-store*.ts` | NOT_STARTED | - |
| Shell/routes | `apps/web/src/{main,app,routes}.tsx`, `components/app-shell.tsx` | NOT_STARTED | - |
| Mail views | `apps/web/src/components/*.tsx`, `apps/web/src/pages/*.tsx` | NOT_STARTED | - |
| Helpers | `apps/web/src/lib/*.ts` | NOT_STARTED | - |
| Settings | `apps/web/src/pages/settings/*.tsx` | NOT_STARTED | - |

## Tasks

### TASK-001: GraphQL client, documents and pure helpers

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `apps/web/src/api/*.ts`, `apps/web/src/lib/*.ts`
**Dependencies**: infrastructure-graphql:TASK-004

**Completion Criteria**:
- [ ] Client with typed error mapping and the two request flavors
- [ ] All documents and view types
- [ ] Eight helper modules, each unit tested
- [ ] `sanitizeMailHtml` rejects script, event handlers and `javascript:` URLs

### TASK-002: App store

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/web/src/store/app-store*.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] All store members
- [ ] Optimistic mutation rollback tested
- [ ] Files under 1000 lines

### TASK-003: Shell, routing and mail views

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/web/src/{main,app,routes}.tsx`,
`apps/web/src/components/*.tsx`, `apps/web/src/pages/*.tsx`
**Dependencies**: TASK-002

**Completion Criteria**:
- [ ] Every route from the design doc, guarded
- [ ] Sandboxed HTML body frame with image gating
- [ ] `vite build` succeeds

### TASK-004: Settings pages

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `apps/web/src/pages/settings/*.tsx`,
`apps/web/src/components/{domain-form,dns-record-table,api-key-form,scope-builder,secret-reveal}.tsx`
**Dependencies**: TASK-003

**Completion Criteria**:
- [ ] Domain, API key and tag management
- [ ] Scope builder with client-side pattern validation
- [ ] Secret shown once, never persisted

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `infrastructure-graphql.md` | BLOCKED until Phase 4 |

## Completion Criteria

- [ ] All modules implemented
- [ ] All tests passing
- [ ] Type checking passes
- [ ] `bun run --cwd apps/web build` succeeds

## Progress Log

### Session: 2026-08-23 (planning)
**Tasks Completed**: None yet
**Tasks In Progress**: Plan authored
**Blockers**: None
**Notes**: Initial plan

## Related Plans

- **Previous**: `impl-plans/app-api-migrations.md`
- **Next**: `impl-plans/app-cli.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
