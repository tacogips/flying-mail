import {
  type RateLimiter,
  RateLimiterUnavailableError,
} from "@flying-mail/application/ports/rate-limiter";

export interface RateLimitBindingLike {
  limit(options: {
    readonly key: string;
  }): Promise<{ readonly success: boolean }>;
}

export function createWorkersRateLimiter(
  binding: RateLimitBindingLike,
): RateLimiter {
  return {
    async limit(key: string): Promise<boolean> {
      try {
        return (await binding.limit({ key })).success;
      } catch (error) {
        console.error("Rate limiter binding failed", error);
        // Not an answer about the caller's rate: surface it so each caller
        // chooses to fail open or closed.
        throw new RateLimiterUnavailableError(
          "Rate limiter binding failed",
          error,
        );
      }
    },
  };
}
