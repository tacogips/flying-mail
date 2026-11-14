import type { RateLimiter } from "../ports/rate-limiter";
import type {
  TurnstileVerifier,
  TurnstileVerifyInput,
} from "../ports/turnstile-verifier";

export function createFakeRateLimiter(options?: {
  readonly deny?: ReadonlySet<string>;
}): { readonly limiter: RateLimiter; readonly keys: string[] } {
  const keys: string[] = [];
  const deny = options?.deny ?? new Set<string>();
  return {
    limiter: {
      async limit(key) {
        keys.push(key);
        return !deny.has(key);
      },
    },
    keys,
  };
}

export function createFakeTurnstileVerifier(options?: {
  readonly accept?: (input: TurnstileVerifyInput) => boolean;
}): {
  readonly verifier: TurnstileVerifier;
  readonly calls: TurnstileVerifyInput[];
} {
  const calls: TurnstileVerifyInput[] = [];
  return {
    verifier: {
      async verify(input) {
        calls.push(input);
        return options?.accept?.(input) ?? input.token === "turnstile-ok";
      },
    },
    calls,
  };
}
