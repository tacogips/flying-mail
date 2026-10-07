import {
  AttachmentKind,
  createAttachment,
  type Attachment,
} from "@flying-mail/domain/entities/attachment";
import {
  createInboundMessage,
  createOutboundMessage,
  MessageDirection,
  type Message,
  type MessageRecipient,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { computeComposePrefill, type PrefillSource } from "./compose-prefill";

const NOW = "2026-08-23T01:02:00.000Z";
const DOMAIN_ID = createDomainId("dom-compose");

function makeMessage(
  overrides: Partial<Parameters<typeof createInboundMessage>[0]> = {},
): Message {
  return createInboundMessage({
    id: createMessageId("msg-compose"),
    domainId: DOMAIN_ID,
    threadId: createThreadId("thread-compose"),
    rfcMessageId: "source@example.net",
    inReplyTo: null,
    references: [],
    subject: "Hello",
    fromAddress: createEmailAddress("x@ext.example"),
    fromName: "X Sender",
    textBody: "first\nsecond",
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
    ...overrides,
  });
}

function recipient(
  kind: RecipientKind,
  address: string,
  position: number,
  name: string | null = null,
): MessageRecipient {
  return { kind, address: createEmailAddress(address), name, position };
}

function attachment(id: string, inline = false): Attachment {
  return createAttachment({
    id: createAttachmentId(id),
    messageId: createMessageId("msg-compose"),
    fileName: `${id}.png`,
    contentType: "image/png",
    size: 10,
    blobKey: `att/${id}`,
    contentId: inline ? `${id}@example.net` : null,
    inline,
    createdAt: NOW,
    kind: AttachmentKind.Image,
  });
}

function source(
  message: Message,
  recipients: readonly MessageRecipient[],
  attachments: readonly Attachment[] = [],
): PrefillSource {
  return { message, recipients, attachments };
}

describe("computeComposePrefill", () => {
  const inboundRecipients = [
    recipient(RecipientKind.Envelope, "me@t.example", 0),
    recipient(RecipientKind.To, "me@t.example", 0),
    recipient(RecipientKind.To, "y@ext.example", 1),
    recipient(RecipientKind.Cc, "z@ext.example", 0),
    recipient(RecipientKind.Bcc, "hidden@ext.example", 0),
  ];

  test("prefills inbound reply and reply-all without BCC or envelope recipients", () => {
    const input = source(makeMessage(), inboundRecipients);
    expect(
      computeComposePrefill(input, "REPLY", ["me@t.example"]),
    ).toMatchObject({
      from: "me@t.example",
      to: ["x@ext.example"],
      cc: [],
    });
    expect(
      computeComposePrefill(input, "REPLY_ALL", ["me@t.example"]),
    ).toMatchObject({
      from: "me@t.example",
      to: ["x@ext.example"],
      cc: ["y@ext.example", "z@ext.example"],
    });
  });

  test("does not treat a bare wildcard as every recipient being own", () => {
    const prefill = computeComposePrefill(
      source(makeMessage(), inboundRecipients),
      "REPLY_ALL",
      ["*"],
    );
    expect(prefill.to).toEqual(["x@ext.example"]);
    expect(prefill.cc).toEqual(
      expect.arrayContaining(["y@ext.example", "z@ext.example"]),
    );
    expect([...prefill.to, ...prefill.cc]).not.toContain("hidden@ext.example");
  });

  test("uses Reply-To and falls back to the sender if reply-all excludes all To addresses", () => {
    const withReplyTo = makeMessage({
      replyTo: createEmailAddress("r@ext.example"),
    });
    expect(
      computeComposePrefill(source(withReplyTo, inboundRecipients), "REPLY", [
        "me@t.example",
      ]).to,
    ).toEqual(["r@ext.example"]);

    const ownOnly = [recipient(RecipientKind.To, "me@t.example", 0)];
    expect(
      computeComposePrefill(source(makeMessage(), ownOnly), "REPLY_ALL", [
        "*@t.example",
      ]).to,
    ).toEqual(["x@ext.example"]);
  });

  test("matches own addresses through wildcard patterns and removes them from reply-all Cc", () => {
    const recipients = [
      recipient(RecipientKind.Envelope, "me@t.example", 0),
      recipient(RecipientKind.To, "me@t.example", 0),
      recipient(RecipientKind.To, "other@t.example", 1),
      recipient(RecipientKind.Cc, "OTHER@T.EXAMPLE", 0),
      recipient(RecipientKind.Cc, "friend@ext.example", 1),
    ];
    const prefill = computeComposePrefill(
      source(makeMessage(), recipients),
      "REPLY_ALL",
      ["*@T.EXAMPLE"],
    );
    expect(prefill.from).toBe("me@t.example");
    expect(prefill.cc).toEqual(["friend@ext.example"]);
  });

  test("uses outbound From and recipients for reply-all", () => {
    const message = createOutboundMessage({
      id: createMessageId("outbound-compose"),
      domainId: DOMAIN_ID,
      threadId: createThreadId("thread-outbound"),
      rfcMessageId: "outbound@example.net",
      inReplyTo: null,
      references: [],
      subject: "Re: Hello",
      fromAddress: createEmailAddress("me@t.example"),
      fromName: null,
      textBody: "sent",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
    });
    const prefill = computeComposePrefill(
      source(message, [
        recipient(RecipientKind.To, "a@ext.example", 0),
        recipient(RecipientKind.Cc, "b@ext.example", 0),
      ]),
      "REPLY_ALL",
      ["me@t.example"],
    );
    expect(prefill).toMatchObject({
      from: "me@t.example",
      to: ["a@ext.example"],
      cc: ["b@ext.example"],
      subject: "Re: Hello",
    });
    expect(message.direction).toBe(MessageDirection.Outbound);
  });

  test("deduplicates case-insensitive addresses and does not stack subject prefixes", () => {
    const message = makeMessage({ subject: "Hello" });
    const recipients = [
      recipient(RecipientKind.To, "same@ext.example", 0),
      recipient(RecipientKind.To, "SAME@EXT.EXAMPLE", 1),
    ];
    expect(
      computeComposePrefill(source(message, recipients), "REPLY_ALL", []).cc,
    ).toEqual(["same@ext.example"]);
    expect(
      computeComposePrefill(source(message, []), "REPLY", []).subject,
    ).toBe("Re: Hello");
    expect(
      computeComposePrefill(source(message, []), "FORWARD", []).subject,
    ).toBe("Fwd: Hello");
  });

  test("forwards all source attachments and quotes the message headers", () => {
    const files = [attachment("file-1"), attachment("inline-1", true)];
    const prefill = computeComposePrefill(
      source(makeMessage(), inboundRecipients, files),
      "FORWARD",
      ["me@t.example"],
    );
    expect(prefill.forwardedFromMessageId).toBe(createMessageId("msg-compose"));
    expect(prefill.forwardAttachments).toEqual(files);
    expect(prefill.to).toEqual([]);
    expect(prefill.cc).toEqual([]);
    expect(prefill.quotedText).toContain(
      "---------- Forwarded message ----------",
    );
    expect(prefill.quotedText).toContain("To: me@t.example, y@ext.example");
    expect(prefill.quotedText).not.toContain("hidden@ext.example");
  });

  test("quotes HTML without rewriting it and escapes generated attribution and headers", () => {
    const message = makeMessage({
      fromName: "<script>&'\"",
      htmlBody: "<b>x</b>",
    });
    const reply = computeComposePrefill(source(message, []), "REPLY", []);
    expect(reply.quotedHtml).toContain(
      '<blockquote type="cite"><b>x</b></blockquote>',
    );
    expect(reply.quotedHtml).toContain("&lt;script&gt;&amp;&#39;&quot;");

    const forward = computeComposePrefill(source(message, []), "FORWARD", []);
    expect(forward.quotedHtml).toContain(
      "<div>---------- Forwarded message ----------</div>",
    );
    expect(forward.quotedHtml).toContain("<div>From: &lt;script&gt;");
    expect(forward.quotedHtml).toContain("<b>x</b>");
    expect(forward.quotedHtml).not.toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("returns null HTML quote and null From without an own address", () => {
    const prefill = computeComposePrefill(
      source(makeMessage(), []),
      "REPLY",
      [],
    );
    expect(prefill.quotedHtml).toBeNull();
    expect(prefill.from).toBeNull();
  });
});
