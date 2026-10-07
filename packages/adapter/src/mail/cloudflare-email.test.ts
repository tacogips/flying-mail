import type { OutboundMail } from "@flying-mail/application/ports/mail-sender";
import { describe, expect, test } from "vitest";
import {
  type CloudflareEmailMessage,
  type CloudflareEmailSendResult,
  type CloudflareSendEmailBinding,
  createCloudflareMailSender,
  createUnavailableMailSender,
  InvalidSenderAddressError,
  MailDeliveryError,
  parseCloudflareSenderAddress,
} from "./cloudflare-email";

function recordingBinding(options?: {
  failOn?: string;
  failWith?: unknown;
  result?: CloudflareEmailSendResult | undefined;
}): {
  binding: CloudflareSendEmailBinding;
  sent: CloudflareEmailMessage[];
} {
  const sent: CloudflareEmailMessage[] = [];
  return {
    sent,
    binding: {
      async send(message) {
        sent.push(message);
        if (
          options?.failOn !== undefined &&
          [
            ...(message.to ?? []),
            ...(message.cc ?? []),
            ...(message.bcc ?? []),
          ].includes(options.failOn)
        ) {
          throw (
            options.failWith ?? new Error(`provider rejected ${options.failOn}`)
          );
        }
        if (options?.failWith !== undefined) {
          throw options.failWith;
        }
        return options?.result;
      },
    },
  };
}

const from = parseCloudflareSenderAddress("noreply@example.com");
if (from === null) {
  throw new Error("fixture sender address must be valid");
}

const mail: OutboundMail = {
  from: "noreply@example.com",
  to: ["a@other.com", "b@other.com"],
  cc: ["c@other.com"],
  subject: "Hello",
  text: "Body",
};

describe("parseCloudflareSenderAddress", () => {
  test.each([
    ["noreply@example.com", "noreply@example.com"],
    ["NoReply@Example.COM", "noreply@example.com"],
    ["a.b+c@mail.example.co.jp", "a.b+c@mail.example.co.jp"],
  ])("accepts %j", (input, expected) => {
    expect(parseCloudflareSenderAddress(input)).toBe(expected);
  });

  test.each([
    ["a display name form", "Name <a@example.com>"],
    ["no at sign", "nobody"],
    ["two at signs", "a@b@example.com"],
    ["a single-label domain", "a@localhost"],
    ["leading whitespace", " a@example.com"],
    ["a double dot", "a..b@example.com"],
    ["an empty local part", "@example.com"],
  ])("rejects %s", (_label, input) => {
    expect(parseCloudflareSenderAddress(input)).toBeNull();
  });
});

describe("createCloudflareMailSender", () => {
  test("sends all recipient classes in one binding call", async () => {
    const { binding, sent } = recordingBinding();
    await createCloudflareMailSender(binding).send({
      ...mail,
      bcc: ["d@other.com"],
      replyTo: "reply@example.com",
      inReplyTo: "parent@example.com",
      references: ["root@example.com", "parent@example.com"],
      messageId: "own@example.com",
      headers: new Map([
        ["message-id", "<spoofed@example.com>"],
        ["Bcc", "hidden@example.com"],
        ["X-Campaign-Id", "abc"],
      ]),
      attachments: [
        {
          fileName: "logo.png",
          contentType: "image/png",
          content: new Uint8Array([1, 2]),
          inline: true,
          contentId: "logo-1",
        },
        {
          fileName: "doc.txt",
          contentType: "text/plain",
          content: new Uint8Array([3]),
          inline: false,
          contentId: "ignored",
        },
      ],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["a@other.com", "b@other.com"],
      cc: ["c@other.com"],
      bcc: ["d@other.com"],
      replyTo: "reply@example.com",
      headers: {
        "X-Campaign-Id": "abc",
        "In-Reply-To": "<parent@example.com>",
        References: "<root@example.com> <parent@example.com>",
      },
      attachments: [
        { disposition: "inline", contentId: "logo-1" },
        { disposition: "attachment" },
      ],
    });
    expect(Object.keys(sent[0]?.headers ?? {})).not.toContain("Message-ID");
    expect(Object.keys(sent[0]?.headers ?? {})).not.toContain("Bcc");
  });

  test("sends as the message's own from, not one configured address", async () => {
    // flying-mail is a multi-address, multi-domain server. The sender is decided
    // by the send use case from the caller's authorized mailbox -- it has
    // already checked the managed domain and the per-address MAIL_SEND
    // scope -- so the adapter must carry it through rather than override it.
    // Overriding made the stored message and the delivered message disagree
    // about who sent it.
    const { binding, sent } = recordingBinding();
    const sender = createCloudflareMailSender(binding);
    await sender.send({
      ...mail,
      from: "support@example.com",
      to: ["a@other.com"],
      cc: [],
    });
    await sender.send({
      ...mail,
      from: "billing@other-domain.test",
      to: ["a@other.com"],
      cc: [],
    });

    expect(sent.map((message) => message.from)).toEqual([
      "support@example.com",
      "billing@other-domain.test",
    ]);
  });

  test("normalizes the sender's case", async () => {
    const { binding, sent } = recordingBinding();
    await createCloudflareMailSender(binding).send({
      ...mail,
      from: "Support@Example.COM",
      to: ["a@other.com"],
      cc: [],
    });
    expect(sent[0]?.from).toBe("support@example.com");
  });

  test("refuses a from the binding could never accept, before sending anything", async () => {
    const { binding, sent } = recordingBinding();
    await expect(
      createCloudflareMailSender(binding).send({
        ...mail,
        from: "Name <a@example.com>",
      }),
    ).rejects.toBeInstanceOf(InvalidSenderAddressError);
    expect(sent).toEqual([]);
  });

  test("passes custom headers through", async () => {
    const { binding, sent } = recordingBinding();
    await createCloudflareMailSender(binding).send({
      ...mail,
      to: ["a@other.com"],
      cc: [],
      headers: new Map([["X-Campaign-Id", "abc"]]),
    });
    expect(sent[0]?.headers).toEqual({ "X-Campaign-Id": "abc" });
  });

  test("maps and masks provider errors, leaking no recipient or subject", async () => {
    const { binding } = recordingBinding({
      failWith: Object.assign(new Error("E_SENDER_NOT_VERIFIED: b@other.com"), {
        code: "E_SENDER_NOT_VERIFIED",
      }),
    });
    const sender = createCloudflareMailSender(binding);

    await expect(sender.send(mail)).rejects.toBeInstanceOf(MailDeliveryError);
    try {
      await sender.send(mail);
    } catch (error) {
      const message = (error as Error).message;
      expect((error as MailDeliveryError).reason).toBe("SENDER_NOT_VERIFIED");
      expect(message).toBe("Email delivery is unavailable");
      expect(message).not.toContain("b@other.com");
      expect(message).not.toContain("Hello");
    }
  });

  test("returns a provider receipt and accepts an absent result", async () => {
    const withReceipt = recordingBinding({
      result: { messageId: "<provider@cf>" },
    });
    await expect(
      createCloudflareMailSender(withReceipt.binding).send(mail),
    ).resolves.toEqual({
      providerMessageId: "<provider@cf>",
    });
    const withoutReceipt = recordingBinding();
    await expect(
      createCloudflareMailSender(withoutReceipt.binding).send(mail),
    ).resolves.toEqual({
      providerMessageId: null,
    });
  });
});

describe("createUnavailableMailSender", () => {
  test("always fails with the same masked error", async () => {
    await expect(
      createUnavailableMailSender().send(mail),
    ).rejects.toBeInstanceOf(MailDeliveryError);
  });
});
