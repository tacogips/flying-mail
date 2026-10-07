import { createAttachment } from "@flying-mail/domain/entities/attachment";
import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createMailAddress,
  MailAddressStatus,
  setMailAddressStatus,
} from "@flying-mail/domain/entities/mail-address";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  DeliveryStatus,
  MailStatus,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMailAddressId,
  createMessageId,
  createThreadId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import { BadUserInputError, NotFoundError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createSendDraftUseCase, createSaveDraftUseCase } from "./drafts";
import {
  createListSendableAddressesUseCase,
  createRetrySendUseCase,
  createSendMessageUseCase,
} from "./send";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("webmail-send-domain");

async function setup() {
  const fake = createFakeDependencies({ now: NOW });
  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: DOMAIN_ID,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "token",
        createdAt: NOW,
      }),
      NOW,
    ),
  );
  return fake;
}

function seedSource(fake: Awaited<ReturnType<typeof setup>>, id: string) {
  const source = createInboundMessage({
    id: createMessageId(id),
    domainId: DOMAIN_ID,
    threadId: createThreadId(`thread-${id}`),
    rfcMessageId: `${id}@external.test`,
    inReplyTo: null,
    references: [`ancestor-${id}@external.test`],
    subject: "Original",
    fromAddress: createEmailAddress("sender@external.test"),
    fromName: null,
    textBody: "original text",
    htmlBody: "<p>original html</p>",
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
  });
  fake.messageStores.messages.set(source.id, source);
  fake.messageStores.recipients.set(source.id, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("support@example.com"),
      name: null,
      position: 0,
    },
  ]);
  return source;
}

