import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { flagBoolean, flagNumber, flagString, type ParsedArgs } from "../args";
import { requireEndpoint } from "../client";
import type { CliConfig } from "../config";
import { maskApiKey } from "../config";
import { isLoopbackHost } from "../endpoint";
import { CliError, ExitCode } from "../exit-codes";

// Re-exported so existing importers keep a stable path.
export { isLoopbackHost };

export interface ClientServeOptions {
  readonly port: number;
  readonly host: string;
  readonly distDir: string;
  readonly endpoint: string;
  /** Injected as a bearer header on proxied API calls. `null` whenever
   * injection would be unsafe -- see {@link resolveClientServeOptions}. */
  readonly apiKey: string | null;
  readonly open: boolean;
}

export const DEFAULT_PORT = 5173;
export const DEFAULT_HOST = "127.0.0.1";

/** Paths proxied to the flying-mail deployment; everything else is served from
 * the local bundle. */
const PROXY_PREFIXES: readonly string[] = ["/graphql", "/api/", "/files/"];

/** Hop-by-hop headers that must not be forwarded, plus `host`, which has to
 * be the upstream's rather than the local listener's. */
const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export function shouldProxy(pathname: string): boolean {
  return PROXY_PREFIXES.some(
    (prefix) =>
      pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix),
  );
}

/** Default bundle location: `apps/web/dist`, resolved relative to this
 * file so the command works from any working directory. */
export function defaultDistDir(): string {
  return fileURLToPath(new URL("../../../web/dist", import.meta.url));
}

/**
 * Resolves and validates serve options.
 *
 * The security rule lives here: the API key is injected into proxied
 * requests **only** when the listener is bound to a loopback address. A
 * key-injecting proxy reachable from the network is an open relay for that
 * key -- anyone who can route to the port inherits its full scope. So a
 * non-loopback `--host` requires explicit `--allow-remote` *and* disables
 * injection entirely; without the flag it is a usage error rather than a
 * silent downgrade.
 */
export function resolveClientServeOptions(
  args: ParsedArgs,
  config: CliConfig,
): ClientServeOptions {
  const host = flagString(args, "host") ?? DEFAULT_HOST;
  const allowRemote = flagBoolean(args, "allow-remote");
  const loopback = isLoopbackHost(host);

  if (!loopback && !allowRemote) {
    throw new CliError(
      `Refusing to bind ${host}: pass --allow-remote to serve on a non-loopback address. ` +
        "Note that doing so disables API key injection, so the browser client must authenticate itself.",
      ExitCode.UsageError,
    );
  }

  return {
    port: flagNumber(args, "port") ?? DEFAULT_PORT,
    host,
    distDir: flagString(args, "dist") ?? defaultDistDir(),
    endpoint: requireEndpoint(config),
    apiKey: loopback ? config.apiKey : null,
    open: flagBoolean(args, "open"),
  };
}

function contentTypeFor(filePath: string): string {
  return (
    CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Resolves a request path to an absolute path guaranteed to sit inside
 * `distDir`, or `null` when it cannot be resolved at all.
 *
 * Two layers, in order:
 *
 * 1. The path is percent-decoded first, so an encoded traversal
 *    (`%2e%2e%2f`) is seen for what it is -- the URL parser does not decode
 *    these, and pattern-matching the raw input would miss them.
 * 2. `normalize` on the absolute path clamps `..` at the root, so
 *    `/../../etc/passwd` becomes `/etc/passwd` and joins *into* `distDir`
 *    rather than above it.
 *
 * The explicit root comparison below is the backstop that makes the
 * guarantee independent of step 2's clamping behaviour: whatever the
 * platform's `normalize` does, a result outside the root is rejected. */
export function resolveStaticPath(
  distDir: string,
  pathname: string,
): string | null {
  const root = resolve(distDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(join(root, normalize(decoded)));
  return candidate === root || candidate.startsWith(`${root}${sep}`)
    ? candidate
    : null;
}

async function readStaticFile(filePath: string): Promise<Uint8Array | null> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) {
      return null;
    }
    return new Uint8Array(await readFile(filePath));
  } catch {
    return null;
  }
}

/** Formats a hostname for a `Host` header, bracketing bare IPv6 literals. */
function hostHeaderName(host: string): string {
  const lower = host.trim().toLowerCase();
  return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
}

/** `Host` header values the loopback listener answers to: the configured
 * listen address plus the usual loopback spellings, each with the port. */
export function allowedHostHeaders(
  options: Pick<ClientServeOptions, "host" | "port">,
): ReadonlySet<string> {
  const names = [
    hostHeaderName(options.host),
    "localhost",
    "127.0.0.1",
    "[::1]",
  ];
  return new Set(names.map((name) => `${name}:${options.port}`));
}

function forbidden(reason: string): Response {
  return Response.json({ error: reason }, { status: 403 });
}

