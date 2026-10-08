import { adminViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CloseCode } from "./protocol";
import { createRealtimeTestBundle, messagesOfType } from "./hub-test-support";

const SUBSCRIPTION =
  "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }";

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(bundle: ReturnType<typeof createRealtimeTestBundle>) {
  const pair = bundle.attach();
  await bundle.hub.open(pair.connection, {
    clientIp: "127.0.0.1",
    cookieTokenHash: null,
  });
  return pair;
}

async function initialize(bundle: ReturnType<typeof createRealtimeTestBundle>) {
  const pair = await open(bundle);
  await bundle.hub.message(
    pair.connection,
    JSON.stringify({
      type: "connection_init",
      payload: { authorization: "Bearer valid" },
    }),
  );
  return pair;
}

function subscribe(id: string, query = SUBSCRIPTION): string {
  return JSON.stringify({
    type: "subscribe",
    id,
    payload: { query },
  });
}

describe("RealtimeHub review fixes", () => {
  test("does not restore or count a connection closed during token resolution", async () => {
    let limiterCalls = 0;
    const bundle = createRealtimeTestBundle({
      rateLimiter: {
        async limit() {
          limiterCalls += 1;
          return true;
        },
      },
    });
    const pair = await open(bundle);
    const resolver: {
      resolve: ((viewer: ReturnType<typeof adminViewer>) => void) | null;
    } = { resolve: null };
    const startedSignal: { resolve: (() => void) | null } = { resolve: null };
    const started = new Promise<void>((resolve) => {
      startedSignal.resolve = resolve;
    });
    const pending = new Promise<ReturnType<typeof adminViewer>>((resolve) => {
      resolver.resolve = resolve;
    });
    vi.spyOn(bundle.usecases, "resolveViewerFromToken").mockImplementation(
      async () => {
        startedSignal.resolve?.();
        return pending;
      },
    );

    const message = bundle.hub.message(
      pair.connection,
      JSON.stringify({
        type: "connection_init",
        payload: { authorization: "Bearer valid" },
      }),
    );
    await started;
    await bundle.hub.closed(pair.connection);
    resolver.resolve?.(adminViewer());
    await message;

    expect(await bundle.host.loadState(pair.connection)).toBeNull();
    expect(bundle.hub.admit("127.0.0.1")).toBe("OK");
    expect(limiterCalls).toBe(0);
    expect(messagesOfType(pair.socket, "connection_ack")).toHaveLength(0);
  });

  test("logs and contains asynchronous drain failures after subscription", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await initialize(bundle);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(bundle.deps.mailEventLog, "listAfter").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      bundle.hub.message(pair.connection, subscribe("drain-failure")),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith("Realtime drain request failed");
    });
    expect(pair.socket.closes).toHaveLength(0);
  });

  test("fails open when the init rate limiter throws", async () => {
    const bundle = createRealtimeTestBundle({
      rateLimiter: {
        limit: async () => {
          throw new Error("storage unavailable");
        },
      },
    });
    const pair = await open(bundle);
    await expect(
      bundle.hub.message(
        pair.connection,
        JSON.stringify({
          type: "connection_init",
          payload: { authorization: "Bearer valid" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(messagesOfType(pair.socket, "connection_ack")).toHaveLength(1);
    expect(pair.socket.closes).toHaveLength(0);
  });

  test("closes with InternalError and contains persistence failures", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await initialize(bundle);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(bundle.host, "saveState").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      bundle.hub.message(pair.connection, '{"type":"ping"}'),
    ).resolves.toBeUndefined();
    expect(pair.socket.closes.at(-1)?.code).toBe(CloseCode.InternalError);
    expect(log).toHaveBeenCalledWith("Realtime message processing failed");
  });

  test("allows a later valid subscription after an earlier invalid one", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await initialize(bundle);
    const messages = [
      subscribe("invalid", "query { missingField }"),
      ...Array.from({ length: 4 }, (_, index) => subscribe(`valid-${index}`)),
    ];
    await Promise.all(
      messages.map((message) => bundle.hub.message(pair.connection, message)),
    );

    const state = await bundle.host.loadState(pair.connection);
    expect(state?.subscriptions.map(({ id }) => id)).toEqual([
      "valid-0",
      "valid-1",
      "valid-2",
      "valid-3",
    ]);
    expect(messagesOfType(pair.socket, "error")).toHaveLength(1);
    expect(pair.socket.closes).toHaveLength(0);
  });

  test("accepts a pipelined resubscribe after complete removes the id", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await initialize(bundle);
    await bundle.hub.message(pair.connection, subscribe("reused"));
    await Promise.all([
      bundle.hub.message(
        pair.connection,
        JSON.stringify({ type: "complete", id: "reused" }),
      ),
      bundle.hub.message(pair.connection, subscribe("reused")),
    ]);

    const state = await bundle.host.loadState(pair.connection);
    expect(state?.subscriptions.map(({ id }) => id)).toEqual(["reused"]);
    expect(pair.socket.closes).toHaveLength(0);
  });
});
