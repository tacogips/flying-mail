export interface RateLimiter {
  /** Returns true when the key is allowed to proceed; false means limited. */
  limit(key: string): Promise<boolean>;
}
