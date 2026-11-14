import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDurableObjectMailEventNotifier,
  createNoopMailEventNotifier,
  type DurableObjectNamespaceLike,
  MAIL_EVENT_HUB_NAME,
  MAIL_EVENT_HUB_NOTIFY_URL,
} from "./mail-event-notifiers";

function namespaceFor(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
): DurableObjectNamespaceLike {
  return {
    idFromName(name) {
      expect(name).toBe(MAIL_EVENT_HUB_NAME);
      return "hub-id";
    },
    get(id) {
      expect(id).toBe("hub-id");
      return { fetch };
    },
  };
}

describe("mail event notifiers", () => {
  afterEach(() => vi.restoreAllMocks());

  test("coalesces notifies during a request into one follow-up POST", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const notifier = createDurableObjectMailEventNotifier(
      namespaceFor((input, init) => {
        calls.push({ input, init });
        if (calls.length === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );

    notifier.notify();
    notifier.notify();
    notifier.notify();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      input: MAIL_EVENT_HUB_NOTIFY_URL,
      init: { method: "POST" },
    });
    resolveFirst?.(new Response(null, { status: 204 }));
    await notifier.settle();
    expect(calls).toHaveLength(2);
  });

  test("swallows fetch failures and settle resolves", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const notifier = createDurableObjectMailEventNotifier(
      namespaceFor(() => Promise.reject(new Error("offline"))),
    );
    expect(() => notifier.notify()).not.toThrow();
    await expect(notifier.settle()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("Mail event notify failed", {
      status: 0,
    });
  });

  test("no-op notifier has no side effects", () => {
    expect(() => createNoopMailEventNotifier().notify()).not.toThrow();
  });
});
