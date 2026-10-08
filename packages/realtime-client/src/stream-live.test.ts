import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailEventStream } from "./stream";
import type { WebSocketLike } from "./protocol";

class ScriptedSocket implements WebSocketLike {
  readonly protocol = "graphql-transport-ws";
  readonly sent: string[] = [];
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

async function ready(socket: ScriptedSocket): Promise<void> {
  socket.open();
  await Promise.resolve();
  await Promise.resolve();
  socket.receive({ type: "connection_ack" });
}

function subscriptionId(socket: ScriptedSocket): string {
  for (const frame of socket.sent) {
    const message = JSON.parse(frame) as Record<string, unknown>;
    if (message["type"] === "subscribe" && typeof message["id"] === "string") {
      return message["id"];
    }
  }
  throw new Error("Expected a subscribe frame");
}

function sendEvent(socket: ScriptedSocket, cursor: string, type: string): void {
  socket.receive({
    id: subscriptionId(socket),
    type: "next",
    payload: { data: { mailEvents: { cursor, type } } },
  });
}

function subscribedAfter(socket: ScriptedSocket): unknown {
  for (const frame of socket.sent) {
    const message = JSON.parse(frame) as Record<string, unknown>;
    if (message["type"] !== "subscribe") continue;
    const payload = message["payload"] as Record<string, unknown>;
    const variables = payload["variables"] as Record<string, unknown>;
    return variables["after"];
  }
  throw new Error("Expected a subscribe frame");
}

describe("same-cursor LIVE handling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("accepts same-cursor LIVE but still drops older LIVE and same-cursor mail events", async () => {
    const { sockets, factory } = socketHarness();
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    const onStatus = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      initialCursor: "epoch.5",
      onEvent,
      onCursor,
      onStatus,
      webSocketFactory: factory,
    });

    stream.start();
    await ready(socketAt(sockets, 0));
    const socket = socketAt(sockets, 0);
    sendEvent(socket, "epoch.4", "LIVE");
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalledWith("live");

    sendEvent(socket, "epoch.5", "LIVE");
    expect(onStatus).toHaveBeenCalledWith("live");
    expect(onCursor.mock.calls).toEqual([["epoch.5"]]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      cursor: "epoch.5",
      type: "LIVE",
    });

    sendEvent(socket, "epoch.5", "MESSAGE_UPDATED");
    expect(onEvent).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it("resets backoff after same-cursor LIVE on a resumed subscription", async () => {
    const { sockets, factory } = socketHarness();
    const onStatus = vi.fn();
    const stream = createMailEventStream({
      url: "ws://mail.test/graphql",
      query: "q",
      onEvent: vi.fn(),
      onStatus,
      random: () => 1,
      webSocketFactory: factory,
    });

    stream.start();
    await ready(socketAt(sockets, 0));
    sendEvent(socketAt(sockets, 0), "epoch.5", "MESSAGE_UPDATED");
    sendEvent(socketAt(sockets, 0), "epoch.5", "LIVE");
    expect(onStatus).toHaveBeenLastCalledWith("live");

    socketAt(sockets, 0).disconnect(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
    await ready(socketAt(sockets, 1));
    expect(subscribedAfter(socketAt(sockets, 1))).toBe("epoch.5");
    sendEvent(socketAt(sockets, 1), "epoch.5", "LIVE");
    expect(onStatus).toHaveBeenLastCalledWith("live");

    socketAt(sockets, 1).disconnect(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(3);
    stream.stop();
  });
});
