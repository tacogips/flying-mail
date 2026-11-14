import type { RateLimiter } from "@flying-mail/application/ports/rate-limiter";
import type { Clock } from "@flying-mail/application/ports/runtime-ports";

export interface InMemoryRateLimiterOptions {
  readonly limit: number;
  readonly periodSeconds: number;
  readonly clock: Clock;
  readonly maxKeys?: number;
}

export const AUTH_RATE_LIMIT = { limit: 10, periodSeconds: 60 } as const;

interface FixedWindow {
  readonly windowStart: number;
  readonly count: number;
}

export function createInMemoryRateLimiter(
  options: InMemoryRateLimiterOptions,
): RateLimiter {
  const windows = new Map<string, FixedWindow>();
  const periodMs = options.periodSeconds * 1000;
  const maxKeys = options.maxKeys ?? 10_000;

  function pruneExpired(now: number): void {
    for (const [key, window] of windows) {
      if (now - window.windowStart >= periodMs) {
        windows.delete(key);
      }
    }
  }

  return {
    async limit(key: string): Promise<boolean> {
      const now = options.clock.now().getTime();
      const current = windows.get(key);

      if (current !== undefined && now - current.windowStart < periodMs) {
        if (current.count >= options.limit) {
          return false;
        }
        windows.set(key, {
          windowStart: current.windowStart,
          count: current.count + 1,
        });
        return true;
      }

      if (current === undefined && windows.size >= maxKeys) {
        pruneExpired(now);
        if (windows.size >= maxKeys) {
          const oldestKey = windows.keys().next().value;
          if (oldestKey !== undefined) {
            windows.delete(oldestKey);
          }
        }
      }

      windows.set(key, { windowStart: now, count: 1 });
      return true;
    },
  };
}