/** Browser-origin defences for the key-injecting proxy.
 *
 * Injecting the API key makes the listener an authenticated relay, and a
 * browser will happily send requests to `127.0.0.1` on behalf of any web
 * page. Two attacks follow, and each is closed by one check:
 *
 * - **CSRF**: a cross-site page POSTs to the listener (a form post is a
 *   "simple" request and needs no preflight). The browser always attaches
 *   an `Origin` header to such a POST, so any `Origin` that is not this
 *   listener itself is refused.
 * - **DNS rebinding**: a page on `attacker.example` re-points its name at
 *   127.0.0.1, making requests same-origin from the browser's view and
 *   so carrying no cross-origin `Origin`. The `Host` header still names
 *   the attacker's domain, so requiring an exact loopback `Host` stops it.
 *
 * Returns the rejection, or `null` when the request may proceed. */
export function checkProxyOrigin(
  request: Request,
  options: Pick<ClientServeOptions, "host" | "port">,
): Response | null {
  const allowed = allowedHostHeaders(options);
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (host === undefined || !allowed.has(host)) {
    return forbidden("Forbidden: unexpected Host header");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const normalized = origin.trim().toLowerCase();
    const matches = [...allowed].some(
      (entry) => normalized === `http://${entry}`,
    );
    if (!matches) {
      return forbidden("Forbidden: cross-origin request");
    }
  }
  return null;
}

function isJsonContentType(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.trim()
      .toLowerCase()
      .startsWith("application/json") === true
  );
}

async function proxyRequest(
  request: Request,
  options: ClientServeOptions,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target = `${options.endpoint}${incoming.pathname}${incoming.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (options.apiKey !== null) {
    headers.set("authorization", `Bearer ${options.apiKey}`);
  }

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(target, init);
    // Rebuilt rather than returned directly so hop-by-hop response headers
    // (notably a mismatched content-length) do not leak through.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        error: `Upstream request failed: ${
          error instanceof Error ? error.message : "network error"
        }`,
      },
      { status: 502 },
    );
  }
}

/** Builds the serving app: proxy for API paths, static bundle for the rest,
 * with an SPA fallback so client-side routes resolve on a hard reload. */
export function createClientServeApp(options: ClientServeOptions): Hono {
  const app = new Hono();

  app.all("*", async (c) => {
    const url = new URL(c.req.url);

    if (shouldProxy(url.pathname)) {
      const request = c.req.raw;
      // The proxy is same-origin only, so there is never a legitimate
      // preflight. Answering locally -- with no CORS headers -- also means
      // a cross-origin page cannot learn that the listener exists.
      if (request.method === "OPTIONS") {
        return forbidden("Forbidden: cross-origin requests are not supported");
      }
      // Only a key-injecting listener holds a credential worth stealing.
      // Without injection (`--allow-remote`) the browser authenticates
      // itself and the listener is expected to be reached by arbitrary
      // hostnames, so the Host/Origin pinning does not apply.
      if (options.apiKey !== null) {
        const rejection = checkProxyOrigin(request, options);
        if (rejection !== null) {
          return rejection;
        }
      }
      // A cross-site form can only send form-encoded, multipart or text/plain
      // bodies; requiring JSON keeps GraphQL out of reach of such requests.
      if (
        url.pathname.startsWith("/graphql") &&
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !isJsonContentType(request)
      ) {
        return Response.json(
          { error: "GraphQL requests must use Content-Type: application/json" },
          { status: 415 },
        );
      }
      return proxyRequest(request, options);
    }

    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = resolveStaticPath(options.distDir, requested);
    if (filePath === null) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const file = await readStaticFile(filePath);
    if (file !== null) {
      return new Response(file as unknown as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": contentTypeFor(filePath) },
      });
    }

    // SPA fallback: an unknown path is a client-side route, not a missing
    // asset -- unless it looks like one, in which case a 404 is honest.
    if (extname(url.pathname).length > 0) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const indexPath = resolveStaticPath(options.distDir, "/index.html");
    const index = indexPath === null ? null : await readStaticFile(indexPath);
    if (index === null) {
      return Response.json(
        {
          error: `No built client found at ${options.distDir}. Run \`mise run build-web\` first.`,
        },
        { status: 500 },
      );
    }
    return new Response(index as unknown as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });

  return app;
}

export interface ServeHandle {
  readonly url: string;
  stop(): void;
}

/** Starts the listener. Split from {@link createClientServeApp} so the app
 * is testable without binding a port. */
export function startClientServe(
  options: ClientServeOptions,
  app: Hono,
): ServeHandle {
  const url = `http://${options.host}:${options.port}`;
  if (typeof Bun === "undefined") {
    throw new CliError(
      "`flying-mail client serve` currently requires the Bun runtime",
      ExitCode.GeneralError,
    );
  }
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: app.fetch,
  });
  return { url, stop: () => server.stop() };
}

export function describeServe(options: ClientServeOptions): string {
  const lines = [
    `flying-mail client serving ${options.distDir}`,
    `  local:    http://${options.host}:${options.port}`,
    `  endpoint: ${options.endpoint}`,
  ];
  lines.push(
    options.apiKey === null
      ? "  api key:  not injected (the browser client must authenticate itself)"
      : `  api key:  ${maskApiKey(options.apiKey)} (injected on proxied requests)`,
  );
  return lines.join("\n");
}
