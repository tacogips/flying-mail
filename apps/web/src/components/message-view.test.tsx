import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessageDetailView } from "../api/schema-types";
import { clearContactLookupCache } from "../lib/contact-lookup";
import { MessageView } from "./message-view";

function message(
  overrides: Partial<MessageDetailView> = {},
): MessageDetailView {
  return {
    id: "msg-1",
    threadId: "thread-1",
    direction: "INBOUND",
    subject: "Hello",
    snippet: "Hi there",
    from: {
      address: "ada@example.com",
      name: "Ada Lovelace",
      kind: "ENVELOPE",
    },
    recipients: [{ address: "me@example.com", name: null, kind: "TO" }],
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
    occurredAt: "2026-08-24T00:00:00.000Z",
    domain: { id: "dom-1", name: "example.com" },
    events: [],
    textBody: "Hi there",
    htmlBody: null,
    bodyTruncated: false,
    rfcMessageId: null,
    rawSize: 100,
    replyTo: null,
    forwardedFromMessageId: null,
    inReplyTo: null,
    ...overrides,
  };
}

const NOOP = () => undefined;

function mount(detail: MessageDetailView): {
  readonly container: HTMLElement;
  readonly dispose: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <MessageView
        message={detail}
        onBack={NOOP}
        onReply={NOOP}
        onForward={NOOP}
        onNotSpam={NOOP}
        onMarkSpam={NOOP}
        onMarkUnread={NOOP}
        onDelete={NOOP}
        onToggleStar={NOOP}
        onToggleArchive={NOOP}
      />
    ),
    container,
  );
  return {
    container,
    dispose: () => {
      dispose();
      container.remove();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  // The lookup hook resolves through several chained promises (the fetch,
  // its `.json()`, the cache-population `.then`, Solid's own scheduler),
  // so a macrotask tick is the reliable way to wait for the resulting
  // signal write to land, rather than guessing a microtask count.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function stubGraphQL(contactsByEmail: readonly unknown[]): void {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ data: { contactsByEmail } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
  clearContactLookupCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MessageView contact lookup hook", () => {
  test("renders the sender and recipients synchronously, before the lookup resolves", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(message());
    // No `await` yet: the initial paint must already show the message, so
    // the lookup cannot be on the critical render path.
    expect(
      container.querySelector(".message-view-sender-col strong")?.textContent,
    ).toContain("Ada Lovelace");
    expect(container.textContent).toContain("Hi there");
    dispose();
  });

  test("no match renders identically to the pre-contacts markup", async () => {
    stubGraphQL([]);
    const { container, dispose } = mount(message());
    await flushMicrotasks();

    expect(container.querySelector(".message-view-contact-hint")).toBeNull();
    expect(container.querySelector(".message-view-contact-hints")).toBeNull();
    expect(
      container.querySelector(".message-view-sender-col strong")?.textContent,
    ).toBe("Ada Lovelace <ada@example.com>");
    dispose();
  });

  test("a matching sender gets a name hint linking to /contacts", async () => {
    stubGraphQL([
      {
        id: "contact-1",
        addressBook: {
          id: "book-1",
          name: "Contacts",
          mailAddress: { id: "addr-1", address: "me@example.com" },
        },
        uid: "contact-1@mailcal",
        displayName: "Ada L.",
        givenName: null,
        familyName: null,
        nickname: null,
        organization: null,
        title: null,
        emails: [{ address: "ada@example.com", label: null }],
        phones: [],
        postalAddresses: [],
        urls: [],
        note: null,
        birthday: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      },
    ]);
    const { container, dispose } = mount(message());
    await flushMicrotasks();

    const hint = container.querySelector<HTMLAnchorElement>(
      ".message-view-contact-hint",
    );
    expect(hint?.textContent).toBe("(Ada L.)");
    expect(hint?.getAttribute("href")).toBe("/contacts?contactId=contact-1");
    dispose();
  });
});