describe("webmail send behavior", () => {
  test("forwards readable source attachments by sharing blobs and preserving the source", async () => {
    const fake = await setup();
    const source = seedSource(fake, "forward-source");
    const original = createAttachment({
      id: createAttachmentId("source-file"),
      messageId: source.id,
      fileName: "original.pdf",
      contentType: "application/pdf",
      size: 3,
      blobKey: "att/source/original.pdf",
      contentId: "inline@external.test",
      inline: true,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(original);
    await fake.blobs.put(original.blobKey, new Uint8Array([1, 2, 3]));

    const send = createSendMessageUseCase(fake.deps);
    const sent = await send(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Fwd: Original",
      text: "Forwarded body",
      forwardedFromMessageId: source.id,
      forwardAttachmentIds: [original.id],
    });
    const copied = (
      await fake.deps.messageRepository.listAttachments([sent.id])
    ).get(sent.id)?.[0];

    expect(copied).toMatchObject({
      messageId: sent.id,
      blobKey: original.blobKey,
      inline: false,
      contentId: null,
    });
    expect(fake.messageStores.attachments.get(original.id)).toEqual(original);
    expect(fake.mailSender.sent[0]?.attachments?.[0]?.content).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("reply checks source readability and carries thread headers plus provider receipt", async () => {
    const fake = await setup();
    const source = seedSource(fake, "reply-source");
    fake.mailSender.setProviderMessageId("<provider@example.net>");
    const send = createSendMessageUseCase(fake.deps);

    await expect(
      send(
        apiKeyViewer([
          {
            capability: Capability.MailSend,
            domainId: DOMAIN_ID,
            addressPattern: "support@example.com",
          },
        ]),
        {
          from: "support@example.com",
          to: ["recipient@outside.test"],
          subject: "Re: Original",
          text: "Reply",
          inReplyToMessageId: source.id,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const sent = await send(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Re: Original",
      text: "Reply",
      inReplyToMessageId: source.id,
      replyTo: "replies@example.com",
    });
    expect(sent.inReplyTo).toBe(source.rfcMessageId);
    expect(sent.references).toEqual([
      ...source.references,
      source.rfcMessageId,
    ]);
    expect(sent.rfcMessageId).toBe("provider@example.net");
    expect(fake.mailSender.sent[0]).toMatchObject({
      replyTo: "replies@example.com",
      inReplyTo: source.rfcMessageId,
      references: sent.references,
    });
  });

  test("provider failures persist only stable address-free reasons", async () => {
    const fake = await setup();
    fake.mailSender.failNext(
      Object.assign(new Error("failed for customer@private.test"), {
        reason: "SENDER_NOT_VERIFIED",
      }),
    );
    const sent = await createSendMessageUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["customer@private.test"],
      subject: "Test",
      text: "body",
    });
    expect(sent.deliveryStatus).toBe(DeliveryStatus.Failed);
    expect(sent.deliveryError).toBe("SENDER_NOT_VERIFIED");
    expect(sent.deliveryError).not.toContain("private.test");
  });

  test("rejects an attachment bound to another message before changing its row", async () => {
    const fake = await setup();
    const source = seedSource(fake, "foreign-attachment-source");
    const attachment = createAttachment({
      id: createAttachmentId("foreign-send-file"),
      messageId: source.id,
      fileName: "foreign.txt",
      contentType: "text/plain",
      size: 2,
      blobKey: "att/foreign/foreign.txt",
      contentId: null,
      inline: false,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(attachment);

    await expect(
      createSendMessageUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["recipient@outside.test"],
        subject: "Test",
        text: "body",
        attachmentIds: [attachment.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fake.messageStores.attachments.get(attachment.id)).toEqual(
      attachment,
    );
    expect(fake.messageStores.messages.size).toBe(1);
  });

  test("rejects oversized forwarded attachments before inserting the message", async () => {
    const fake = await setup();
    const source = seedSource(fake, "oversized-forward-source");
    const attachment = createAttachment({
      id: createAttachmentId("oversized-forward-file"),
      messageId: source.id,
      fileName: "large.bin",
      contentType: "application/octet-stream",
      size: 5 * 1024 * 1024 + 1,
      blobKey: "att/oversized/large.bin",
      contentId: null,
      inline: false,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(attachment);

    await expect(
      createSendMessageUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["recipient@outside.test"],
        subject: "Forward",
        text: "body",
        forwardedFromMessageId: source.id,
        forwardAttachmentIds: [attachment.id],
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
    expect(fake.messageStores.messages.size).toBe(1);
  });

  test("refuses a disabled provisioned From address", async () => {
    const fake = await setup();
    const provisioned = createMailAddress({
      id: createMailAddressId("disabled-sender"),
      domainId: DOMAIN_ID,
      domainName: createDomainName("example.com"),
      localPart: "support",
      createdByUserId: null,
      createdAt: NOW,
    });
    await fake.deps.mailAddressRepository.save(
      setMailAddressStatus(provisioned, MailAddressStatus.Disabled, NOW),
    );

    await expect(
      createSendMessageUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["recipient@outside.test"],
        subject: "Test",
        text: "body",
      }),
    ).rejects.toMatchObject({ code: "BAD_USER_INPUT", field: "from" });
  });

  test("member sendable-address fallback uses only its own allow patterns", async () => {
    const fake = await setup();
    const viewer = memberViewer(
      "usr-send-member",
      buildMailPermissions(createUserId("usr-send-member"), [
        {
          effect: "ALLOW",
          domainId: DOMAIN_ID,
          addressPattern: "support@example.com",
        },
      ]),
    );
    const addresses = await createListSendableAddressesUseCase(fake.deps)(
      viewer,
    );
    expect(addresses).toContain("support@example.com");
    expect(addresses).not.toContain("*@example.com");
    expect(
      await createListSendableAddressesUseCase(fake.deps)(memberViewer()),
    ).toEqual([]);
  });

  test("does not retry delivery when saving the sent state fails", async () => {
    const fake = await setup();
    const save = fake.deps.messageRepository.save.bind(
      fake.deps.messageRepository,
    );
    vi.spyOn(fake.deps.messageRepository, "save").mockImplementation(
      async (message) => {
        if (message.deliveryStatus === DeliveryStatus.Sent) {
          throw new Error("transient");
        }
        return save(message);
      },
    );

    await expect(
      createSendMessageUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["recipient@outside.test"],
        subject: "Persistence failure",
        text: "body",
      }),
    ).rejects.toThrow("transient");

    expect(fake.mailSender.sent).toHaveLength(1);
    const queued = [...fake.messageStores.messages.values()][0];
    if (queued === undefined) {
      throw new Error("Expected the queued message to remain stored");
    }
    const stored = await fake.deps.messageRepository.findById(queued.id);
    expect(stored).toMatchObject({
      deliveryStatus: DeliveryStatus.Queued,
      deliveryError: null,
    });

    await expect(
      createRetrySendUseCase(fake.deps)(adminViewer(), queued.id),
    ).rejects.toBeInstanceOf(BadUserInputError);
    expect(fake.mailSender.sent).toHaveLength(1);
  });

  test("retrySend rebuilds attachments from persisted rows", async () => {
    const fake = await setup();
    const attachment = createAttachment({
      id: createAttachmentId("retry-file"),
      messageId: null,
      fileName: "retry.txt",
      contentType: "text/plain",
      size: 2,
      blobKey: "att/retry/retry.txt",
      contentId: null,
      inline: false,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(attachment);
    await fake.blobs.put(attachment.blobKey, new Uint8Array([7, 8]));
    fake.mailSender.failNext(new Error("provider unavailable"));
    const failed = await createSendMessageUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Retry",
      text: "body",
      attachmentIds: [attachment.id],
    });
    const retried = await createRetrySendUseCase(fake.deps)(
      adminViewer(),
      failed.id,
    );
    expect(retried.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(fake.mailSender.sent.at(-1)?.attachments?.[0]?.content).toEqual(
      new Uint8Array([7, 8]),
    );
  });

  test("sending a draft persists a provider receipt without angle brackets", async () => {
    const fake = await setup();
    fake.mailSender.setProviderMessageId("<draft-receipt@example.net>");
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Draft",
      text: "body",
    });
    const sent = await createSendDraftUseCase(fake.deps)(
      adminViewer(),
      draft.id,
    );
    expect(sent.status).toBe(MailStatus.Sent);
    expect(sent.rfcMessageId).toBe("draft-receipt@example.net");
  });
});
