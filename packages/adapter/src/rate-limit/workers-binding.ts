import type { RateLimiter } from "@flying-mail/application/ports/rate-limiter";

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
        return true;
      }
    },
  };
}
