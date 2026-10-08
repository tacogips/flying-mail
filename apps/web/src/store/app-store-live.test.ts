import type {
  MailEventStream,
  MailEventStreamOptions,
} from "@flying-mail/realtime-client";
import type { MessageView } from "../api/schema-types";
import { createAppStore, type AppStore } from "./app-store";
import { createLiveUpdates } from "./app-store-live";
import { afterEach, describe, expect, test, vi } from "vitest";

interface FakeStoreOverrides {
  readonly viewer?: () => { readonly id: string } | null;
  readonly rehydrateSession?: () => Promise<void>;
}

function fakeStore(overrides: FakeStoreOverrides = {}): AppStore {
  return {
    viewer: overrides.viewer ?? (() => ({ id: "viewer" })),
    setLiveStatus: vi.fn(),
    publishLiveMessageEvent: vi.fn(),
    subscribeToLiveMessageEvents: vi.fn(() => () => undefined),
    patchMessage: vi.fn(),
    removeMessage: vi.fn(),
    refreshVisible: vi.fn(async () => undefined),
    reloadTags: vi.fn(async () => undefined),
    rehydrateSession:
      overrides.rehydrateSession ?? vi.fn(async () => undefined),
  } as unknown as AppStore;
}

function harness(store = fakeStore()) {
  let callbacks: MailEventStreamOptions | undefined;
  const start = vi.fn();
  const stop = vi.fn();
  const streamFactory = vi.fn(
    (options: MailEventStreamOptions): MailEventStream => {
      callbacks = options;
      return { start, stop };
    },
  );
  const live = createLiveUpdates(store, {
    streamFactory,
    location: { protocol: "https:", host: "mail.example.test" } as Location,
  });
  return {
    store,
    live,
    start,
    stop,
    streamFactory,
    callbacks: () => callbacks,
  };
}

function message(id: string, readAt: string | null = null): MessageView {
  return { id, readAt } as MessageView;
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function page(nodes: readonly MessageView[], nextCursor: string | null) {
  return { nodes, nextCursor, totalCount: 51 };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web live updates", () => {
  test("uses the same-origin wss endpoint with cookie auth and unscoped variables", () => {
    const h = harness();
    h.live.start();
    expect(h.streamFactory).toHaveBeenCalledOnce();
    const options = h.callbacks();
    expect(options?.url).toBe("wss://mail.example.test/graphql");
    expect(options?.scope).toBeNull();
    expect(options).not.toHaveProperty("connectionParams");
  });

  test("patches loaded messages and removes deleted ids", () => {
    const h = harness();
    h.live.start();
    const onEvent = h.callbacks()?.onEvent;
    if (onEvent === undefined) throw new Error("stream event handler missing");
    const changed = message("msg-1", "2026-10-08T00:00:00.000Z");
    onEvent({ type: "MESSAGE_UPDATED", message: changed });
    onEvent({ type: "MESSAGE_DELETED", messageId: "msg-2" });
    expect(h.store.patchMessage).toHaveBeenCalledWith(changed);
    expect(h.store.removeMessage).toHaveBeenCalledWith("msg-2");
  });

  test("coalesces non-LIVE events into one trailing 750ms refresh", () => {
    vi.useFakeTimers();
    const h = harness();
    h.live.start();
    const onEvent = h.callbacks()?.onEvent;
    if (onEvent === undefined) throw new Error("stream event handler missing");
    onEvent({ type: "MESSAGE_UPDATED" });
    onEvent({ type: "DRAFT_SAVED" });
    onEvent({ type: "MESSAGE_SENT" });
    vi.advanceTimersByTime(749);
    expect(h.store.refreshVisible).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.store.refreshVisible).toHaveBeenCalledOnce();
  });

  test("runs refresh and tag reload for every LIVE event, including the first", () => {
    const h = harness();
    h.live.start();
    const onEvent = h.callbacks()?.onEvent;
    if (onEvent === undefined) throw new Error("stream event handler missing");
    onEvent({ type: "LIVE" });
    onEvent({ type: "LIVE" });
    expect(h.store.refreshVisible).toHaveBeenCalledTimes(2);
    expect(h.store.reloadTags).toHaveBeenCalledTimes(2);
  });

  test("rehydrates after 4401 and stops when the session is gone", async () => {
    const viewer: { readonly id: string } | null = null;
    const store = fakeStore({ viewer: () => viewer });
    const h = harness(store);
    h.live.start();
    const authFailure = h.callbacks()?.onAuthFailure;
    if (authFailure === undefined) throw new Error("auth handler missing");
    authFailure();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.rehydrateSession).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.live.status()).toBe("offline");
  });

  test("restarts after 4401 when the session remains valid", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const viewer = { id: "viewer" };
    const store = fakeStore({ viewer: () => viewer });
    const h = harness(store);
    h.live.start();
    const authFailure = h.callbacks()?.onAuthFailure;
    if (authFailure === undefined) throw new Error("auth handler missing");
    authFailure();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.rehydrateSession).toHaveBeenCalledOnce();
    expect(h.start).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(499);
    expect(h.start).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  test("stops after three consecutive auth failures and clears retry timers", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = harness();
    h.live.start();
    const authFailure = h.callbacks()?.onAuthFailure;
    if (authFailure === undefined) throw new Error("auth handler missing");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      authFailure();
      await Promise.resolve();
      await Promise.resolve();
      if (attempt < 2) vi.advanceTimersByTime(500 * 2 ** attempt);
    }
    expect(h.start).toHaveBeenCalledTimes(3);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.live.status()).toBe("offline");
  });

  test("stop cancels a pending debounced refresh", () => {
    vi.useFakeTimers();
    const h = harness();
    h.live.start();
    const onEvent = h.callbacks()?.onEvent;
    if (onEvent === undefined) throw new Error("stream event handler missing");
    onEvent({ type: "MESSAGE_UPDATED" });
    h.live.stop();
    vi.advanceTimersByTime(750);
    expect(h.store.refreshVisible).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  test("goes offline without creating a stream when WebSocket is unavailable", () => {
    vi.stubGlobal("WebSocket", undefined);
    const h = harness();
    expect(() => h.live.start()).not.toThrow();
    expect(h.live.status()).toBe("offline");
    expect(h.streamFactory).not.toHaveBeenCalled();
  });
});

