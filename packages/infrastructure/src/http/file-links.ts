import {
  limitFailOpen,
  type RateLimiter,
} from "@flying-mail/application/ports/rate-limiter";
import type { UseCases } from "@flying-mail/application/usecases";
import { type Context, Hono } from "hono";
import { buildDownloadResponse } from "./downloads";

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/** Minted tokens are 32 random bytes in unpadded base64url: always exactly
 * 43 characters. Anything else cannot match a link, so it is rejected
 * before any hashing or storage lookup. */
const FILE_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface FileLinkRouteOptions {
  /** Null when the deployment has no rate limiter configured. */
  readonly rateLimiter: RateLimiter | null;
  /** Null result (or an absent resolver) disables limiting for the request:
   * without a trustworthy client address there is nothing safe to key on. */
  readonly resolveClientIp?: ((c: Context) => string | null) | undefined;
}

/** The temp-file-link download surface.
 *
 * **Unauthenticated by design**: the token in the path *is* the credential,
 * so this route must never consult the session cookie or bearer header. That
 * is the whole point -- an agent can hand the URL to a tool, a person, or
 * another service without also handing over its API key.
 *
 * Every failure mode -- unknown token, expired, revoked, exhausted, missing
 * blob, or an unexpected storage error -- collapses to the same 404, so a
 * caller can never distinguish "wrong token" from "no such link" and cannot
 * probe for valid tokens. */
export function createFileLinkRoutes(
  usecases: UseCases,
  options: FileLinkRouteOptions = { rateLimiter: null },
): Hono {
  const app = new Hono();

  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    if (!FILE_LINK_TOKEN_PATTERN.test(token)) {
      return notFound();
    }

    // Unauthenticated and guessable-in-principle, so throttled per client.
    // After the format check so malformed probes cost nothing.
    if (options.rateLimiter !== null) {
      const clientIp = options.resolveClientIp?.(c) ?? null;
      if (clientIp !== null) {
        // Fails open: a limiter outage must not break downloads.
        const allowed = await limitFailOpen(
          options.rateLimiter,
          `files:${clientIp}`,
        );
        if (!allowed) {
          return Response.json({ error: "Too many requests" }, { status: 429 });
        }
      }
    }

    // `resolveFileLink` already collapses every failure to `null`; the
    // try/catch is a second belt against an unexpected throw escaping and
    // being rendered as a 500, which would itself leak that the token
    // matched something.
    let download: Awaited<ReturnType<UseCases["resolveFileLink"]>>;
    try {
      download = await usecases.resolveFileLink(token);
    } catch {
      return notFound();
    }
    if (download === null) {
      return notFound();
    }

    return buildDownloadResponse({
      body: download.blob.body,
      contentType: download.contentType,
      contentLength: download.blob.size,
      fileName: download.fileName,
      forceDownload: c.req.query("download") === "1",
    });
  });

  return app;
}