describe("MessageView recipient headers", () => {
  test("shows deduplicated To and Cc headers and only missing envelope recipients", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        recipients: [
          { address: "taco@example.com", name: null, kind: "TO" },
          { address: "TACO@example.com", name: null, kind: "TO" },
          { address: "team@example.com", name: null, kind: "CC" },
          { address: "taco@example.com", name: null, kind: "ENVELOPE" },
          { address: "delivered@example.com", name: null, kind: "ENVELOPE" },
          { address: "hidden@example.com", name: null, kind: "BCC" },
        ],
      }),
    );

    const headers = container.querySelector(
      ".message-view-recipients",
    )?.textContent;
    expect(headers).toContain("To: taco@example.com");
    expect(headers).toContain("Cc: team@example.com");
    expect(headers).toContain(
      "Delivered to: taco@example.com, delivered@example.com",
    );
    expect(headers).not.toContain("hidden@example.com");
    expect(headers).not.toContain("TACO@example.com");
    dispose();
  });

  test("omits Delivered to when envelope recipients are already in To and Cc", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        recipients: [
          { address: "to@example.com", name: null, kind: "TO" },
          { address: "cc@example.com", name: null, kind: "CC" },
          { address: "to@example.com", name: null, kind: "ENVELOPE" },
          { address: "cc@example.com", name: null, kind: "ENVELOPE" },
        ],
      }),
    );

    expect(container.querySelector(".message-view-delivered-to")).toBeNull();
    dispose();
  });

  test("deduplicates addresses across To and Cc while keeping the first header kind", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        recipients: [
          { address: "shared@example.com", name: null, kind: "TO" },
          { address: "other@example.com", name: null, kind: "CC" },
          { address: "SHARED@example.com", name: null, kind: "CC" },
        ],
      }),
    );

    const headers = container.querySelector(
      ".message-view-recipients",
    )?.textContent;
    expect(headers).toContain("To: shared@example.com");
    expect(headers).toContain("Cc: other@example.com");
    expect(headers).not.toContain("Cc: other@example.com, SHARED@example.com");
    dispose();
  });

  test("shows Bcc recipients only for outbound messages", () => {
    stubGraphQL([]);
    const outbound = mount(
      message({
        direction: "OUTBOUND",
        recipients: [
          { address: "to@example.com", name: null, kind: "TO" },
          { address: "blind@example.com", name: null, kind: "BCC" },
        ],
      }),
    );
    expect(outbound.container.textContent).toContain("Bcc: blind@example.com");
    outbound.dispose();

    const inbound = mount(
      message({
        recipients: [
          { address: "to@example.com", name: null, kind: "TO" },
          { address: "blind@example.com", name: null, kind: "BCC" },
        ],
      }),
    );
    expect(inbound.container.textContent).not.toContain("blind@example.com");
    inbound.dispose();
  });
});

describe("MessageView attachment tiles", () => {
  test("hides referenced inline images and keeps other attachments", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        htmlBody: '<p><img src="cid:img1"></p>',
        attachments: [
          {
            id: "inline-used",
            fileName: "used.png",
            contentType: "image/png",
            size: 12,
            inline: true,
            kind: "IMAGE",
            contentId: "<img1>",
            url: "/api/attachments/inline-used",
          },
          {
            id: "inline-unused",
            fileName: "unused.png",
            contentType: "image/png",
            size: 13,
            inline: true,
            kind: "IMAGE",
            contentId: "img2",
            url: "/api/attachments/inline-unused",
          },
          {
            id: "ordinary",
            fileName: "notes.txt",
            contentType: "text/plain",
            size: 14,
            inline: false,
            kind: "TEXT",
            contentId: null,
            url: "/api/attachments/ordinary",
          },
        ],
      }),
    );

    const tiles = [...container.querySelectorAll(".attachment-tile")];
    expect(tiles).toHaveLength(2);
    expect(
      tiles.map((tile) => tile.querySelector(".attachment-name")?.textContent),
    ).toEqual(["unused.png", "notes.txt"]);
    dispose();
  });
  test("keeps referenced inline images over 5 MiB visible as tiles", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        htmlBody: '<p style="background-image: url(cid:large1)">Image</p>',
        attachments: [
          {
            id: "inline-large",
            fileName: "large.png",
            contentType: "image/png",
            size: 5 * 1024 * 1024 + 1,
            inline: true,
            kind: "IMAGE",
            contentId: "large1",
            url: "/api/attachments/inline-large",
          },
        ],
      }),
    );

    expect(container.querySelectorAll(".attachment-tile")).toHaveLength(1);
    expect(container.textContent).toContain("large.png");
    dispose();
  });

  test("matches CSS cid URLs without including their closing parenthesis", () => {
    stubGraphQL([]);
    const { container, dispose } = mount(
      message({
        htmlBody: '<p style="background-image: url(cid:css-image)">Image</p>',
        attachments: [
          {
            id: "css-image",
            fileName: "css-image.png",
            contentType: "image/png",
            size: 32,
            inline: true,
            kind: "IMAGE",
            contentId: "css-image",
            url: "/api/attachments/css-image",
          },
        ],
      }),
    );

    expect(container.querySelectorAll(".attachment-tile")).toHaveLength(0);
    dispose();
  });
});
