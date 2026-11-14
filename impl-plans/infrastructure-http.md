# HTTP Infrastructure Implementation Plan

**Status**: Completed
**Design Reference**: design-docs/specs/design-graphql-api.md#binary-rest-routes,
design-docs/specs/design-api-keys-and-permissions.md#sessions
**Created**: 2026-08-23
**Last Updated**: 2026-08-23

---

## Design Document Reference

### Summary
The hono app shared by every runtime target: auth middleware, security
headers, the `/graphql` handler, the attachment REST routes, the
`/files/:token` capability route, and the composition root.

### Scope
**Included**: `packages/infrastructure/src/{http/**,composition/**}`.
**Excluded**: GraphQL internals, Worker entry points.

---

## Modules

### 1. Auth middleware

#### packages/infrastructure/src/http/auth-middleware.ts

**Status**: NOT_STARTED

```typescript
const SESSION_COOKIE_NAME = "mailcal_session";

interface AuthVariables { viewer: Viewer | null; token: string | null; }

function extractBearerToken(req: Request): string | null;
function extractSessionCookie(req: Request): string | null;
function isPlainHttpLocalhost(req: Request): boolean;
function isCrossOriginRequest(req: Request, publicOrigin: string | null): boolean;

interface SessionCookieRenderOptions { readonly secure: boolean; }
function buildSetSessionCookieHeader(
  token: string, expiresAt: Date, options: SessionCookieRenderOptions): string;
function buildClearSessionCookieHeader(options: SessionCookieRenderOptions): string;

function createAuthMiddleware(
  usecases: UseCases,
  deps?: Pick<AppDependencies, "clock" | "sessionRepository" | "instanceConfig">,
): MiddlewareHandler<{ Variables: AuthVariables }>;
```

Behavior: prefer the bearer header, fall back to the cookie; never throw for a
missing or invalid credential (leave `viewer: null` and let resolvers decide);
enforce the CSRF `Origin` backstop for non-safe-method requests that presented
the **cookie** (bearer requests exempt; a malformed `Origin` fails closed; an
absent `Origin` is treated as safe); sweep expired sessions at most once per
isolate via `c.executionCtx.waitUntil()` when available, falling back to plain
fire-and-forget with its own `.catch()`.

**Checklist**:
- [ ] All functions
- [ ] Unit tests: bearer, cookie, both, neither, malformed bearer, cross-origin
      cookie POST rejected, cross-origin bearer POST allowed, GET exempt,
      `Secure` omitted only on plain-HTTP loopback

#### packages/infrastructure/src/http/security-headers.ts

**Status**: NOT_STARTED

```typescript
function applySecurityHeaders(response: Response, includeCsp: boolean): Response;
function createSecurityHeadersMiddleware(): MiddlewareHandler;
```

Sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin` and, for
HTML responses, a CSP with `default-src 'self'` and `frame-src` permitting the
sandboxed mail-body iframe.

**Checklist**:
- [ ] Both functions with tests

---

### 2. Binary routes

#### packages/infrastructure/src/http/attachments.ts

**Status**: NOT_STARTED

```typescript
interface UploadAttachmentResponse {
  readonly id: string; readonly fileName: string; readonly contentType: string;
  readonly size: number; readonly url: string; readonly createdAt: string;
}
function createAttachmentRoutes(deps: AppDependencies, usecases: UseCases):
  Hono<{ Variables: AuthVariables }>;
```

Routes: `POST /attachments` (multipart field `file`, viewer required) and
`GET /attachments/:id` (viewer required). Oversized requests are rejected from
`Content-Length` before the body is parsed, with `file.size` as a backstop.

#### packages/infrastructure/src/http/file-links.ts

**Status**: NOT_STARTED

```typescript
function createFileLinkRoutes(deps: AppDependencies, usecases: UseCases): Hono;
/** Shared by both download surfaces. */
function buildDownloadResponse(
  body: ReadableStream, contentType: string, contentLength: number,
  fileName: string, forceDownload: boolean): Response;
