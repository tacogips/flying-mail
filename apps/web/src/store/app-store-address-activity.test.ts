import { afterEach, describe, expect, test, vi } from "vitest";
import { createAppStore } from "./app-store";

const firstActivity = [
  {
    address: "inbox@example.com",
    domainId: "dom-1",
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    unreadCount: 1,
  },
];
const refreshedActivity = [
  {
    address: "inbox@example.com",
    domainId: "dom-1",
    lastActivityAt: "2026-10-07T00:00:00.000Z",
    unreadCount: 2,
  },
];

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function viewer(activity: typeof firstActivity) {
  return {
    viewer: {
      user: {
        id: "usr-1",
        email: "user@example.com",
        name: "User",
        role: "ADMIN",
      },
      apiKey: null,
      capabilities: ["MAIL_READ", "MAIL_SEND"],
      sendableAddresses: ["outbox@example.com"],
      readableAddresses: ["inbox@example.com"],
      addressActivity: activity,
    },
  };
}

describe("AppStore address activity refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("refreshes address activity after a send and a receive reload", async () => {
    let viewerRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          readonly query: string;
        };
        if (body.query.includes("query Viewer")) {
          viewerRequests += 1;
          return response(
            viewer(viewerRequests === 1 ? firstActivity : refreshedActivity),
          );
        }
        if (body.query.includes("query MailLimits")) {
          return response({
            mailLimits: {
              maxAttachmentBytes: 1,
              maxOutboundTotalBytes: 1,
              maxMessageBytes: 1,
            },
          });
        }
        if (body.query.includes("mutation SendMessage")) {
          return response({
            sendMessage: {
              id: "msg-sent",
              deliveryStatus: "SENT",
            },
          });
        }
        if (body.query.includes("query Messages")) {
          return response({
            messages: { nodes: [], nextCursor: null, totalCount: 0 },
          });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );

    const store = createAppStore();
    await store.rehydrateSession();
    expect(store.viewer()?.addressActivity).toEqual(firstActivity);

    await store.send({
      from: "outbox@example.com",
      to: ["inbox@example.com"],
      subject: "sent",
    });
    expect(store.viewer()?.addressActivity).toEqual(refreshedActivity);

    viewerRequests = 1;
    await store.reloadMessages();
    expect(store.viewer()?.addressActivity).toEqual(refreshedActivity);
  });

  test("refreshes address activity after deleting selected messages", async () => {
    let viewerRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          readonly query: string;
        };
        if (body.query.includes("query Viewer")) {
          viewerRequests += 1;
          return response(
            viewer(viewerRequests < 3 ? firstActivity : refreshedActivity),
          );
        }
        if (body.query.includes("query MailLimits")) {
          return response({
            mailLimits: {
              maxAttachmentBytes: 1,
              maxOutboundTotalBytes: 1,
              maxMessageBytes: 1,
            },
          });
        }
        if (body.query.includes("query Messages")) {
          return response({
            messages: {
              nodes: [
                {
                  id: "msg-1",
                  threadId: "thread-1",
                  direction: "INBOUND",
                  subject: "message",
                  snippet: "message",
                  from: { address: "sender@example.net", name: null },
                  recipients: [],
                  tags: [],
                  attachments: [],
                  isSpam: false,
                  spam: null,
                  spamScore: null,
                  status: "RECEIVED",
                  deliveryStatus: "RECEIVED",
                  listId: null,
                  isMailingList: false,
                  deliveryError: null,
                  readAt: null,
                  fetchStatus: "NONE",
                  occurredAt: "2026-10-01T00:00:00.000Z",
                  domain: { id: "dom-1", name: "example.com" },
                },
              ],
              nextCursor: null,
              totalCount: 1,
            },
          });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        if (body.query.includes("mutation DeleteMessages")) {
          return response({ deleteMessages: 1 });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );

    const store = createAppStore();
    await store.rehydrateSession();
    await store.reloadMessages();
    store.toggleSelection("msg-1");
    await store.deleteSelected();

    expect(viewerRequests).toBe(3);
    expect(store.viewer()?.addressActivity).toEqual(refreshedActivity);
  });

  test("does not restore a viewer when address refresh finishes after logout", async () => {
    let viewerRequests = 0;
    let addressRefreshStarted = false;
    let releaseAddressRefresh: ((result: Response) => void) | undefined;
    const addressRefresh = new Promise<Response>((resolve) => {
      releaseAddressRefresh = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          readonly query: string;
        };
        if (body.query.includes("query Viewer")) {
          viewerRequests += 1;
          if (viewerRequests === 1) {
            return response(viewer(firstActivity));
          }
          addressRefreshStarted = true;
          return addressRefresh;
        }
        if (body.query.includes("query MailLimits")) {
          return response({
            mailLimits: {
              maxAttachmentBytes: 1,
              maxOutboundTotalBytes: 1,
              maxMessageBytes: 1,
            },
          });
        }
        if (body.query.includes("query Messages")) {
          return response({
            messages: { nodes: [], nextCursor: null, totalCount: 0 },
          });
        }
        if (body.query.includes("query UnreadCount")) {
          return response({ messages: { totalCount: 0 } });
        }
        if (body.query.includes("mutation Logout")) {
          return response({ logout: true });
        }
        throw new Error(`Unexpected GraphQL operation: ${body.query}`);
      }),
    );

    const store = createAppStore();
    await store.rehydrateSession();
    const reload = store.reloadMessages();
    while (!addressRefreshStarted) {
      await Promise.resolve();
    }
    await store.logout();
    releaseAddressRefresh?.(response(viewer(refreshedActivity)));
    await reload;

    expect(store.viewer()).toBeNull();
  });
});
