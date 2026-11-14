import type { AppDependencies } from "@mailcal/application/dependencies";
import type { UseCases } from "@mailcal/application/usecases";
import { type Context, Hono } from "hono";
import { buildGraphQLContext } from "../graphql/context";
import { buildGraphQLSchema, createGraphQLYoga } from "../graphql/schema";
import { createAttachmentRoutes } from "./attachments";
import {
  type AuthVariables,
  buildClearSessionCookieHeader,
  buildSetSessionCookieHeader,
  createAuthMiddleware,
  isPlainHttpLocalhost,
} from "./auth-middleware";
import { createFileLinkRoutes } from "./file-links";
import {
  applySecurityHeaders,
  createSecurityHeadersMiddleware,
} from "./security-headers";

/** Scheme + host of the request: the `Origin` header when present (every
 * browser fetch sets it), else the request URL's own origin. Never throws. */
function resolveRequestOrigin(req: Request): string | null {
  const originHeader = req.headers.get("origin");
  if (originHeader !== null && originHeader.length > 0) {
    try {
      return new URL(originHeader).origin;
    } catch {
      // Malformed Origin -- fall through to the request URL.
    }
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

/** The schema and its yoga wrapper are entirely request-independent: the
 * SDL never changes, and yoga's only per-call input (`graphiql`) is fixed
 * for a given execution target. Both are non-trivial to construct, so each
 * variant is built at most once per isolate instead of per request.
 *
 * Keyed by `graphiql` rather than being a single module constant so a test
 * suite that builds both variants in one process still gets the right one. */
const graphqlServerCache = new Map<
  boolean,
  ReturnType<typeof createGraphQLYoga>
>();

function getGraphQLYoga(
  graphiql: boolean,
): ReturnType<typeof createGraphQLYoga> {
  const cached = graphqlServerCache.get(graphiql);
  if (cached !== undefined) {
    return cached;
  }
  const yoga = createGraphQLYoga(buildGraphQLSchema(), { graphiql });
  graphqlServerCache.set(graphiql, yoga);
  return yoga;
}

export interface CreateAppOptions {
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  /** Enables the GraphiQL UI on `GET /graphql`. True for the local server,
   * false in production. */
  readonly graphiql: boolean;
  /** Invoked only when no route matched. The Worker wires this to
   * `env.ASSETS.fetch()` for the SPA fallthrough; the local server has no
   * bundled assets and omits it. */
  readonly onNotFound?: (c: Context) => Promise<Response>;
  /** Registers the dev-only inbound-mail route. Never enabled in
   * production -- it accepts a raw message with no authentication, which is
   * exactly what makes it useful locally and unacceptable anywhere else. */
  readonly devInbound?: (c: Context) => Promise<Response>;
}

/** Assembles the single hono app shared by every execution target.
 *
 * Route order matters and is deliberate: security headers wrap everything;
 * auth resolves the viewer for every request; `/graphql`; the authenticated
 * `/api/*` binary routes; the credential-free `/files/*` route; a JSON 404
 * for unmatched `/api/*` (so an API client never receives the SPA's HTML
 * with a 200); then the SPA fallthrough. */
export function createApp(
  options: CreateAppOptions,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", createSecurityHeadersMiddleware());
  app.use("*", createAuthMiddleware(options.usecases, options.deps));

  const yoga = getGraphQLYoga(options.graphiql);

  app.all("/graphql", async (c) => {
    const context = buildGraphQLContext({
      viewer: c.get("viewer"),
      token: c.get("token"),
      requestOrigin: resolveRequestOrigin(c.req.raw),
      deps: options.deps,
      usecases: options.usecases,
    });
    const response = await yoga.fetch(
      c.req.raw,
      context as unknown as Record<string, unknown>,
    );
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");

    // Resolvers only record cookie *intent*; only this layer knows whether
    // `Secure` applies. `append`, not `set`, so multiple `Set-Cookie` values
    // survive -- though in practice one operation queues at most one.
    const cookieOptions = { secure: !isPlainHttpLocalhost(c.req.raw) };
    for (const intent of context.sessionCookies.intents) {
      headers.append(
        "set-cookie",
        intent.kind === "set"
          ? buildSetSessionCookieHeader(
              intent.token,
              intent.expiresAt,
              cookieOptions,
            )
          : buildClearSessionCookieHeader(cookieOptions),
      );
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });

  app.route("/api", createAttachmentRoutes(options.deps, options.usecases));
  app.route("/files", createFileLinkRoutes(options.usecases));

  if (options.devInbound !== undefined) {
    const devInbound = options.devInbound;
    app.post("/dev/inbound", (c) => devInbound(c));
  }

  // After the specific `/api/*` mounts, so it only catches genuinely
  // unmatched API paths. Without it, an unrecognized `/api/*` request falls
  // through to the SPA and returns `200 text/html` -- indistinguishable, to
  // an API client, from a working but empty response.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (options.onNotFound !== undefined) {
    const onNotFound = options.onNotFound;
    app.notFound((c) => onNotFound(c));
  }

  // Last-resort backstop: logs and masks anything that escaped every
  // route's own handling, mirroring the GraphQL layer's masking. No raw
  // error message or stack trace ever reaches a client.
  app.onError((err, c) => {
    console.error("Unhandled request error", err);
    // The security-headers middleware's `next()` never resolves on this
    // path, so the baseline headers are applied here directly.
    return applySecurityHeaders(
      c.json({ error: "Internal server error" }, 500),
      false,
    );
  });

  return app;
}
