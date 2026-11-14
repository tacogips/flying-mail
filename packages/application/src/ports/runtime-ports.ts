/** Injectable wall-clock, so use cases stay deterministic under test. */
export interface Clock {
  now(): Date;
}

/** Injectable source of randomness, so use cases stay deterministic under
 * test. `tokenBytes` returns raw bytes; encoding them (hex, base64url) is
 * the caller's concern. */
export interface RandomSource {
  uuid(): string;
  tokenBytes(length: number): Uint8Array;
}

/** SHA-256 hashing for opaque session tokens, API keys and file-link
 * tokens. There is no salt and no verify step: callers re-hash the
 * presented value and compare against the stored hash. Salting would defeat
 * the point -- lookup is by hash, and these are high-entropy random values,
 * not guessable passwords. */
export interface TokenHasher {
  hash(value: string): Promise<string>;
}