describe("AppStore.refreshVisible", () => {
  test("replaces page one while preserving page two and surviving selection", async () => {
    let messagesRequests = 0;
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      message(`first-${index + 1}`),
    );
    const refreshedFirstPage = [message("new-first")];
    const pageTwo = [message("page-two")];
    const requests: { query: string; variables: Record<string, unknown> }[] =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        requests.push(body);
        if (body.query.includes("query Messages")) {
          messagesRequests += 1;
          if (messagesRequests === 1) {
            return response({ messages: page(firstPage, "cursor-page-one") });
          }
          if (messagesRequests === 2) {
            return response({ messages: page(pageTwo, "cursor-page-two") });
          }
          return response({ messages: page(refreshedFirstPage, "new-cursor") });
        }
        if (body.query.includes("query Viewer")) {
          return response({ viewer: { addressActivity: [] } });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );
    const store = createAppStore();
    await store.reloadMessages();
    await store.loadMore();
    store.toggleSelection("first-1");
    store.toggleSelection("page-two");

    await store.refreshVisible();

    expect(store.messages().map(({ id }) => id)).toEqual([
      "new-first",
      "page-two",
    ]);
    expect([...store.selectedIds()]).toEqual(["page-two"]);
    expect(store.hasMore()).toBe(true);
    expect(requests.at(-3)?.variables["after"]).toBeNull();

    const patchedPageTwo = message("page-two", "2026-10-08T00:00:00.000Z");
    store.patchMessage(patchedPageTwo);
    expect(store.messages()).toEqual([message("new-first"), patchedPageTwo]);
    store.removeMessage("page-two");
    expect(store.messages().map(({ id }) => id)).toEqual(["new-first"]);
    expect([...store.selectedIds()]).toEqual([]);
  });

  test("keeps the second page after new mail shifts the first-page overlap", async () => {
    let messagesRequests = 0;
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      message(`row-${index + 1}`),
    );
    const firstPageAfterNewMail = [
      message("new-mail"),
      ...firstPage.slice(0, 49),
    ];
    const pageTwo = [message("page-two")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("query Messages")) {
          messagesRequests += 1;
          if (messagesRequests === 1) {
            return response({ messages: page(firstPage, "cursor-one") });
          }
          if (messagesRequests === 2) {
            return response({ messages: page(pageTwo, "cursor-two") });
          }
          return response({
            messages: page(firstPageAfterNewMail, "cursor-new"),
          });
        }
        if (body.query.includes("query Viewer")) {
          return response({ viewer: { addressActivity: [] } });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );
    const store = createAppStore();
    await store.reloadMessages();
    await store.loadMore();

    await store.refreshVisible();

    expect(store.messages()).toHaveLength(52);
    expect(store.messages()[0]?.id).toBe("new-mail");
    expect(store.messages().at(-1)?.id).toBe("page-two");
  });

  test("preserves page two when a first-page row was removed before refresh", async () => {
    let messagesRequests = 0;
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      message(`row-${index + 1}`),
    );
    const pageTwo = [message("page-two")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("query Messages")) {
          messagesRequests += 1;
          if (messagesRequests === 1) {
            return response({ messages: page(firstPage, "cursor-one") });
          }
          if (messagesRequests === 2) {
            return response({ messages: page(pageTwo, "cursor-two") });
          }
          return response({ messages: page(firstPage, "cursor-new") });
        }
        if (body.query.includes("query Viewer")) {
          return response({ viewer: { addressActivity: [] } });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );
    const store = createAppStore();
    await store.reloadMessages();
    await store.loadMore();
    store.removeMessage("row-10");

    await store.refreshVisible();

    expect(store.messages()).toHaveLength(51);
    expect(store.messages().at(-1)?.id).toBe("page-two");
  });

  test("ignores a stale refresh when switching folders", async () => {
    let resolveRefresh: ((value: Response) => void) | undefined;
    let messagesRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { filter: { direction?: string } };
        };
        if (body.query.includes("query Messages")) {
          messagesRequests += 1;
          if (messagesRequests === 1) {
            return response({ messages: page([message("inbox")], null) });
          }
          if (messagesRequests === 2) {
            return await new Promise<Response>((resolve) => {
              resolveRefresh = resolve;
            });
          }
          expect(body.variables.filter.direction).toBe("OUTBOUND");
          return response({
            messages: { ...page([message("sent")], null), totalCount: 7 },
          });
        }
        if (body.query.includes("query Viewer")) {
          return response({ viewer: { addressActivity: [] } });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );
    const store = createAppStore();
    await store.reloadMessages();
    const refreshing = store.refreshVisible();
    const switching = store.setView({ folder: { kind: "SENT" }, scope: {} });
    await switching;
    resolveRefresh?.(
      response({
        messages: { ...page([message("stale-inbox")], null), totalCount: 99 },
      }),
    );
    await refreshing;

    expect(store.messages().map(({ id }) => id)).toEqual(["sent"]);
    expect(store.totalCount()).toBe(7);
  });

  test("does not let an early LIVE catch-up replace deep-linked SENT results", async () => {
    let resolveRefresh: ((value: Response) => void) | undefined;
    let messagesRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { filter: { direction?: string } };
        };
        if (body.query.includes("query Messages")) {
          messagesRequests += 1;
          expect(body.variables.filter.direction).toBe("OUTBOUND");
          if (messagesRequests === 1) {
            return await new Promise<Response>((resolve) => {
              resolveRefresh = resolve;
            });
          }
          return response({
            messages: {
              ...page([message("sent-current")], null),
              totalCount: 3,
            },
          });
        }
        if (body.query.includes("query Viewer")) {
          return response({ viewer: { addressActivity: [] } });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );
    const store = createAppStore();
    const deepLink = store.setView({ folder: { kind: "SENT" }, scope: {} });
    const liveCatchUp = store.refreshVisible();
    await liveCatchUp;
    resolveRefresh?.(
      response({
        messages: { ...page([message("stale-sent")], null), totalCount: 100 },
      }),
    );
    await deepLink;

    expect(store.messages().map(({ id }) => id)).toEqual(["sent-current"]);
    expect(store.totalCount()).toBe(3);
    expect(store.loading()).toBe(false);
  });
});
