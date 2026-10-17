import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createDomainId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createRealtimeTestBundle,
  messagesOfType,
  type RecordingSocket,
} from "./hub-test-support";
import {
  ACTIVITY_PERSIST_INTERVAL_MS,
  CloseCode,
  IDLE_TIMEOUT_MS,
  MAX_FRAMES_PER_WINDOW,
  PRINCIPAL_CACHE_TTL_MS,
  REPLAY_PAGE,
} from "./protocol";

const EPOCH = "0123456789abcdef";
const QUERY =
  "subscription ($scope: MailEventScope, $after: String) { mailEvents(scope: $scope, after: $after) { cursor type } }";

afterEach(() => {
  vi.restoreAllMocks();
});

type Bundle = ReturnType<typeof createRealtimeTestBundle>;

async function connect(bundle: Bundle) {
  const pair = bundle.attach();
  await bundle.hub.open(pair.connection, {
    clientIp: null,
    cookieTokenHash: null,
  });
  await bundle.hub.message(
    pair.connection,
    JSON.stringify({
      type: "connection_init",
      payload: { authorization: "Bearer api-token" },
    }),
  );
  return pair;
}

function subscribeFrame(id: string, variables?: Record<string, unknown>) {
  return JSON.stringify({
    type: "subscribe",
    id,
    payload: {
      query: QUERY,
      ...(variables === undefined ? {} : { variables }),
    },
  });
}

async function appendEvents(bundle: Bundle, count: number): Promise<void> {
  await bundle.deps.mailEventLog.append(
    Array.from({ length: count }, (_, index) => ({
      type: MailEventType.MessageReceived,
      messageId: createMessageId(`cost-${index}-${Math.random()}`),
      domainId: createDomainId("dom-a"),
      addresses: ["inbox@example.test"],
    })),
    {
      occurredAt: "2026-08-23T00:00:00.000Z",
      retentionCutoff: "2026-08-16T00:00:00.000Z",
    },
  );
}

function cursorsOf(socket: RecordingSocket, id: string): string[] {
  return messagesOfType(socket, "next")
    .filter((message) => message["id"] === id)
    .map(
      (message) =>
        (
          message["payload"] as {
            readonly data?: {
              readonly mailEvents?: { readonly cursor?: string };
            };
          }
        ).data?.mailEvents?.cursor,
    )
    .filter((cursor): cursor is string => cursor !== undefined);
}

