import type {
  RandomSource,
  TokenHasher,
} from "@mailcal/application/ports/runtime-ports";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Base64url without padding: safe in a URL path segment, which is where
 * file-link tokens live. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** `uuid()` via `crypto.randomUUID()`; `tokenBytes(length)` returns raw
 * random bytes from `crypto.getRandomValues`. Encoding is deliberately the
 * caller's concern -- API keys use base64url, verification tokens use hex. */
export function createCryptoRandomSource(): RandomSource {
  return {
    uuid(): string {
      return crypto.randomUUID();
    },
    tokenBytes(length: number): Uint8Array {
      return crypto.getRandomValues(new Uint8Array(length));
    },
  };
}

/** SHA-256 via WebCrypto, hex-encoded.
 *
 * There is no salt and no verify step: every value hashed here (session
 * tokens, API keys, file-link tokens) is 32 bytes of `getRandomValues`
 * output, so it is not guessable and salting would only prevent the
 * hash-keyed lookup these are stored for. */
export function createSha256TokenHasher(): TokenHasher {
  return {
    async hash(value: string): Promise<string> {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(value),
      );
      return toHex(new Uint8Array(digest));
    },
  };
}
