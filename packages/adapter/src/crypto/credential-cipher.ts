import type { CredentialCipher } from "@mailcal/application/ports/credential-cipher";

/** `v1:` + base64(12-byte IV || ciphertext+tag).
 *
 * The version prefix exists so a future key rotation or algorithm change can
 * be told apart from today's format by looking at a stored value, rather
 * than by guessing from its length. */
const VERSION_PREFIX = "v1:";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Decodes and length-checks the configured key. Throws rather than
 * degrading to "no encryption": a deployment that set the secret expects it
 * to be used, and silently storing plaintext passwords would be worse than
 * refusing to start. */
function decodeKeyBytes(keyBase64: string): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(keyBase64.trim());
  } catch {
    throw new Error("MAILCAL_CREDENTIAL_KEY must be valid base64");
  }
  if (bytes.length !== KEY_LENGTH) {
    throw new Error(
      `MAILCAL_CREDENTIAL_KEY must decode to ${KEY_LENGTH} bytes, got ${bytes.length}`,
    );
  }
  return bytes;
}

/** Rejects rather than throwing synchronously: callers await these, and a
 * synchronous throw from an `async`-shaped port would escape a `.catch()`
 * that a caller reasonably wrote around the await. */
async function unavailable(): Promise<never> {
  throw new Error(
    "credential encryption is unavailable: MAILCAL_CREDENTIAL_KEY is not configured",
  );
}

/** AES-256-GCM over WebCrypto, available on both Bun and workerd.
 *
 * `keyBase64 === null` yields a cipher that reports `available: false` and
 * throws on use, which is what lets the rest of the calendar feature run in
 * a deployment that has no CalDAV secret configured.
 *
 * The `CryptoKey` import is done lazily and memoized: constructing the
 * cipher is synchronous (composition root wiring), while `importKey` is
 * not. */
export function createCredentialCipher(
  keyBase64: string | null,
): CredentialCipher {
  if (keyBase64 === null || keyBase64.trim().length === 0) {
    return {
      available: false,
      encrypt: unavailable,
      decrypt: unavailable,
    };
  }

  const keyBytes = decodeKeyBytes(keyBase64);
  let keyPromise: Promise<CryptoKey> | null = null;

  const loadKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return keyPromise;
  };

  return {
    available: true,

    async encrypt(plaintext: string): Promise<string> {
      const key = await loadKey();
      const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          new TextEncoder().encode(plaintext),
        ),
      );
      const packed = new Uint8Array(iv.length + ciphertext.length);
      packed.set(iv, 0);
      packed.set(ciphertext, iv.length);
      return `${VERSION_PREFIX}${toBase64(packed)}`;
    },

    async decrypt(ciphertext: string): Promise<string> {
      if (!ciphertext.startsWith(VERSION_PREFIX)) {
        throw new Error("unrecognized credential ciphertext format");
      }
      let packed: Uint8Array<ArrayBuffer>;
      try {
        packed = fromBase64(ciphertext.slice(VERSION_PREFIX.length));
      } catch {
        throw new Error("credential ciphertext is not valid base64");
      }
      if (packed.length <= IV_LENGTH) {
        throw new Error("credential ciphertext is truncated");
      }
      const key = await loadKey();
      // `slice` rather than `subarray`: WebCrypto's typings require a view
      // over a plain `ArrayBuffer`, which only a copy is guaranteed to be.
      const iv = packed.slice(0, IV_LENGTH);
      const sealed = packed.slice(IV_LENGTH);
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          sealed,
        );
      } catch {
        // GCM authentication failure: either the wrong key or a tampered
        // value. Both are the same answer to the caller, and neither should
        // leak which one it was.
        throw new Error("credential ciphertext failed authentication");
      }
      return new TextDecoder().decode(plaintext);
    },
  };
}
