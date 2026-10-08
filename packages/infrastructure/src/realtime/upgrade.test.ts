import { describe, expect, test, vi } from "vitest";
import {
  checkRealtimeUpgrade,
  isRealtimeUpgradeRequest,
  SUBPROTOCOL,
} from "./upgrade";

const ORIGIN = "https://mail.example.test";

function request(
  headers: Record<string, string> = {},
  method = "GET",
  url = `${ORIGIN}/graphql`,
): Request {
  return new Request(url, { method, headers });
}

const tokenHasher = {
  hash: vi.fn(async (value: string) => `digest:${value}`),
};

describe("WebSocket upgrade checks", () => {
  test("requires the graphql-transport-ws subprotocol before other checks", async () => {
    const result = await checkRealtimeUpgrade(
      request({ origin: "https://evil.test" }),
      {
        publicOrigin: ORIGIN,
        clientIp: "192.0.2.1",
        rateLimiter: null,
        tokenHasher,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  test.each(["https://evil.test", "not an origin"])(
    "rejects cross-origin or malformed Origin: %s",
    async (origin) => {
      const limiter = { limit: vi.fn(async () => true) };
      const result = await checkRealtimeUpgrade(
        request({
          origin,
          "sec-websocket-protocol": SUBPROTOCOL,
        }),
        {
          publicOrigin: ORIGIN,
          clientIp: "192.0.2.1",
          rateLimiter: limiter,
          tokenHasher,
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
      expect(limiter.limit).not.toHaveBeenCalled();
    },
  );

  test("rate limits before inspecting a cookie", async () => {
    const limiter = { limit: vi.fn(async () => false) };
    const result = await checkRealtimeUpgrade(
      request({
        origin: ORIGIN,
        cookie: "mailcal_session=secret",
        "sec-websocket-protocol": SUBPROTOCOL,
      }),
      {
        publicOrigin: ORIGIN,
        clientIp: null,
        rateLimiter: limiter,
        tokenHasher,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith("ws:connect:unknown");
    expect(tokenHasher.hash).not.toHaveBeenCalled();
  });

  test("fails open when the connection rate limiter rejects", async () => {
    const result = await checkRealtimeUpgrade(
      request({ "sec-websocket-protocol": SUBPROTOCOL }),
      {
        publicOrigin: ORIGIN,
        clientIp: "192.0.2.1",
        rateLimiter: {
          limit: async () => {
            throw new Error("unavailable");
          },
        },
        tokenHasher,
      },
    );
    expect(result.ok).toBe(true);
  });

  test("hashes a cookie only when a matching Origin is present", async () => {
    tokenHasher.hash.mockClear();
    const matching = await checkRealtimeUpgrade(
      request({
        origin: ORIGIN,
        cookie: "mailcal_session=secret%20value",
        "sec-websocket-protocol": `other, ${SUBPROTOCOL}`,
      }),
      {
        publicOrigin: ORIGIN,
        clientIp: "192.0.2.1",
        rateLimiter: null,
        tokenHasher,
      },
    );
    expect(matching).toEqual({
      ok: true,
      info: { clientIp: "192.0.2.1", cookieTokenHash: "digest:secret value" },
    });
    expect(tokenHasher.hash).toHaveBeenCalledWith("secret value");
    const absentOrigin = await checkRealtimeUpgrade(
      request({
        cookie: "mailcal_session=secret",
        "sec-websocket-protocol": SUBPROTOCOL,
      }),
      {
        publicOrigin: ORIGIN,
        clientIp: null,
        rateLimiter: null,
        tokenHasher,
      },
    );
    expect(absentOrigin).toEqual({
      ok: true,
      info: { clientIp: null, cookieTokenHash: null },
    });
    expect(tokenHasher.hash).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed cookie escaping without echoing request data", async () => {
    const result = await checkRealtimeUpgrade(
      request({
        origin: ORIGIN,
        cookie: "mailcal_session=%zz",
        "sec-websocket-protocol": SUBPROTOCOL,
      }),
      {
        publicOrigin: ORIGIN,
        clientIp: null,
        rateLimiter: null,
        tokenHasher,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.text()).not.toContain("%zz");
    }
  });

  test("does not use cookie authentication with an empty Origin header", async () => {
    const result = await checkRealtimeUpgrade(
      request({
        origin: "   ",
        cookie: "mailcal_session=secret",
        "sec-websocket-protocol": SUBPROTOCOL,
      }),
      {
        publicOrigin: ORIGIN,
        clientIp: null,
        rateLimiter: null,
        tokenHasher,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  test("recognizes only GET /graphql WebSocket upgrades", () => {
    expect(isRealtimeUpgradeRequest(request({ upgrade: "WebSocket" }))).toBe(
      true,
    );
    expect(
      isRealtimeUpgradeRequest(request({ upgrade: "websocket" }, "POST")),
    ).toBe(false);
    expect(
      isRealtimeUpgradeRequest(
        request({ upgrade: "websocket" }, "GET", `${ORIGIN}/other`),
      ),
    ).toBe(false);
    expect(isRealtimeUpgradeRequest(request())).toBe(false);
  });
});