function encodeContentDisposition(
  disposition: "inline" | "attachment", fileName: string): string;
```

`GET /:token` is deliberately unauthenticated -- the token is the credential,
so the route must not consult `c.get("viewer")` at all. Every failure mode
collapses to an identical `404` JSON body. Responses always carry
`nosniff` and `Content-Security-Policy: sandbox`, and force an `attachment`
disposition outside a small inline-safe allowlist (`image/png`, `image/jpeg`,
`image/gif`, `image/webp`, `application/pdf`, `text/plain`) -- never
`text/html` or `image/svg+xml`. `encodeContentDisposition` emits RFC 5987
`filename*` plus a quote-stripped ASCII fallback so a crafted file name cannot
inject header directives.

**Checklist**:
- [ ] Both route modules
- [ ] Unit tests: upload happy path, missing field, oversized by header,
      oversized by body, unauthenticated; download inline vs forced,
      non-ASCII filename encoding, quote injection stripped;
      file link expired/revoked/exhausted/unknown all returning an identical
      404, and a valid token succeeding without any credential

---

### 3. App assembly and composition

#### packages/infrastructure/src/http/app.ts

**Status**: NOT_STARTED

```typescript
interface CreateAppOptions {
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly graphiql: boolean;
  readonly onNotFound?: (c: Context) => Promise<Response>;
  /** Registers POST /dev/inbound; only ever passed when graphiql is true. */
  readonly enableDevInbound?: boolean;
}
function createApp(options: CreateAppOptions): Hono<{ Variables: AuthVariables }>;
```

Order: security headers, auth middleware, `/graphql`, `/api/*` attachment
routes, `/files/*`, a JSON 404 for unmatched `/api/*` (so an API client never
gets the SPA's HTML 200), then `onNotFound`. `app.onError` logs and masks
everything as a generic JSON 500. The yoga instance and schema are cached per
`graphiql` value so they are built at most once per isolate.

After `yoga.fetch()`, queued `SessionCookieIntent`s are rendered into
`Set-Cookie` headers (`append`, not `set`) and `cache-control: no-store` is
forced on every GraphQL response.

#### packages/infrastructure/src/composition/config.ts

**Status**: NOT_STARTED

```typescript
type BlobBackend = "r2" | "s3" | "memory";
type SqlBackend = "d1" | "sqlite";

interface BuildDependenciesConfig {
  readonly sqlBackend: SqlBackend;
  readonly d1?: D1DatabaseLike;
  readonly sqliteUrl?: string;
  readonly blobBackend: BlobBackend;
  readonly r2?: R2BucketLike;
  readonly s3?: S3Config;
  readonly email?: CloudflareSendEmailBinding;
  readonly mailFrom?: CloudflareSenderAddress;
  readonly publicOrigin?: string;
  readonly signupMode?: SignupMode;
  readonly spamThreshold?: number;
  readonly fileLinkMaxTtlSeconds?: number;
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly tokenHasher?: TokenHasher;
}

class PublicOriginConfigurationError extends Error {}
class MailConfigurationError extends Error {}

function resolvePublicOrigin(env: Record<string, string | undefined>): string | undefined;
function resolveMailFrom(env: Record<string, string | undefined>): CloudflareSenderAddress | undefined;
function assertMailOriginConsistency(params: {
  mailFrom: CloudflareSenderAddress | undefined; publicOrigin: string | undefined }): void;
function resolveSignupMode(env: Record<string, string | undefined>): SignupMode;
function resolveSpamThreshold(env: Record<string, string | undefined>): number;
function resolveFileLinkMaxTtl(env: Record<string, string | undefined>): number;
function loadConfigFromEnv(env: Record<string, string | undefined>): BuildDependenciesConfig;
```

A set-but-invalid `MAILCAL_PUBLIC_ORIGIN` throws rather than silently disabling
login; a configured `MAILCAL_MAIL_FROM` without a resolvable origin throws too,
because that combination mails links that cannot work.

#### packages/infrastructure/src/composition/build-dependencies.ts

**Status**: NOT_STARTED

```typescript
class BuildDependenciesError extends Error {}
function buildDependencies(config: BuildDependenciesConfig): AppDependencies;
```

Resolves the SQL and blob backends (throwing when a selected backend lacks its
binding), constructs every repository over the resolved database, wires the
MIME parser/builder, and selects the Cloudflare mail sender only when both a
binding and a verified `mailFrom` are present -- otherwise
`createUnavailableMailSender()`.

**Checklist**:
- [ ] App assembly with route ordering and cookie rendering
- [ ] Config resolution with both configuration errors
- [ ] Composition root with missing-binding errors
- [ ] Unit tests: route precedence (`/api/unknown` is JSON 404, not the SPA),
      `no-store` on GraphQL responses, cookie append, missing D1 binding,
      missing R2 binding, invalid public origin, mail-without-origin

---

## Module Status

| Module | File Path | Status | Tests |
|--------|-----------|--------|-------|
| Auth middleware | `packages/infrastructure/src/http/auth-middleware.ts` | NOT_STARTED | - |
| Security headers | `packages/infrastructure/src/http/security-headers.ts` | NOT_STARTED | - |
| Attachments | `packages/infrastructure/src/http/attachments.ts` | NOT_STARTED | - |
| File links | `packages/infrastructure/src/http/file-links.ts` | NOT_STARTED | - |
| App | `packages/infrastructure/src/http/app.ts` | NOT_STARTED | - |
| Config | `packages/infrastructure/src/composition/config.ts` | NOT_STARTED | - |
| Composition root | `packages/infrastructure/src/composition/build-dependencies.ts` | NOT_STARTED | - |

## Tasks

### TASK-001: Auth middleware and security headers

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/infrastructure/src/http/{auth-middleware,security-headers}.ts`
**Dependencies**: infrastructure-graphql:TASK-002

**Completion Criteria**:
- [ ] Token extraction, cookie rendering, CSRF backstop, session sweep
- [ ] Security header middleware
- [ ] Unit tests as listed

### TASK-002: Attachment and file-link routes

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/infrastructure/src/http/{attachments,file-links}.ts`
**Dependencies**: TASK-001

**Completion Criteria**:
- [ ] Upload/download with size caps and disposition rules
- [ ] `/files/:token` unauthenticated, uniform 404 on every failure
- [ ] Unit tests as listed

### TASK-003: Composition config and root

**Status**: Not Started
**Parallelizable**: Yes
**Deliverables**: `packages/infrastructure/src/composition/{config,build-dependencies}.ts`
**Dependencies**: adapter-layer:TASK-005

**Completion Criteria**:
- [ ] Env resolution with both configuration errors
- [ ] Backend selection with missing-binding errors
- [ ] Unit tests as listed

### TASK-004: App assembly

**Status**: Not Started
**Parallelizable**: No
**Deliverables**: `packages/infrastructure/src/http/app.ts`
**Dependencies**: TASK-001, TASK-002, TASK-003, infrastructure-graphql:TASK-004

**Completion Criteria**:
- [ ] Route ordering, yoga caching, cookie rendering, `no-store`
- [ ] Masked 500 backstop
- [ ] Unit tests as listed

## Dependencies

| Feature | Depends On | Status |
|---------|------------|--------|
| This plan | `infrastructure-graphql.md`, `adapter-layer.md` | BLOCKED until Phase 3 |

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

- **Previous**: `impl-plans/infrastructure-graphql.md`
- **Next**: `impl-plans/app-api-migrations.md`

### Session: 2026-08-23 (implementation)
**Tasks Completed**: All tasks in this plan
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Implemented, unit/integration tested, lint and typecheck clean.
