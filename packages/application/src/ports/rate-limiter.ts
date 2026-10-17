export interface RateLimiter {
  /** Returns true when the key is allowed to proceed; false means limited.
   * Throws {@link RateLimiterUnavailableError} when the limiter itself
   * cannot answer, so each caller decides explicitly whether to fail open or
   * closed rather than the adapter deciding for all of them. */
  limit(key: string): Promise<boolean>;
}

/** The limiter backend (for example the Workers rate-limit binding) failed
 * to produce an answer. This says nothing about the caller's own rate. */
export class RateLimiterUnavailableError extends Error {
  override readonly name = "RateLimiterUnavailableError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Asks the limiter and **fails open**: if it cannot answer, the request is
 * allowed. For routes where being throttled wrongly (an outage locking
 * every user out) is worse than briefly not throttling. Operations that
 * mint credentials must not use this; they handle the error themselves. */
export async function limitFailOpen(
  limiter: RateLimiter,
  key: string,
): Promise<boolean> {
  try {
    return await limiter.limit(key);
  } catch {
    return true;
  }
}
