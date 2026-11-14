import { apiKeyViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CloseCode } from "./protocol";
import { createRealtimeTestBundle, messagesOfType } from "./hub-test-support";

const SUBSCRIPTION =
  "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function connect(
  bundle: ReturnType<typeof createRealtimeTestBundle>,
  token = "valid",
) {
  const pair = bundle.attach();
  await bundle.hub.open(pair.connection, {
    clientIp: "127.0.0.1",
    cookieTokenHash: null,
  });
  await bundle.hub.message(
    pair.connection,
    JSON.stringify({
      type: "connection_init",
      payload: { authorization: `Bearer ${token}` },
    }),
  );
  return pair;
}

describe("RealtimeHub protocol state machine", () => {
  test("closes connections that miss connection_init at 10 seconds", async () => {
    let now = 1_000;
    const bundle = createRealtimeTestBundle({ now: () => now });
    const pair = bundle.attach();
    await bundle.hub.open(pair.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    now += 9_999;
    await bundle.hub.wake();
    expect(pair.socket.closes).toEqual([]);
    now += 1;
    await bundle.hub.wake();
    expect(pair.socket.closes[0]?.code).toBe(CloseCode.InitTimeout);
  });

  test("timer-driven in-process wake closes an uninitialized socket", async () => {
    vi.useFakeTimers();
    const bundle = createRealtimeTestBundle({ now: () => Date.now() });
    bundle.host.setWakeHandler(() => bundle.hub.wake());
    const pair = bundle.attach();
    await bundle.hub.open(pair.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pair.socket.closes[0]?.code).toBe(CloseCode.InitTimeout);
  });

  test("timer-driven safety wake closes an idle acknowledged socket", async () => {
    vi.useFakeTimers();
    const bundle = createRealtimeTestBundle({ now: () => Date.now() });
    bundle.host.setWakeHandler(() => bundle.hub.wake());
    const pair = await connect(bundle);
    await vi.advanceTimersByTimeAsync(75_000 + 60_000);
    expect(pair.socket.closes[0]?.code).toBe(CloseCode.Idle);
  });

  test("subscribe before ack and missing credentials close as unauthorized", async () => {
    const bundle = createRealtimeTestBundle();
    const beforeAck = bundle.attach();
    await bundle.hub.open(beforeAck.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    await bundle.hub.message(
      beforeAck.connection,
      JSON.stringify({
        type: "subscribe",
        id: "s",
        payload: { query: SUBSCRIPTION },
      }),
    );
    expect(beforeAck.socket.closes[0]?.code).toBe(CloseCode.Unauthorized);
    const noCredentials = bundle.attach();
    await bundle.hub.open(noCredentials.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    await bundle.hub.message(
      noCredentials.connection,
      JSON.stringify({ type: "connection_init" }),
    );
    expect(noCredentials.socket.closes[0]?.code).toBe(CloseCode.Unauthorized);
    for (const payload of ["wrong-shape", { authorization: 42 }]) {
      const invalid = createRealtimeTestBundle();
      const connection = invalid.attach();
      await invalid.hub.open(connection.connection, {
        clientIp: null,
        cookieTokenHash: null,
      });
      await invalid.hub.message(
        connection.connection,
        JSON.stringify({ type: "connection_init", payload }),
      );
      expect(connection.socket.closes[0]?.code).toBe(CloseCode.BadRequest);
    }
    const badScheme = createRealtimeTestBundle();
    const invalidAuthorization = badScheme.attach();
    await badScheme.hub.open(invalidAuthorization.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    await badScheme.hub.message(
      invalidAuthorization.connection,
      JSON.stringify({
        type: "connection_init",
        payload: { authorization: "Basic secret" },
      }),
    );
    expect(invalidAuthorization.socket.closes[0]?.code).toBe(
      CloseCode.Unauthorized,
    );
  });

  test("acks MAIL_READ principals and denies keys without MAIL_READ", async () => {
    const allowed = createRealtimeTestBundle({
      viewer: apiKeyViewer([{ capability: Capability.MailRead }]),
    });
    const ok = await connect(allowed);
    expect(messagesOfType(ok.socket, "connection_ack")).toHaveLength(1);
    const denied = createRealtimeTestBundle({
      viewer: apiKeyViewer([{ capability: Capability.MailSend }]),
    });
    const noRead = await connect(denied);
    expect(noRead.socket.closes[0]?.code).toBe(CloseCode.Forbidden);
  });

  test("reports an invalid subscription and keeps the connection usable", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await bundle.hub.message(
      pair.connection,
      JSON.stringify({
        type: "subscribe",
        id: "invalid",
        payload: { query: "subscription { mailEvents { missingField } }" },
      }),
    );

    expect(messagesOfType(pair.socket, "error")).toHaveLength(1);
    expect(messagesOfType(pair.socket, "error")[0]).toMatchObject({
      id: "invalid",
      type: "error",
    });
    expect(pair.socket.closes).toHaveLength(0);

    await bundle.hub.message(
      pair.connection,
      JSON.stringify({
        type: "subscribe",
        id: "valid",
        payload: { query: SUBSCRIPTION },
      }),
    );
    await bundle.hub.requestDrain();
    expect(pair.socket.closes).toHaveLength(0);
    expect(
      messagesOfType(pair.socket, "next").some(
        (message) => message["id"] === "valid",
      ),
    ).toBe(true);
  });

  test("authenticates a matching-origin cookie hash without storing its raw value", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = bundle.attach();
    await bundle.hub.open(pair.connection, {
      clientIp: null,
      cookieTokenHash: "opaque-cookie-digest",
    });
    await bundle.hub.message(
      pair.connection,
      JSON.stringify({ type: "connection_init" }),
    );
    expect(messagesOfType(pair.socket, "connection_ack")).toHaveLength(1);
    const state = await bundle.host.loadState(pair.connection);
    expect(state?.principal?.tokenHash).toBe("opaque-cookie-digest");
    expect(JSON.stringify(state)).not.toContain("cookie-secret");
  });

  test("closes on second init, duplicate subscription id, oversized frame, and unknown type", async () => {
    const initBundle = createRealtimeTestBundle();
    const init = await connect(initBundle);
    await initBundle.hub.message(
      init.connection,
      JSON.stringify({ type: "connection_init" }),
    );
    expect(init.socket.closes[0]?.code).toBe(CloseCode.TooManyInitializations);
    const duplicateBundle = createRealtimeTestBundle();
    const duplicate = await connect(duplicateBundle);
    const request = JSON.stringify({
      type: "subscribe",
      id: "same",
      payload: { query: SUBSCRIPTION },
    });
    await duplicateBundle.hub.message(duplicate.connection, request);
    await duplicateBundle.hub.message(duplicate.connection, request);
    expect(duplicate.socket.closes[0]?.code).toBe(
      CloseCode.DuplicateSubscription,
    );
    const tooBigBundle = createRealtimeTestBundle();
    const tooBig = await connect(tooBigBundle);
    await tooBigBundle.hub.message(tooBig.connection, " ".repeat(16_385));
    expect(tooBig.socket.closes[0]?.code).toBe(CloseCode.TooBig);
    const unknownBundle = createRealtimeTestBundle();
    const unknown = await connect(unknownBundle);
    await unknownBundle.hub.message(
      unknown.connection,
      JSON.stringify({ type: "unknown" }),
    );
    expect(unknown.socket.closes[0]?.code).toBe(CloseCode.BadRequest);
  });

  test("serializes concurrent init and subscription bursts", async () => {
    const initBundle = createRealtimeTestBundle();
    const init = initBundle.attach();
    await initBundle.hub.open(init.connection, {
      clientIp: null,
      cookieTokenHash: null,
    });
    const initFrame = JSON.stringify({
      type: "connection_init",
      payload: { authorization: "Bearer valid" },
    });
    await Promise.all([
      initBundle.hub.message(init.connection, initFrame),
      initBundle.hub.message(init.connection, initFrame),
    ]);
    expect(messagesOfType(init.socket, "connection_ack")).toHaveLength(1);
    expect(init.socket.closes.at(-1)?.code).toBe(
      CloseCode.TooManyInitializations,
    );

    const burstBundle = createRealtimeTestBundle();
    const burst = await connect(burstBundle);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        burstBundle.hub.message(
          burst.connection,
          JSON.stringify({
            type: "subscribe",
            id: `burst-${index}`,
            payload: { query: SUBSCRIPTION },
          }),
        ),
      ),
    );
    const state = await burstBundle.host.loadState(burst.connection);
    expect(state?.subscriptions).toHaveLength(4);
    expect(messagesOfType(burst.socket, "error")).toHaveLength(1);
    expect(messagesOfType(burst.socket, "error")[0]?.["payload"]).toMatchObject(
      [{ extensions: { code: "RATE_LIMITED" } }],
    );

    const duplicateBundle = createRealtimeTestBundle();
    const duplicate = await connect(duplicateBundle);
    const repeated = JSON.stringify({
      type: "subscribe",
      id: "repeated",
      payload: { query: SUBSCRIPTION },
    });
    await Promise.all([
      duplicateBundle.hub.message(duplicate.connection, repeated),
      duplicateBundle.hub.message(duplicate.connection, repeated),
    ]);
    expect(duplicate.socket.closes.at(-1)?.code).toBe(
      CloseCode.DuplicateSubscription,
    );
  });

  test("sends pong, validates init payload, enforces subscription and principal limits", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    await bundle.hub.message(pair.connection, JSON.stringify({ type: "ping" }));
    expect(messagesOfType(pair.socket, "pong")).toHaveLength(1);
    for (let index = 0; index < 4; index += 1) {
      await bundle.hub.message(
        pair.connection,
        JSON.stringify({
          type: "subscribe",
          id: `s${index}`,
          payload: { query: SUBSCRIPTION },
        }),
      );
    }
    await bundle.hub.message(
      pair.connection,
      JSON.stringify({
        type: "subscribe",
        id: "s4",
        payload: { query: SUBSCRIPTION },
      }),
    );
    expect(
      messagesOfType(pair.socket, "error").at(-1)?.["payload"],
    ).toMatchObject([{ extensions: { code: "RATE_LIMITED" } }]);
    const limited = createRealtimeTestBundle();
    const sockets = [];
    for (let index = 0; index < 11; index += 1)
      sockets.push((await connect(limited)).socket);
    expect(sockets[10]?.closes[0]?.code).toBe(CloseCode.RateLimited);
    const rateLimited = createRealtimeTestBundle({
      rateLimiter: { limit: async (key) => !key.startsWith("ws:init:") },
    });
    const blocked = await connect(rateLimited);
    expect(blocked.socket.closes[0]?.code).toBe(CloseCode.RateLimited);
  });

  test("admission enforces per-IP and global socket limits", async () => {
    const ipLimited = createRealtimeTestBundle();
    for (let index = 0; index < 20; index += 1) {
      const pair = ipLimited.attach();
      await ipLimited.hub.open(pair.connection, {
        clientIp: "192.0.2.4",
        cookieTokenHash: null,
      });
    }
    expect(ipLimited.hub.admit("192.0.2.4")).toBe("IP_LIMIT");

    const globalLimited = createRealtimeTestBundle();
    for (let index = 0; index < 1_000; index += 1) {
      const pair = globalLimited.attach();
      await globalLimited.hub.open(pair.connection, {
        clientIp: `192.0.2.${index}`,
        cookieTokenHash: null,
      });
    }
    expect(globalLimited.hub.admit("198.51.100.1")).toBe("GLOBAL_LIMIT");
  });

  test("open bursts reserve state before awaiting persistence and close over-cap sockets", async () => {
    const bundle = createRealtimeTestBundle();
    const pairs = Array.from({ length: 22 }, () => bundle.attach());
    await Promise.all(
      pairs.map(({ connection }) =>
        bundle.hub.open(connection, {
          clientIp: "203.0.113.8",
          cookieTokenHash: null,
        }),
      ),
    );
    expect(
      pairs.filter(({ socket }) => socket.closes[0]?.code === 1013),
    ).toHaveLength(2);
    expect(
      pairs.filter(({ socket }) => socket.closes.length === 0),
    ).toHaveLength(20);
  });

  test("reschedules one in-process timer and supports late wake handler binding", async () => {
    vi.useFakeTimers();
    const host = createRealtimeTestBundle({ now: () => Date.now() }).host;
    const wake = vi.fn(async () => {});
    host.scheduleWake(Date.now() + 1_000);
    host.scheduleWake(Date.now() + 2_000);
    host.setWakeHandler(wake);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wake).toHaveBeenCalledTimes(1);
    host.scheduleWake(Date.now() + 1_000);
    host.scheduleWake(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  test("a timer without a handler is inert and a rejected wake is logged", async () => {
    vi.useFakeTimers();
    const host = createRealtimeTestBundle({ now: () => Date.now() }).host;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    host.scheduleWake(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(error).not.toHaveBeenCalled();
    host.setWakeHandler(async () => {
      throw new Error("private failure detail");
    });
    host.scheduleWake(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(error).toHaveBeenCalledWith("Realtime wake failed");
    error.mockRestore();
  });
});
