import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createOutboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import type { BuildMimeInput } from "../ports/mime";
import { createFakeDependencies } from "../test-support/fakes";
import { describe, expect, test } from "vitest";
import { assembleOutbound } from "./outbound-assembly";

const NOW = "2026-08-23T00:00:00.000Z";

describe("assembleOutbound", () => {
  test("builds MIME and provider envelope with threading and inline attachments", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const messageId = createMessageId("outbound-1");
    const message = createOutboundMessage({
      id: messageId,
      domainId: createDomainId("domain-1"),
      threadId: createThreadId("thread-1"),
      rfcMessageId: "outbound-1@example.com",
      inReplyTo: "parent@example.com",
      replyTo: createEmailAddress("reply@example.com"),
      references: ["ancestor@example.com", "parent@example.com"],
      subject: "A reply",
      fromAddress: createEmailAddress("sender@example.com"),
      fromName: "Sender",
      textBody: "Plain body",
      htmlBody: "<p>HTML body</p>",
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
    });
    const attachment = createAttachment({
      id: createAttachmentId("inline-image"),
      messageId,
      fileName: "image.png",
      contentType: "image/png",
      size: 4,
      blobKey: "att/inline-image/image.png",
      contentId: "logo@example.com",
      inline: true,
      createdAt: NOW,
    });
    const recipients = [
      {
        kind: RecipientKind.To,
        address: createEmailAddress("to@example.net"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.Cc,
        address: createEmailAddress("cc@example.net"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.Bcc,
        address: createEmailAddress("bcc@example.net"),
        name: null,
        position: 0,
      },
    ];
    fake.messageStores.messages.set(messageId, message);
    fake.messageStores.recipients.set(messageId, recipients);
    fake.messageStores.attachments.set(attachment.id, attachment);
    await fake.blobs.put(attachment.blobKey, new Uint8Array([1, 2, 3, 4]), {
      contentType: attachment.contentType,
    });

    let mimeInput: BuildMimeInput | undefined;
    const deps = {
      ...fake.deps,
      mimeBuilder: {
        build(input: BuildMimeInput): string {
          mimeInput = input;
          return "From: sender@example.com\r\nTo: to@example.net\r\n";
        },
      },
    };
    const customHeaders = new Map([["X-Trace", "trace-1"]]);
    const { mail, raw } = await assembleOutbound(deps, message, {
      customHeaders,
    });

    expect(mimeInput).toBeDefined();
    expect(mimeInput?.to.map(({ address }) => address)).toEqual([
      "to@example.net",
    ]);
    expect(mimeInput?.cc?.map(({ address }) => address)).toEqual([
      "cc@example.net",
    ]);
    expect(mimeInput).not.toHaveProperty("bcc");
    expect(mimeInput?.replyTo?.address).toBe("reply@example.com");
    expect(mimeInput?.messageId).toBe("outbound-1@example.com");
    expect(mimeInput?.inReplyTo).toBe("parent@example.com");
    expect(mimeInput?.references).toEqual([
      "ancestor@example.com",
      "parent@example.com",
    ]);
    expect(mimeInput?.headers).toBe(customHeaders);
    expect(mimeInput?.attachments?.[0]).toMatchObject({
      contentId: "logo@example.com",
      inline: true,
      content: new Uint8Array([1, 2, 3, 4]),
    });
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(mail).toMatchObject({
      from: "sender@example.com",
      to: ["to@example.net"],
      cc: ["cc@example.net"],
      bcc: ["bcc@example.net"],
      replyTo: "reply@example.com",
      messageId: "outbound-1@example.com",
      inReplyTo: "parent@example.com",
      references: ["ancestor@example.com", "parent@example.com"],
      headers: customHeaders,
      raw,
    });
    expect(mail.attachments?.[0]).toMatchObject({
      contentId: "logo@example.com",
      inline: true,
      content: new Uint8Array([1, 2, 3, 4]),
    });
  });
});
