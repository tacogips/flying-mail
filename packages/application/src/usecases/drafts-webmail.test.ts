import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  MailStatus,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import { ConflictError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_A = createDomainId("draft-domain-a");
const DOMAIN_B = createDomainId("draft-domain-b");

async function setup() {
  const fake = createFakeDependencies({ now: NOW });
  for (const [id, name] of [
    [DOMAIN_A, "example.com"],
    [DOMAIN_B, "second.example"],
  ] as const) {
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id,
          name: createDomainName(name),
          catchAll: true,
          verificationToken: `token-${name}`,
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  }
  return fake;
}

function seedReplySource(fake: Awaited<ReturnType<typeof setup>>) {
  const source = createInboundMessage({
    id: createMessageId("draft-reply-source"),
    domainId: DOMAIN_A,
    threadId: createThreadId("draft-reply-thread"),
    rfcMessageId: "parent@example.net",
    inReplyTo: null,
    references: ["ancestor@example.net"],
    subject: "Parent",
    fromAddress: createEmailAddress("sender@example.net"),
    fromName: null,
    textBody: "parent body",
    htmlBody: null,
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

async function seedForwardSource(fake: Awaited<ReturnType<typeof setup>>) {
  const source = createInboundMessage({
    id: createMessageId("draft-forward-source"),
    domainId: DOMAIN_A,
    threadId: createThreadId("draft-forward-thread"),
    rfcMessageId: "forward-source@example.net",
    inReplyTo: null,
    references: [],
    subject: "Forward source",
    fromAddress: createEmailAddress("sender@example.net"),
    fromName: null,
    textBody: "source body",
    htmlBody: null,
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
  const attachment = createAttachment({
    id: createAttachmentId("draft-forward-attachment"),
    messageId: source.id,
    fileName: "forwarded.txt",
    contentType: "text/plain",
    size: 3,
    blobKey: "att/draft-forward/forwarded.txt",
    contentId: null,
    inline: false,
    createdAt: NOW,
  });
  await fake.deps.messageRepository.saveAttachment(attachment);
  await fake.blobs.put(attachment.blobKey, new Uint8Array([4, 5, 6]));
  return { source, attachment };
}

describe("webmail drafts", () => {
  test("replaces removed attachments and deletes a blob only after its last reference", async () => {
    const fake = await setup();
    const first = createAttachment({
      id: createAttachmentId("draft-file-one"),
      messageId: null,
      fileName: "one.txt",
      contentType: "text/plain",
      size: 2,
      blobKey: "att/shared/one.txt",
      contentId: null,
      inline: false,
      createdAt: NOW,
    });
    const second = createAttachment({
      ...first,
      id: createAttachmentId("draft-file-two"),
      fileName: "two.txt",
    });
    await fake.deps.messageRepository.saveAttachment(first);
    await fake.deps.messageRepository.saveAttachment(second);
    await fake.blobs.put(first.blobKey, new Uint8Array([1, 2]));
    const save = createSaveDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      text: "body",
      attachmentIds: [first.id],
    });
    await save(adminViewer(), {
      draftId: draft.id,
      from: "support@example.com",
      text: "body",
      attachmentIds: [second.id],
    });

    const remaining = (
      await fake.deps.messageRepository.listAttachments([draft.id])
    ).get(draft.id);
    expect(remaining?.map(({ id }) => id)).toEqual([second.id]);
    expect(fake.blobs.keys()).toContain(first.blobKey);
  });

  test("updates sender domain and keeps omitted reply linkage", async () => {
    const fake = await setup();
    const source = seedReplySource(fake);
    const save = createSaveDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      to: ["sender@example.net"],
      subject: "Re: Parent",
      text: "reply",
      inReplyToMessageId: source.id,
    });
    const updated = await save(adminViewer(), {
      draftId: draft.id,
      from: "other@second.example",
      to: ["sender@example.net"],
      subject: "Re: Parent updated",
      text: "reply updated",
    });

    expect(updated.domainId).toBe(DOMAIN_B);
    expect(updated.threadId).toBe(draft.threadId);
    expect(updated.inReplyTo).toBe("parent@example.net");
    expect(updated.references).toEqual([
      "ancestor@example.net",
      "parent@example.net",
    ]);
  });

  test("repeated forward autosave does not duplicate shared-blob rows", async () => {
    const fake = await setup();
    const { source, attachment } = await seedForwardSource(fake);
    const save = createSaveDraftUseCase(fake.deps);
    const first = await save(adminViewer(), {
      from: "support@example.com",
      text: "forward body",
      forwardedFromMessageId: source.id,
      forwardAttachmentIds: [attachment.id],
    });
    const firstAttachments =
      (await fake.deps.messageRepository.listAttachments([first.id])).get(
        first.id,
      ) ?? [];
    const copy = firstAttachments[0];
    if (copy === undefined) {
      throw new Error("The first forward save did not create an attachment");
    }

    await save(adminViewer(), {
      draftId: first.id,
      from: "support@example.com",
      text: "forward body updated",
      forwardedFromMessageId: source.id,
      forwardAttachmentIds: [attachment.id],
      attachmentIds: [copy.id],
    });

    const attachments = (
      await fake.deps.messageRepository.listAttachments([first.id])
    ).get(first.id);
    expect(attachments).toHaveLength(1);
    expect(attachments?.[0]?.blobKey).toBe(attachment.blobKey);
  });

  test("a failed conditional draft update returns CONFLICT", async () => {
    const fake = await setup();
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      text: "body",
    });
    vi.spyOn(fake.deps.messageRepository, "saveIfDraft").mockResolvedValue(
      false,
    );

    await expect(
      createSaveDraftUseCase(fake.deps)(adminViewer(), {
        draftId: draft.id,
        from: "support@example.com",
        text: "updated",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("sending a draft twice delivers once and saves the provider receipt", async () => {
    const fake = await setup();
    fake.mailSender.setProviderMessageId("<draft-provider@example.net>");
    const attachment = createAttachment({
      id: createAttachmentId("draft-send-attachment"),
      messageId: null,
      fileName: "send.txt",
      contentType: "text/plain",
      size: 2,
      blobKey: "att/draft-send/send.txt",
      contentId: "inline@draft.test",
      inline: true,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(attachment);
    await fake.blobs.put(attachment.blobKey, new Uint8Array([9, 8]));
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Draft",
      text: "body",
      attachmentIds: [attachment.id],
    });
    const send = createSendDraftUseCase(fake.deps);
    const first = await send(adminViewer(), draft.id);
    await expect(send(adminViewer(), draft.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(first.status).toBe(MailStatus.Sent);
    expect(first.rfcMessageId).toBe("draft-provider@example.net");
    expect(fake.mailSender.sent).toHaveLength(1);
    expect(fake.mailSender.sent[0]?.attachments?.[0]).toMatchObject({
      fileName: "send.txt",
      contentId: "inline@draft.test",
      inline: true,
      content: new Uint8Array([9, 8]),
    });
  });
});