describe("per-frame storage writes", () => {
  test("ping and pong frames stay in memory until the persist interval elapses", async () => {
    let clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const pair = await connect(bundle);
    const save = vi.spyOn(bundle.host, "saveState");

    for (const type of ["ping", "pong", "ping"]) {
      clock += 1_000;
      await bundle.hub.message(pair.connection, JSON.stringify({ type }));
    }
    expect(save).not.toHaveBeenCalled();
    expect(messagesOfType(pair.socket, "pong")).toHaveLength(2);

    clock += ACTIVITY_PERSIST_INTERVAL_MS;
    await bundle.hub.message(pair.connection, '{"type":"ping"}');
    expect(save).toHaveBeenCalledTimes(1);
    expect((await bundle.host.loadState(pair.connection))?.lastMessageAt).toBe(
      clock,
    );

    clock += 1_000;
    await bundle.hub.message(pair.connection, '{"type":"ping"}');
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("state-changing frames still persist", async () => {
    const bundle = createRealtimeTestBundle();
    const pair = await connect(bundle);
    const save = vi.spyOn(bundle.host, "saveState");
    await bundle.hub.message(pair.connection, subscribeFrame("s"));
    expect(save).toHaveBeenCalled();
    save.mockClear();
    await bundle.hub.message(
      pair.connection,
      JSON.stringify({ type: "complete", id: "s" }),
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("in-memory activity from pings keeps a connection from idling out", async () => {
    let clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const pair = await connect(bundle);
    const stop = clock + IDLE_TIMEOUT_MS * 3;
    while (clock < stop) {
      clock += IDLE_TIMEOUT_MS / 3;
      await bundle.hub.message(pair.connection, '{"type":"ping"}');
      await bundle.hub.wake();
    }
    expect(pair.socket.closes).toHaveLength(0);

    clock += IDLE_TIMEOUT_MS + 1;
    await bundle.hub.wake();
    expect(pair.socket.closes.at(-1)?.code).toBe(CloseCode.Idle);
  });
});

describe("inbound frame rate limit", () => {
  test("closes a connection that exceeds the frame budget", async () => {
    const clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const pair = await connect(bundle);
    // connection_init already consumed one token.
    for (let index = 1; index < MAX_FRAMES_PER_WINDOW; index += 1) {
      await bundle.hub.message(pair.connection, '{"type":"pong"}');
    }
    expect(pair.socket.closes).toHaveLength(0);

    await bundle.hub.message(pair.connection, '{"type":"pong"}');
    expect(pair.socket.closes.at(-1)?.code).toBe(CloseCode.RateLimited);
    expect(await bundle.host.loadState(pair.connection)).toBeNull();
  });

  test("a steady keepalive cadence is never limited", async () => {
    let clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const pair = await connect(bundle);
    for (let index = 0; index < MAX_FRAMES_PER_WINDOW * 4; index += 1) {
      clock += 1_000;
      await bundle.hub.message(pair.connection, '{"type":"pong"}');
    }
    expect(pair.socket.closes).toHaveLength(0);
  });
});

describe("drain principal cache", () => {
  test("reuses the viewer within the TTL and re-resolves after it", async () => {
    let clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const resolve = vi.spyOn(bundle.usecases, "resolveViewerFromTokenHash");
    const pair = await connect(bundle);
    await bundle.hub.message(pair.connection, subscribeFrame("s"));
    await bundle.hub.requestDrain();
    const afterFirst = resolve.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    for (let index = 0; index < 3; index += 1) {
      clock += 1_000;
      await bundle.hub.requestDrain();
    }
    // The subscribe handler resolves once on its own; drains add none.
    expect(resolve.mock.calls.length).toBe(afterFirst);

    clock += PRINCIPAL_CACHE_TTL_MS;
    await bundle.hub.requestDrain();
    expect(resolve.mock.calls.length).toBe(afterFirst + 1);
  });

  test("a revocation inside the TTL is noticed once the TTL passes", async () => {
    let clock = Date.now();
    const bundle = createRealtimeTestBundle({ now: () => clock });
    const pair = await connect(bundle);
    await bundle.hub.message(pair.connection, subscribeFrame("s"));
    await bundle.hub.requestDrain();

    bundle.setViewer(null);
    clock += PRINCIPAL_CACHE_TTL_MS - 1;
    await bundle.hub.requestDrain();
    expect(pair.socket.closes).toHaveLength(0);

    clock += 1;
    await bundle.hub.requestDrain();
    expect(pair.socket.closes.at(-1)?.code).toBe(CloseCode.Unauthorized);
  });
});

describe("replay bucketing", () => {
  test("a far-behind subscription does not delay one that is at the head", async () => {
    const bundle = createRealtimeTestBundle();
    const order: string[] = [];
    const trace = (socket: RecordingSocket, label: string): void => {
      const original = socket.send.bind(socket);
      vi.spyOn(socket, "send").mockImplementation((text) => {
        const parsed = JSON.parse(text) as {
          readonly type?: string;
          readonly payload?: {
            readonly data?: {
              readonly mailEvents?: { readonly cursor?: string };
            };
          };
        };
        const cursor = parsed.payload?.data?.mailEvents?.cursor;
        if (parsed.type === "next" && cursor !== undefined)
          order.push(`${label}:${cursor}`);
        original(text);
      });
    };

    await appendEvents(bundle, REPLAY_PAGE * 2 + 50);
    const head = REPLAY_PAGE * 2 + 50;
    const current = await connect(bundle);
    trace(current.socket, "current");
    await bundle.hub.message(current.connection, subscribeFrame("current"));
    await bundle.hub.requestDrain();
    await appendEvents(bundle, 1);

    const lagging = await connect(bundle);
    trace(lagging.socket, "lagging");
    await bundle.hub.message(
      lagging.connection,
      subscribeFrame("lagging", { after: `${EPOCH}.0` }),
    );
    await bundle.hub.requestDrain();

    const newest = `${EPOCH}.${head + 1}`;
    const secondPage = `${EPOCH}.${REPLAY_PAGE + 1}`;
    expect(order).toContain(`current:${newest}`);
    expect(order).toContain(`lagging:${secondPage}`);
    expect(order.indexOf(`current:${newest}`)).toBeLessThan(
      order.indexOf(`lagging:${secondPage}`),
    );
    const laggingCursors = cursorsOf(lagging.socket, "lagging");
    expect(laggingCursors.slice(0, head + 1)).toEqual(
      Array.from({ length: head + 1 }, (_, index) => `${EPOCH}.${index + 1}`),
    );
    expect(laggingCursors.at(-1)).toBe(newest);
  });
});
