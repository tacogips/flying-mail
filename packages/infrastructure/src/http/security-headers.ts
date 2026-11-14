import type { MiddlewareHandler } from "hono";

/** Baseline headers applied to every response.
 *
 * `nosniff` and `X-Frame-Options` matter most on the attachment/file-link
 * routes, where the bytes are attacker-supplied by definition, but applying
 * them uniformly means a future route cannot forget them. */
const BASELINE_HEADERS: readonly (readonly [string, string])[] = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["x-frame-options", "DENY"],
  ["cross-origin-opener-policy", "same-origin"],
];

/** CSP for the SPA shell.
 *
 * `frame-src 'self'` is required: the web client renders HTML mail inside a
 * sandboxed same-origin iframe. `object-src 'none'` and
 * `base-uri 'self'` close the two most common bypasses. */
const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function applySecurityHeaders(
  response: Response,
  includeCsp: boolean,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of BASELINE_HEADERS) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  if (includeCsp && !headers.has("content-security-policy")) {
    headers.set("content-security-policy", HTML_CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("text/html");
}

/** Registered before every other middleware so its `await next()` spans the
 * whole request.
 *
 * The CSP is only added to HTML responses: attachment and file-link
 * responses set their own, much stricter, `Content-Security-Policy:
 * sandbox`, and overwriting that would weaken the stored-XSS boundary. */
export function createSecurityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res === undefined) {
      return;
    }
    c.res = applySecurityHeaders(c.res, isHtmlResponse(c.res));
  };
}
