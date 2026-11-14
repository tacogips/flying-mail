import { describe, expect, test } from "vitest";
import { createR2BlobStore, type R2BucketLike } from "./r2";

async function readAll(body: ReadableStream): Promise<string> {
  return new Response(body).text();
}

/** Fake `R2BucketLike` that mimics R2's rejection of a `ReadableStream`
 * body with an unknown length: any `ReadableStream` passed to `put` throws,
 * matching Cloudflare's real "Provided readable stream must have a known
 * length" error. This makes the fake fail if `createR2BlobStore` ever stops
 * buffering an inbound stream before calling `r2.put`. */
function fakeR2() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string }
  >();
  const putCalls: Array<Uint8Array | ReadableStream> = [];
  const bucket: R2BucketLike = {
    async put(key, value, options) {
      putCalls.push(value);
      if (!(value instanceof Uint8Array)) {
        throw new Error("Provided readable stream must have a known length");
      }
      const contentType = options?.httpMetadata?.contentType;
      objects.set(
        key,
        contentType === undefined
          ? { bytes: value }
          : { bytes: value, contentType },
      );
      return undefined;
    },
    async get(key) {
      const entry = objects.get(key);
      if (entry === undefined) {
        return null;
      }
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
        size: entry.bytes.length,
        ...(entry.contentType === undefined
          ? {}
          : { httpMetadata: { contentType: entry.contentType } }),
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { bucket, putCalls, objects };
}

describe("createR2BlobStore", () => {
  test("buffers a ReadableStream body into a Uint8Array before r2.put", async () => {
    const { bucket, putCalls } = fakeR2();
    const store = createR2BlobStore(bucket);
    const original = new TextEncoder().encode("streamed raw message");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(original);
        controller.close();
      },
    });

    await store.put("k", stream);

    expect(putCalls).toHaveLength(1);
    const received = putCalls[0];
    expect(received).toBeInstanceOf(Uint8Array);
    expect(received as Uint8Array).toEqual(original);
    expect(await readAll((await store.get("k"))?.body as ReadableStream)).toBe(
      "streamed raw message",
    );
  });

  test("passes a Uint8Array body through unchanged", async () => {
    const { bucket, putCalls } = fakeR2();
    const store = createR2BlobStore(bucket);
    const original = new TextEncoder().encode("bytes body");

    await store.put("k", original);

    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]).toBe(original);
  });

  test("maps the contentType option to httpMetadata for both body kinds", async () => {
    const { bucket, objects } = fakeR2();
    const store = createR2BlobStore(bucket);

    await store.put("bytes", new TextEncoder().encode("a"), {
      contentType: "message/rfc822",
    });
    expect(objects.get("bytes")?.contentType).toBe("message/rfc822");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("b"));
        controller.close();
      },
    });
    await store.put("stream", stream, { contentType: "message/rfc822" });
    expect(objects.get("stream")?.contentType).toBe("message/rfc822");
  });
});
