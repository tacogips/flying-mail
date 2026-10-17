/** Maximum accepted size of a GraphQL request body. Documents are bounded
 * by the depth/selection/alias plugins, but those only run after the body
 * has been buffered and parsed -- this caps the buffering itself. */
export const MAX_GRAPHQL_BODY_BYTES = 1_048_576;

/** Methods that carry no request body; nothing to cap. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

export type BoundedBodyResult =
  | { readonly kind: "ok"; readonly request: Request }
  | { readonly kind: "too-large" };

function parseContentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return null;
  }
  const value = Number(header.trim());
  return Number.isSafeInteger(value) ? value : null;
}

async function readUpTo(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Enforces `maxBytes` on a request body.
 *
 * - No body (GET/HEAD, or a null body): returned untouched.
 * - A valid `Content-Length`: rejected from the header alone when over the
 *   cap, else passed through untouched.
 * - `Content-Length` absent or malformed (chunked uploads): the stream is
 *   read through a bounded reader that aborts once the cap is exceeded, and
 *   the request is rebuilt around the buffered bytes so downstream handlers
 *   can still read it. */
export async function enforceBodyLimit(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  if (BODYLESS_METHODS.has(request.method) || request.body === null) {
    return { kind: "ok", request };
  }
  const declared = parseContentLength(request.headers.get("content-length"));
  if (declared !== null) {
    return declared > maxBytes
      ? { kind: "too-large" }
      : { kind: "ok", request };
  }
  const bytes = await readUpTo(request.body, maxBytes);
  if (bytes === null) {
    return { kind: "too-large" };
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return {
    kind: "ok",
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: bytes,
      signal: request.signal,
    }),
  };
}
