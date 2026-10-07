import type {
  BlobObject,
  BlobStore,
} from "@flying-mail/application/ports/blob-store";

/** Minimal structural surface of a Cloudflare R2 object returned by
 * `R2Bucket.get`. Kept local (see {@link R2BucketLike}) rather than
 * importing the ambient-global `@cloudflare/workers-types` package. */
export interface R2ObjectLike {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpMetadata?: { readonly contentType?: string };
}

/** Minimal structural surface of a Cloudflare R2 binding. Kept as a local,
 * non-ambient interface so this file's types do not merge into the global
 * scope, where they would collide with Bun's global runtime types used by
 * the rest of `@flying-mail/adapter`. */
export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array | ReadableStream,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

/** Maps a Cloudflare R2 binding onto the `BlobStore` port. */
export function createR2BlobStore(r2: R2BucketLike): BlobStore {
  return {
    async put(
      key: string,
      body: Uint8Array | ReadableStream,
      opts?: { contentType?: string },
    ): Promise<void> {
      // R2's `put` rejects a `ReadableStream` body that lacks a known
      // length, and the inbound mail pipeline (Cloudflare Email Routing's
      // `message.raw`) only ever hands us such a stream. Its size is already
      // bounded upstream by the 25 MB inbound cap, so buffering it fully
      // before the call is safe.
      const value =
        body instanceof Uint8Array
          ? body
          : new Uint8Array(await new Response(body).arrayBuffer());
      await r2.put(
        key,
        value,
        opts?.contentType === undefined
          ? undefined
          : { httpMetadata: { contentType: opts.contentType } },
      );
    },

    async get(key: string): Promise<BlobObject | null> {
      const object = await r2.get(key);
      if (object === null) {
        return null;
      }
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? null,
        size: object.size,
      };
    },

    async delete(key: string): Promise<void> {
      await r2.delete(key);
    },
  };
}
