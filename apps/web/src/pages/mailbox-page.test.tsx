import { Route, Router } from "@solidjs/router";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  MailDomainView,
  MessageDetailView,
  MessageView,
  ViewerView,
} from "../api/schema-types";
import type { MailboxView } from "../lib/filter-params";
import { StoreProvider } from "../store/store-context";
import type { AppStore } from "../store/app-store";
import { applyLiveMessageEvent } from "./mailbox-page";
import MailboxPage from "./mailbox-page";

const domain: MailDomainView = {
  id: "dom-alpha",
  name: "alpha.example",
  status: "ACTIVE",
  inboundMx: "READY",
  catchAll: true,
  verificationToken: null,
  verifiedAt: "2026-10-01T00:00:00.000Z",
  messageCount: 1,
  dnsRecords: [],
};

const viewer: ViewerView = {
  user: { id: "usr-1", email: "user@example.com", name: "User", role: "ADMIN" },
  apiKey: null,
  capabilities: ["MAIL_READ", "MAIL_SEND", "DOMAIN_ADMIN"],
  sendableAddresses: ["sender@alpha.example"],
  readableAddresses: ["inbox@alpha.example"],
  addressActivity: [],
};

describe("MailboxPage domain unread refresh", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reloads per-domain unread counts when the inbox unread count changes", async () => {
    const [inboxUnreadCount, setInboxUnreadCount] = createSignal(1);
    const store = {
      viewer: () => viewer,
      domains: () => [domain],
      tags: () => [],
      messages: () => [],
      totalCount: () => 0,
      hasMore: () => false,
      loading: () => false,
      selectedIds: () => new Set<string>(),
      view: (): MailboxView => ({ folder: { kind: "INBOX" }, scope: {} }),
      unreadOnly: () => false,
      inboxUnreadCount,
      mailLimits: () => null,
      upcomingEvents: () => [],
      subscribeToLiveMessageEvents: vi.fn(() => () => undefined),
      setView: vi.fn(async () => undefined),
      clearSelection: vi.fn(),
      toggleSelection: vi.fn(),
      setUnreadOnly: vi.fn(async () => undefined),
      reloadMessages: vi.fn(async () => undefined),
      loadMore: vi.fn(async () => undefined),
      selectAll: vi.fn(),
      markSelectedRead: vi.fn(async () => undefined),
      markSelectedSpam: vi.fn(async () => undefined),
      deleteSelected: vi.fn(async () => undefined),
      setStarred: vi.fn(async () => true),
      setArchived: vi.fn(async () => true),
      logout: vi.fn(async () => undefined),
      systemTag: vi.fn(() => null),
      reloadUpcomingEvents: vi.fn(async () => undefined),
    } as unknown as AppStore;
    const unreadRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          readonly query: string;
          readonly variables?: {
            readonly filter?: { readonly domainId?: string };
          };
        };
        if (request.query.includes("query UnreadCount")) {
          unreadRequests.push(request.variables?.filter?.domainId ?? "all");
          return new Response(
            JSON.stringify({
              data: { messages: { totalCount: unreadRequests.length } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected GraphQL operation: ${request.query}`);
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const dispose = render(
      () => (
        <StoreProvider store={store}>
          <Router>
            <Route path="/*" component={MailboxPage} />
          </Router>
        </StoreProvider>
      ),
      container,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unreadRequests).toEqual(["dom-alpha"]);
    setInboxUnreadCount(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unreadRequests).toEqual(["dom-alpha", "dom-alpha"]);

    dispose();
    container.remove();
  });
});

describe("MailboxPage live message events", () => {
  const detail: MessageDetailView = {
    id: "msg-1",
    threadId: "thread-1",
    direction: "INBOUND",
    subject: "Before update",
    snippet: "Original snippet",
    from: { address: "sender@example.com", name: null, kind: "ENVELOPE" },
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
    fetchStatus: "FETCHED",
    occurredAt: "2026-10-08T00:00:00.000Z",
    domain: { id: "dom-1", name: "example.com" },
    events: [],
    textBody: "Keep the original body",
    htmlBody: null,
    bodyTruncated: false,
    rfcMessageId: null,
    rawSize: 10,
    replyTo: null,
    forwardedFromMessageId: null,
    inReplyTo: null,
  };

  test("patches summary fields for the open message and preserves its body", () => {
    const summary = {
      ...detail,
      subject: "After update",
      readAt: "2026-10-08T01:00:00.000Z",
    } satisfies MessageView;
    const result = applyLiveMessageEvent(detail, {
      type: "MESSAGE_UPDATED",
      message: summary,
    });
    expect(result.active?.subject).toBe("After update");
    expect(result.active?.readAt).toBe(summary.readAt);
    expect(result.active?.textBody).toBe("Keep the original body");
    expect(result.deleted).toBe(false);
  });

  test("clears the open message and marks it deleted on MESSAGE_DELETED", () => {
    expect(
      applyLiveMessageEvent(detail, {
        type: "MESSAGE_DELETED",
        messageId: "msg-1",
      }),
    ).toEqual({ active: null, deleted: true });
  });
});
