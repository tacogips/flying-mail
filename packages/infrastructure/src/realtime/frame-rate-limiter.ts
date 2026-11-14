import type { ConnectionState } from "./host";
import { FRAME_RATE_WINDOW_MS, MAX_FRAMES_PER_WINDOW } from "./protocol";

export interface FrameRateLimiter {
  /** Returns false when the connection exhausted its inbound frame budget. */
  consume(state: ConnectionState, nowMs: number): boolean;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Per-connection token bucket. Buckets live in memory only: a connection that
 * survives a Durable Object eviction starts again with a full budget.
 */
export function createFrameRateLimiter(
  capacity: number = MAX_FRAMES_PER_WINDOW,
  windowMs: number = FRAME_RATE_WINDOW_MS,
): FrameRateLimiter {
  const buckets = new WeakMap<ConnectionState, Bucket>();
  return {
    consume(state, nowMs) {
      let bucket = buckets.get(state);
      if (bucket === undefined) {
        bucket = { tokens: capacity, updatedAt: nowMs };
        buckets.set(state, bucket);
      }
      const elapsed = Math.max(0, nowMs - bucket.updatedAt);
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + (elapsed * capacity) / windowMs,
      );
      bucket.updatedAt = nowMs;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
