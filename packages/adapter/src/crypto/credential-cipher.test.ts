import { describe, expect, test } from "vitest";
import { createCredentialCipher } from "./credential-cipher";

function keyBase64(fill: number): string {
  const bytes = new Uint8Array(32).fill(fill);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

const KEY = keyBase64(7);

describe("createCredentialCipher", () => {
  test("round-trips a password", async () => {
    const cipher = createCredentialCipher(KEY);
    expect(cipher.available).toBe(true);

    const ciphertext = await cipher.encrypt("abcd-efgh-ijkl-mnop");
    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext).not.toContain("abcd-efgh-ijkl-mnop");
    expect(await cipher.decrypt(ciphertext)).toBe("abcd-efgh-ijkl-mnop");
  });

  test("round-trips non-ASCII plaintext", async () => {
    const cipher = createCredentialCipher(KEY);
    const secret = "パスワード-éß";
    expect(await cipher.decrypt(await cipher.encrypt(secret))).toBe(secret);
  });

  test("uses a fresh IV per encryption", async () => {
    const cipher = createCredentialCipher(KEY);
    const first = await cipher.encrypt("same");
    const second = await cipher.encrypt("same");
    expect(first).not.toBe(second);
    expect(await cipher.decrypt(second)).toBe("same");
  });

  test("rejects a tampered ciphertext", async () => {
    const cipher = createCredentialCipher(KEY);
    const ciphertext = await cipher.encrypt("secret");
    const body = ciphertext.slice("v1:".length);
    const flipped = `${body.slice(0, -2)}${body.at(-2) === "A" ? "B" : "A"}${body.at(-1)}`;
    await expect(cipher.decrypt(`v1:${flipped}`)).rejects.toThrow(
      /authentication/,
    );
  });

  test("rejects a ciphertext produced under a different key", async () => {
    const ciphertext = await createCredentialCipher(KEY).encrypt("secret");
    await expect(
      createCredentialCipher(keyBase64(9)).decrypt(ciphertext),
    ).rejects.toThrow(/authentication/);
  });

  test("rejects an unversioned or truncated ciphertext", async () => {
    const cipher = createCredentialCipher(KEY);
    await expect(cipher.decrypt("not-versioned")).rejects.toThrow(
      /unrecognized/,
    );
    await expect(cipher.decrypt("v1:AAAA")).rejects.toThrow(/truncated/);
  });

  test("throws for a key that is not 32 bytes", () => {
    const shortKey = btoa("too-short");
    expect(() => createCredentialCipher(shortKey)).toThrow(/32 bytes/);
  });

  test("is unavailable and throws on use when no key is configured", async () => {
    for (const value of [null, "", "   "]) {
      const cipher = createCredentialCipher(value);
      expect(cipher.available).toBe(false);
      await expect(cipher.encrypt("x")).rejects.toThrow(
        /MAILCAL_CREDENTIAL_KEY/,
      );
      await expect(cipher.decrypt("v1:x")).rejects.toThrow(
        /MAILCAL_CREDENTIAL_KEY/,
      );
    }
  });
});
