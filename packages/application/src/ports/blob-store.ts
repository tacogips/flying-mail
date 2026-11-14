/** A blob retrieved from a {@link BlobStore}. */
export interface BlobObject {
  readonly body: ReadableStream;
  readonly contentType: string | null;
  readonly size: number;
}

/** Port over the object store holding raw `.eml` sources and attachment
 * bodies. Implementations: R2 (Cloudflare Workers), an S3-compatible store
 * reached via `aws4fetch`, and an in-memory store for tests.
 *
 * Keys are derived from application-generated IDs (see
 * `@mailcal/domain/entities/attachment`'s key builders), so a retried write
 * overwrites in place rather than accumulating duplicates. */
export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | ReadableStream,
    opts?: { contentType?: string },
  ): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}
