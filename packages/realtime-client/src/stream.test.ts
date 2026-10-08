import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailEventStream } from "./stream";
import type { WebSocketLike } from "./protocol";

class ScriptedSocket implements WebSocketLike {
  readonly protocol = "graphql-transport-ws";
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
  onclose:
    | ((ev: { readonly code: number; readonly reason: string }) => void)
    | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.closeCalls.push({ code, reason });
    this.disconnect(code, reason);
  }

  open(): void {
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  disconnect(code: number, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

function socketHarness() {
  const sockets: ScriptedSocket[] = [];
  const factory = vi.fn((_url: string, protocol: string): WebSocketLike => {
    expect(protocol).toBe("graphql-transport-ws");
    const socket = new ScriptedSocket();
    sockets.push(socket);
    return socket;
  });
  return { sockets, factory };
}

function socketAt(sockets: ScriptedSocket[], index: number): ScriptedSocket {
  const socket = sockets[index];
  if (socket === undefined) throw new Error(`Expected socket ${index}`);
  return socket;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sentMessages(socket: ScriptedSocket): Array<Record<string, unknown>> {
  return socket.sent.map(
    (frame) => JSON.parse(frame) as Record<string, unknown>,
  );
}

function subscribeMessage(
  socket: ScriptedSocket,
  index = 0,
): Record<string, unknown> {
  const message = sentMessages(socket).filter(
    (entry) => entry["type"] === "subscribe",
  )[index];
  if (message === undefined) throw new Error("Expected a subscribe frame");
  return message;
}

async function ready(socket: ScriptedSocket): Promise<void> {
  socket.open();
  await flushPromises();
  socket.receive({ type: "connection_ack" });
}

function event(
  id: string,
  cursor: string,
  type = "MESSAGE_UPDATED",
): Record<string, unknown> {
  return {
    id,
    type: "next",
    payload: { data: { mailEvents: { cursor, type } } },
  };
}

describe("createMailEventStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("initializes, subscribes, reports LIVE, and delivers events", async () => {
    const { sockets, factory } = socketHarness();
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    const onStatus = vi.fn();
    const stream = createMailEventStream({
      url: "wss://mail.test/graphql",
      query: "subscription { mailEvents { cursor type } }",
      connectionParams: () => ({ authorization: "Bearer secret" }),
      onEvent,
      onCursor,
      onStatus,
      webSocketFactory: factory,
    });

    stream.start();
    expect(factory).toHaveBeenCalledTimes(1);
    await ready(socketAt(sockets, 0));
    expect(sentMessages(socketAt(sockets, 0))[0]).toEqual({
      type: "connection_init",
      payload: { authorization: "Bearer secret" },
    });
    expect(subscribeMessage(socketAt(sockets, 0))["payload"]).toEqual({
      query: "subscription { mailEvents { cursor type } }",
      variables: { scope: null, after: null },
    });

    socketAt(sockets, 0).receive(event("1", "epoch.1", "LIVE"));
    socketAt(sockets, 0).receive(event("1", "epoch.2"));
    expect(onStatus).toHaveBeenCalledWith("live");
    expect(onCursor.mock.calls).toEqual([["epoch.1"], ["epoch.2"]]);
    expect(onEvent.mock.calls.map(([value]) => value["cursor"])).toEqual([
      "epoch.1",
      "epoch.2",
    ]);
    stream.stop();
  });

  it("backs off exponentially with jitter and caps the delay at 30 seconds", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [index, delay] of delays.entries()) {
      const current = socketAt(sockets, sockets.length - 1);
      current.disconnect(1006);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(factory).toHaveBeenCalledTimes(sockets.length);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(index + 2);
    }
    stream.stop();
  });

  it("resets the retry attempt after LIVE", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();
    socketAt(sockets, 0).disconnect(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await ready(socketAt(sockets, 1));
    socketAt(sockets, 1).receive(event("1", "epoch.1", "LIVE"));
    socketAt(sockets, 1).disconnect(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(3);
    stream.stop();
  });

  it("resumes from the latest cursor and refreshes connection params on reconnect", async () => {
    const { sockets, factory } = socketHarness();
    let parameterAttempt = 0;
    const connectionParams = vi.fn(() => {
      parameterAttempt += 1;
      return { authorization: `Bearer token-${parameterAttempt}` };
    });
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      connectionParams,
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    await flushPromises();
    socketAt(sockets, 0).receive(event("1", "epoch.5"));
    socketAt(sockets, 0).disconnect(1006);
    await vi.advanceTimersByTimeAsync(1000);
    await ready(socketAt(sockets, 1));
    expect(connectionParams).toHaveBeenCalledTimes(2);
    expect(sentMessages(socketAt(sockets, 0))[0]?.["payload"]).toEqual({
      authorization: "Bearer token-1",
    });
    expect(sentMessages(socketAt(sockets, 1))[0]?.["payload"]).toEqual({
      authorization: "Bearer token-2",
    });
    expect(subscribeMessage(socketAt(sockets, 1))["payload"]).toMatchObject({
      variables: { after: "epoch.5" },
    });
    stream.stop();
  });

  it("drops older and same-cursor replayed events", async () => {
    const { sockets, factory } = socketHarness();
    const onEvent = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      initialCursor: "epoch.5",
      onEvent,
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    socketAt(sockets, 0).receive(event("1", "epoch.4"));
    socketAt(sockets, 0).receive(event("1", "epoch.5"));
    expect(onEvent).not.toHaveBeenCalled();
    stream.stop();
  });

  it("clears the cursor and resubscribes without after on the same socket", async () => {
    const { sockets, factory } = socketHarness();
    const onCursor = vi.fn();
    const onResync = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      initialCursor: "epoch.8",
      onEvent: vi.fn(),
      onCursor,
      onResync,
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    const socket = socketAt(sockets, 0);
    const firstId = subscribeMessage(socket)["id"];
    socket.receive({
      id: firstId,
      type: "error",
      payload: [{ message: "resync", extensions: { code: "RESYNC_REQUIRED" } }],
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(onCursor).toHaveBeenCalledWith(null);
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(subscribeMessage(socket, 1)["id"]).not.toBe(firstId);
    expect(subscribeMessage(socket, 1)["payload"]).toMatchObject({
      variables: { after: null },
    });
    stream.stop();
  });

  it.each([
    [4401, "auth"],
    [4403, "fatal"],
    [4400, "fatal"],
    [4409, "fatal"],
    [4429, "fatal"],
    [1009, "fatal"],
  ])("stops on close code %i (%s)", async (code, kind) => {
    const { sockets, factory } = socketHarness();
    const onAuthFailure = vi.fn();
    const onFatal = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      onAuthFailure,
      onFatal,
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    socketAt(sockets, 0).disconnect(code as number, "closed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    if (kind === "auth") expect(onAuthFailure).toHaveBeenCalledTimes(1);
    else expect(onFatal).toHaveBeenCalledWith({ code, reason: "closed" });
  });

  it("sends the exact ping frame and reconnects after a missing pong", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(socketAt(sockets, 0).sent).toContain('{"type":"ping"}');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socketAt(sockets, 0).closeCalls.at(-1)).toMatchObject({
      code: 4000,
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stream.stop();
  });

  it("answers server pings with pong", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      webSocketFactory: factory,
    });
    stream.start();
    await ready(socketAt(sockets, 0));
    socketAt(sockets, 0).receive({ type: "ping" });
    expect(socketAt(sockets, 0).sent).toContain('{"type":"pong"}');
    stream.stop();
  });

  it("retries when connection_ack is not received within 10 seconds", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();
    socketAt(sockets, 0).open();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socketAt(sockets, 0).closeCalls.at(-1)).toMatchObject({
      code: 4408,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(factory).toHaveBeenCalledTimes(2);
    stream.stop();
  });

  it("does not reconnect when stopped during a pending retry", async () => {
    const { sockets, factory } = socketHarness();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      random: () => 1,
      webSocketFactory: factory,
    });
    stream.start();
    socketAt(sockets, 0).disconnect(1006);
    stream.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("starts again after stop and reports connecting for the new attempt", () => {
    const { sockets, factory } = socketHarness();
    const onStatus = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      onStatus,
      webSocketFactory: factory,
    });

    stream.start();
    stream.stop();
    onStatus.mockClear();
    stream.start();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(onStatus).toHaveBeenCalledWith("connecting");
    stream.stop();
  });
});
