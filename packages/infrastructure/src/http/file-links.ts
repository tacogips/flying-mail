import type { UseCases } from "@mailcal/application/usecases";
import { Hono } from "hono";
import { buildDownloadResponse } from "./downloads";

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
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
export function createFileLinkRoutes(usecases: UseCases): Hono {
  const app = new Hono();

  app.get("/:token", async (c) => {
    const token = c.req.param("token");
    if (token.length === 0) {
      return notFound();
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
