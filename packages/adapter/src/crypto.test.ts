import { describe, expect, test } from "vitest";
import {
  createCryptoRandomSource,
  createSha256TokenHasher,
  fromBase64Url,
  toBase64Url,
} from "./crypto";

describe("createCryptoRandomSource", () => {
  const random = createCryptoRandomSource();

  test("produces distinct uuids", () => {
    const values = new Set(Array.from({ length: 100 }, () => random.uuid()));
    expect(values.size).toBe(100);
  });

  test("produces the requested number of bytes", () => {
    expect(random.tokenBytes(32)).toHaveLength(32);
    expect(random.tokenBytes(0)).toHaveLength(0);
  });

  test("does not repeat token bytes", () => {
    const a = toBase64Url(random.tokenBytes(32));
    const b = toBase64Url(random.tokenBytes(32));
    expect(a).not.toBe(b);
  });
});

describe("createSha256TokenHasher", () => {
  const hasher = createSha256TokenHasher();

  test("matches the known SHA-256 vector for the empty string", async () => {
    expect(await hasher.hash("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("matches the known SHA-256 vector for 'abc'", async () => {
    expect(await hasher.hash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("is deterministic and case-sensitive", async () => {
    expect(await hasher.hash("token")).toBe(await hasher.hash("token"));
    expect(await hasher.hash("token")).not.toBe(await hasher.hash("Token"));
  });

  test("handles non-ascii input", async () => {
    expect(await hasher.hash("こんにちは")).toHaveLength(64);
  });
});

describe("base64url", () => {
  test.each([[[]], [[0]], [[0, 1]], [[0, 1, 2]], [[251, 252, 253, 254, 255]]])(
    "round-trips %j",
    (input) => {
      const bytes = new Uint8Array(input as number[]);
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    },
  );

  test("emits no url-unsafe characters", () => {
    // 0xfb 0xff encodes to `+`/`/` in standard base64.
    const encoded = toBase64Url(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test.each([1, 2, 3, 4, 5, 31, 32, 33])(
    "round-trips %i random bytes",
    (length) => {
      const bytes = createCryptoRandomSource().tokenBytes(length);
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    },
  );
});
