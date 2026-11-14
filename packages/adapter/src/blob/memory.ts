import type {
  BlobObject,
  BlobStore,
} from "@mailcal/application/ports/blob-store";

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

async function toBytes(body: Uint8Array | ReadableStream): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** In-memory `BlobStore`. Intended for tests and for a throwaway local
 * server; nothing survives a restart, so it must never back a real
 * deployment -- `build-dependencies.ts` selects it only when explicitly
 * requested. */
export function createMemoryBlobStore(): BlobStore {
  const store = new Map<string, StoredBlob>();
  return {
    async put(key, body, opts): Promise<void> {
      store.set(key, {
        bytes: await toBytes(body),
        contentType: opts?.contentType ?? null,
      });
    },

    async get(key): Promise<BlobObject | null> {
      const entry = store.get(key);
      if (entry === undefined) {
        return null;
      }
      const bytes = entry.bytes;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: entry.contentType,
        size: bytes.length,
      };
    },

    async delete(key): Promise<void> {
      store.delete(key);
    },
  };
}
