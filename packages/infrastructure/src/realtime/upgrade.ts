import type { RateLimiter } from "@flying-mail/application/ports/rate-limiter";
import type { TokenHasher } from "@flying-mail/application/ports/runtime-ports";
import {
  extractSessionCookie,
  isCrossOriginRequest,
} from "../http/auth-middleware";
import type { UpgradeInfo } from "./host";
import { SUBPROTOCOL } from "./protocol";

export { SUBPROTOCOL };

type UpgradeResult =
  | { readonly ok: false; readonly response: Response }
  | { readonly ok: true; readonly info: UpgradeInfo };

function rejection(status: number, message: string): UpgradeResult {
  return {
    ok: false,
    response: new Response(message, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  };
}

export function isRealtimeUpgradeRequest(request: Request): boolean {
  return (
    request.method === "GET" &&
    new URL(request.url).pathname === "/graphql" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  );
}

export async function checkRealtimeUpgrade(
  request: Request,
  options: {
    readonly publicOrigin: string | null;
    readonly clientIp: string | null;
    readonly rateLimiter: RateLimiter | null;
    readonly tokenHasher: TokenHasher;
  },
): Promise<UpgradeResult> {
  const protocols = request.headers.get("sec-websocket-protocol") ?? "";
  if (!protocols.split(",").some((part) => part.trim() === SUBPROTOCOL)) {
    return rejection(400, "WebSocket subprotocol required");
  }
  if (isCrossOriginRequest(request, options.publicOrigin)) {
    return rejection(403, "Forbidden");
  }
  if (options.rateLimiter !== null) {
    try {
      if (
        !(await options.rateLimiter.limit(
          `ws:connect:${options.clientIp ?? "unknown"}`,
        ))
      ) {
        return rejection(429, "Too many connection attempts");
      }
    } catch {
      // The upgrade design treats limiter failures as fail-open.
    }
  }

  let cookieTokenHash: string | null = null;
  const origin = request.headers.get("origin");
  if (
    origin !== null &&
    origin.trim().length === 0 &&
    request.headers.has("cookie")
  ) {
    return rejection(403, "Forbidden");
  }
  if (origin !== null && origin.trim().length > 0) {
    try {
      const token = extractSessionCookie(request);
      cookieTokenHash =
        token === null ? null : await options.tokenHasher.hash(token);
    } catch {
      return rejection(403, "Forbidden");
    }
  }
  return {
    ok: true,
    info: { clientIp: options.clientIp, cookieTokenHash },
  };
}
