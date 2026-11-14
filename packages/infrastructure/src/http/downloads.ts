/**
 * Shared response construction for both binary surfaces: the authenticated
 * `/api/attachments/:id` route and the credential-free `/files/:token` one.
 *
 * Mail attachments are attacker-controlled by definition, so this is the
 * stored-XSS boundary for the whole application. Both routes go through
 * here so neither can drift from the other's protections.
 */

/** Content types safe to render inline. Anything outside this allowlist --
 * notably `text/html`, `image/svg+xml` and `application/xhtml+xml` -- is
 * forced to download, so a browser never renders attacker-supplied markup
 * as same-origin content. */
const INLINE_SAFE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);

export function isInlineSafeContentType(contentType: string): boolean {
  // Strip any `; charset=...` parameter before matching.
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return INLINE_SAFE_CONTENT_TYPES.has(base);
}

/** RFC 5987 `filename*` plus a quote-stripped ASCII fallback.
 *
 * The fallback strips `"` so a crafted file name cannot break out of the
 * quoted value and inject further header directives. */
export function encodeContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string,
): string {
  const asciiFallback = fileName
    // Anything outside printable ASCII becomes `_`: a header value must not
    // carry control characters, and non-ASCII is covered by `filename*`.
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/"/g, "_");
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface DownloadResponseInput {
  readonly body: ReadableStream;
  readonly contentType: string;
  readonly contentLength: number;
  readonly fileName: string;
  readonly forceDownload: boolean;
}

/** Builds a hardened download response.
 *
 * Three independent layers, because each covers a case the others do not:
 * `nosniff` stops the browser guessing a different type than declared;
 * `Content-Security-Policy: sandbox` strips every capability from whatever
 * the client does end up rendering (no scripts, no same-origin access to
 * the session cookie); and the disposition allowlist keeps accurately
 * labelled `text/html` from being rendered at all. */
export function buildDownloadResponse(input: DownloadResponseInput): Response {
  const headers = new Headers({
    "content-type": input.contentType,
    "content-length": String(input.contentLength),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    // These bytes are per-credential and often short-lived; never let a
    // shared cache keep them.
    "cache-control": "private, no-store",
  });
  const disposition =
    input.forceDownload || !isInlineSafeContentType(input.contentType)
      ? "attachment"
      : "inline";
  headers.set(
    "content-disposition",
    encodeContentDisposition(disposition, input.fileName),
  );
  return new Response(input.body, { headers });
}
