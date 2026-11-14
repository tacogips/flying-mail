import { describe, expect, test } from "vitest";
import { createMemoryBlobStore } from "./memory";
import { createR2BlobStore, type R2BucketLike, type R2ObjectLike } from "./r2";

async function readAll(body: ReadableStream): Promise<string> {
  return new Response(body).text();
}

describe("createMemoryBlobStore", () => {
  test("round-trips bytes with a content type", async () => {
    const store = createMemoryBlobStore();
    await store.put("k", new TextEncoder().encode("hello"), {
      contentType: "text/plain",
    });
    const blob = await store.get("k");
    expect(blob?.size).toBe(5);
    expect(blob?.contentType).toBe("text/plain");
    expect(await readAll(blob?.body as ReadableStream)).toBe("hello");
  });

  test("accepts a ReadableStream body", async () => {
    const store = createMemoryBlobStore();
    await store.put(
      "k",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      }),
    );
    expect(await readAll((await store.get("k"))?.body as ReadableStream)).toBe(
      "streamed",
    );
  });

  test("reports a null content type when none was given", async () => {
    const store = createMemoryBlobStore();
    await store.put("k", new Uint8Array([1]));
    expect((await store.get("k"))?.contentType).toBeNull();
  });

  test("returns null for a missing key", async () => {
    expect(await createMemoryBlobStore().get("nope")).toBeNull();
  });

  test("overwrites in place", async () => {
    const store = createMemoryBlobStore();
    await store.put("k", new TextEncoder().encode("first"));
    await store.put("k", new TextEncoder().encode("second"));
    expect(await readAll((await store.get("k"))?.body as ReadableStream)).toBe(
      "second",
    );
  });

  test("delete removes the key and is idempotent", async () => {
    const store = createMemoryBlobStore();
    await store.put("k", new Uint8Array([1]));
    await store.delete("k");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });
});

function fakeR2() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string }
  >();
  const bucket: R2BucketLike = {
    async put(key, value, options) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : new Uint8Array(await new Response(value).arrayBuffer());
      const contentType = options?.httpMetadata?.contentType;
      objects.set(
        key,
        contentType === undefined ? { bytes } : { bytes, contentType },
      );
      return undefined;
    },
    async get(key): Promise<R2ObjectLike | null> {
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
  return { bucket, objects };
}

describe("createR2BlobStore", () => {
  test("round-trips bytes and the content type", async () => {
    const { bucket } = fakeR2();
    const store = createR2BlobStore(bucket);
    await store.put("k", new TextEncoder().encode("hello"), {
      contentType: "message/rfc822",
    });
    const blob = await store.get("k");
    expect(blob?.contentType).toBe("message/rfc822");
    expect(blob?.size).toBe(5);
    expect(await readAll(blob?.body as ReadableStream)).toBe("hello");
  });

  test("omits httpMetadata entirely when no content type is given", async () => {
    const { bucket, objects } = fakeR2();
    await createR2BlobStore(bucket).put("k", new Uint8Array([1]));
    expect(objects.get("k")?.contentType).toBeUndefined();
    expect((await createR2BlobStore(bucket).get("k"))?.contentType).toBeNull();
  });

  test("returns null for a missing key", async () => {
    const { bucket } = fakeR2();
    expect(await createR2BlobStore(bucket).get("nope")).toBeNull();
  });

  test("delete removes the object", async () => {
    const { bucket, objects } = fakeR2();
    const store = createR2BlobStore(bucket);
    await store.put("k", new Uint8Array([1]));
    await store.delete("k");
    expect(objects.has("k")).toBe(false);
  });
});
