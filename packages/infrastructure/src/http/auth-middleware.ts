import type { AppDependencies } from "@mailcal/application/dependencies";
import type { Viewer } from "@mailcal/application/policies";
import type { UseCases } from "@mailcal/application/usecases";
import type { Context, MiddlewareHandler } from "hono";

/** Name of the `HttpOnly` cookie the web client's session lives in. */
export const SESSION_COOKIE_NAME = "mailcal_session";

/** Hono context variables set by {@link createAuthMiddleware}. `token` is
 * the raw presented credential, which is not derivable from `viewer` and is
 * needed as-is by `logout`. */
export interface AuthVariables {
  viewer: Viewer | null;
  token: string | null;
}

const BEARER_PREFIX = "Bearer ";

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}

/** Methods with no state-changing effect, exempt from the CSRF origin
 * check. Every mutating operation in this API is a `POST`; there are no
 * `GET` side effects for a cross-site navigation to trigger. */
const CSRF_SAFE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
]);

/** True only for plain HTTP to a loopback host -- the one case where the
 * session cookie's `Secure` attribute must be omitted, since a browser
 * refuses to store a `Secure` cookie set over plain HTTP at all. Everything
 * else, including plain HTTP to a non-loopback host, is treated as needing
 * `Secure`. */
export function isPlainHttpLocalhost(req: Request): boolean {
  try {
    const url = new URL(req.url);
    return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function requestOwnOrigin(req: Request): string | null {
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

/** CSRF backstop for cookie-authenticated requests.
 *
 * `SameSite=Lax` is the first line of defence; this catches what gets
 * through it, notably a cross-site `<form>` POST. Bearer-authorized
 * requests are exempt: a forged cross-site request cannot set an
 * `Authorization` header. An absent `Origin` is treated as safe -- every
 * modern browser sends it on POST, so its absence means a non-browser
 * client (which uses bearer auth anyway). A malformed `Origin` fails
 * closed. */
export function isCrossOriginRequest(
  req: Request,
  publicOrigin: string | null,
): boolean {
  const originHeader = req.headers.get("origin");
  if (originHeader === null || originHeader.length === 0) {
    return false;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return true;
  }
  const allowedOrigin = publicOrigin ?? requestOwnOrigin(req);
  return allowedOrigin === null || originUrl.origin !== allowedOrigin;
}

export function extractSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (part.slice(0, separatorIndex).trim() !== SESSION_COOKIE_NAME) {
      continue;
    }
    const value = part.slice(separatorIndex + 1).trim();
    return value.length === 0 ? null : decodeURIComponent(value);
  }
  return null;
}

export interface SessionCookieRenderOptions {
  readonly secure: boolean;
}

function sharedCookieAttributes(options: SessionCookieRenderOptions): string {
  const parts = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** `expiresAt` mirrors the session's own expiry, so the cookie never
 * outlives -- or expires well before -- the session it carries. */
export function buildSetSessionCookieHeader(
  token: string,
  expiresAt: Date,
  options: SessionCookieRenderOptions,
): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    sharedCookieAttributes(options),
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

export function buildClearSessionCookieHeader(
  options: SessionCookieRenderOptions,
): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    sharedCookieAttributes(options),
    "Max-Age=0",
  ].join("; ");
}

/** Per-isolate latch so the expiry sweep fires at most once per running
 * instance, not once per request. */
let hasSweptExpiredAuth = false;

/** Best-effort cleanup, at most once per isolate, on the first
 * authenticated request. Failures are swallowed: an expired session is
 * already rejected during resolution whether or not this has run.
 *
 * On Workers, async work not registered with `waitUntil()` can be cancelled
 * once the response is returned -- a plain fire-and-forget promise would
 * frequently never run while the latch stayed set. `c.executionCtx` only
 * exists when the caller supplied one, so this falls back to
 * fire-and-forget (with its own `.catch`) elsewhere. */
function sweepExpiredAuthOnce(
  c: Context<{ Variables: AuthVariables }>,
  usecases: UseCases,
): void {
  if (hasSweptExpiredAuth) {
    return;
  }
  hasSweptExpiredAuth = true;
  const sweep = usecases.sweepExpiredAuth().catch(() => {
    // Cleanup failure must never affect the request.
  });
  try {
    c.executionCtx.waitUntil(sweep);
  } catch {
    // No ExecutionContext on this path; `sweep` already has its own catch.
  }
}

/** Resets the once-per-isolate latch. Exported for tests, which need each
 * case to start from the same state. */
export function resetAuthSweepLatchForTesting(): void {
  hasSweptExpiredAuth = false;
}

/** Global middleware: resolves a bearer token or session cookie to a
 * `Viewer` and puts it on the context.
 *
 * Never throws for a missing or invalid credential -- it leaves
 * `viewer: null` and lets resolvers and routes enforce authentication
 * themselves, so an expired credential yields a clean `UNAUTHENTICATED`
 * rather than a 500. */
export function createAuthMiddleware(
  usecases: UseCases,
  deps?: Pick<AppDependencies, "instanceConfig">,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const bearerToken = extractBearerToken(c.req.raw);
    const cookieToken =
      bearerToken === null ? extractSessionCookie(c.req.raw) : null;

    if (cookieToken !== null && !CSRF_SAFE_METHODS.has(c.req.method)) {
      const publicOrigin = deps?.instanceConfig.publicOrigin ?? null;
      if (isCrossOriginRequest(c.req.raw, publicOrigin)) {
        return c.json({ error: "Cross-origin request rejected" }, 403);
      }
    }

    const token = bearerToken ?? cookieToken;
    if (token === null) {
      c.set("viewer", null);
      c.set("token", null);
      await next();
      return;
    }

    const viewer = await usecases.resolveViewerFromToken(token);
    c.set("viewer", viewer);
    c.set("token", token);
    if (viewer !== null) {
      sweepExpiredAuthOnce(c, usecases);
    }
    await next();
    return;
  };
}
