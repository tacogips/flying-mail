import { describe, expect, test } from "vitest";
import { InvalidStateTransitionError, ValidationError } from "../errors";
import { createEmailAddress } from "../value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "../value-objects/ids";
import {
  buildSnippet,
  createInboundMessage,
  createOutboundMessage,
  DeliveryStatus,
  htmlToPlainText,
  isMessageRead,
  markMessageFailed,
  markMessageRead,
  markMessageSent,
  MessageDirection,
  requeueMessage,
  SNIPPET_LENGTH,
} from "./message";

const common = {
  id: createMessageId("msg-1"),
  domainId: createDomainId("dom-1"),
  threadId: createThreadId("thr-1"),
  rfcMessageId: "abc@example.com",
  inReplyTo: null,
  references: [] as readonly string[],
  subject: "Hello",
  fromAddress: createEmailAddress("sender@example.com"),
  fromName: "Sender",
  textBody: "Body text",
  htmlBody: null,
  rawKey: "raw/msg-1.eml",
  rawSize: 512,
  occurredAt: "2026-08-23T00:00:00.000Z",
  createdAt: "2026-08-23T00:00:00.000Z",
};

describe("createInboundMessage", () => {
  test("is always RECEIVED and INBOUND", () => {
    const message = createInboundMessage({ ...common, spamScore: 0.1 });
    expect(message.direction).toBe(MessageDirection.Inbound);
    expect(message.deliveryStatus).toBe(DeliveryStatus.Received);
    expect(message.spamScore).toBe(0.1);
    expect(message.readAt).toBeNull();
    expect(message.snippet).toBe("Body text");
  });

  test("copies the references array rather than aliasing it", () => {
    const references = ["a@x.com"];
    const message = createInboundMessage({
      ...common,
      references,
      spamScore: null,
    });
    references.push("b@x.com");
    expect(message.references).toEqual(["a@x.com"]);
  });

  test.each([
    ["below zero", -0.1],
    ["above one", 1.1],
    ["NaN", Number.NaN],
  ])("rejects a spam score %s", (_name, spamScore) => {
    expect(() => createInboundMessage({ ...common, spamScore })).toThrow(
      ValidationError,
    );
  });

  test("rejects a negative raw size", () => {
    expect(() =>
      createInboundMessage({ ...common, rawSize: -1, spamScore: null }),
    ).toThrow(ValidationError);
  });
});

describe("createOutboundMessage", () => {
  test("is always QUEUED and OUTBOUND with no spam score", () => {
    const message = createOutboundMessage(common);
    expect(message.direction).toBe(MessageDirection.Outbound);
    expect(message.deliveryStatus).toBe(DeliveryStatus.Queued);
    expect(message.spamScore).toBeNull();
  });
});

describe("delivery transitions", () => {
  test("QUEUED -> SENT updates occurredAt", () => {
    const sent = markMessageSent(
      createOutboundMessage(common),
      "2026-08-23T01:00:00.000Z",
    );
    expect(sent.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(sent.occurredAt).toBe("2026-08-23T01:00:00.000Z");
    expect(sent.deliveryError).toBeNull();
  });

  test("QUEUED -> FAILED records the error", () => {
    const failed = markMessageFailed(
      createOutboundMessage(common),
      "Email delivery is unavailable",
      "2026-08-23T01:00:00.000Z",
    );
    expect(failed.deliveryStatus).toBe(DeliveryStatus.Failed);
    expect(failed.deliveryError).toBe("Email delivery is unavailable");
  });

  test("a sent message cannot be sent again", () => {
    const sent = markMessageSent(
      createOutboundMessage(common),
      "2026-08-23T01:00:00.000Z",
    );
    expect(() => markMessageSent(sent, "2026-08-23T02:00:00.000Z")).toThrow(
      InvalidStateTransitionError,
    );
  });

  test("an inbound message cannot be marked sent", () => {
    const inbound = createInboundMessage({ ...common, spamScore: null });
    expect(() => markMessageSent(inbound, "2026-08-23T01:00:00.000Z")).toThrow(
      InvalidStateTransitionError,
    );
  });

  test("only a failed message can be re-queued", () => {
    const failed = markMessageFailed(
      createOutboundMessage(common),
      "boom",
      "2026-08-23T01:00:00.000Z",
    );
    const requeued = requeueMessage(failed, "2026-08-23T02:00:00.000Z");
    expect(requeued.deliveryStatus).toBe(DeliveryStatus.Queued);
    expect(requeued.deliveryError).toBeNull();

    const sent = markMessageSent(requeued, "2026-08-23T03:00:00.000Z");
    expect(() => requeueMessage(sent, "2026-08-23T04:00:00.000Z")).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe("read state", () => {
  test("round-trips", () => {
    const message = createInboundMessage({ ...common, spamScore: null });
    expect(isMessageRead(message)).toBe(false);
    const read = markMessageRead(
      message,
      "2026-08-23T01:00:00.000Z",
      "2026-08-23T01:00:00.000Z",
    );
    expect(isMessageRead(read)).toBe(true);
    const unread = markMessageRead(read, null, "2026-08-23T02:00:00.000Z");
    expect(isMessageRead(unread)).toBe(false);
  });
});

describe("htmlToPlainText", () => {
  test("drops script and style content entirely", () => {
    expect(
      htmlToPlainText(
        "<style>p{color:red}</style><p>Hi</p><script>x()</script>",
      ),
    ).toContain("Hi");
    expect(htmlToPlainText("<script>alert(1)</script>")).not.toContain("alert");
  });

  test("decodes common and numeric entities", () => {
    expect(htmlToPlainText("<p>a&nbsp;&amp;&#65;&#x42;</p>").trim()).toBe(
      "a &AB",
    );
  });
});

describe("buildSnippet", () => {
  test("prefers the text body", () => {
    expect(buildSnippet("  plain   text  ", "<p>html</p>")).toBe("plain text");
  });

  test("falls back to the html body", () => {
    expect(buildSnippet(null, "<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  test("falls back to html when the text body is blank", () => {
    expect(buildSnippet("   ", "<p>Only html</p>")).toBe("Only html");
  });

  test("returns an empty string when both bodies are absent", () => {
    expect(buildSnippet(null, null)).toBe("");
  });

  test("truncates to the snippet length", () => {
    expect(buildSnippet("x".repeat(500), null)).toHaveLength(SNIPPET_LENGTH);
  });
});
