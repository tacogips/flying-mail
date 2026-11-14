import type { TurnstileVerifier } from "@flying-mail/application/ports/turnstile-verifier";

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface SiteverifyTurnstileOptions {
  readonly secret: string;
  readonly expectedHostname: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface SiteverifyResponse {
  readonly success: boolean;
  readonly hostname: string;
  readonly action: string;
}

function isSiteverifyResponse(value: unknown): value is SiteverifyResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    value.success === true &&
    "hostname" in value &&
    typeof value.hostname === "string" &&
    "action" in value &&
    typeof value.action === "string"
  );
}

export function createSiteverifyTurnstileVerifier(
  options: SiteverifyTurnstileOptions,
): TurnstileVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async verify(input): Promise<boolean> {
      if (input.token.length === 0 || input.token.length > 2048) {
        return false;
      }

      const body = new URLSearchParams({
        secret: options.secret,
        response: input.token,
      });
      if (input.remoteIp !== null) {
        body.set("remoteip", input.remoteIp);
      }

      try {
        const response = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
        if (response.status < 200 || response.status >= 300) {
          return false;
        }

        const result: unknown = await response.json();
        return (
          isSiteverifyResponse(result) &&
          result.hostname === options.expectedHostname &&
          result.action === input.action
        );
      } catch {
        console.error("Turnstile siteverify failed", "RequestError");
        return false;
      }
    },
  };
}
