import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createAttachment,
  type Attachment,
} from "@flying-mail/domain/entities/attachment";
import { createInboundMessage } from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "./mail-limits";
import {
  createReadAttachmentUseCase,
  createStageAttachmentUploadUseCase,
} from "./attachment-uploads";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-attachment-upload");
const MESSAGE_ID = createMessageId("message-attachment-upload");
const VIEWER = apiKeyViewer([
  { capability: Capability.MailRead, domainId: DOMAIN_ID, addressPattern: "*" },
  { capability: Capability.MailSend, domainId: DOMAIN_ID, addressPattern: "*" },
]);
const READ_ONLY_VIEWER = apiKeyViewer([
  { capability: Capability.MailRead, domainId: DOMAIN_ID, addressPattern: "*" },
]);

function seedReadableMessage(
  fake: ReturnType<typeof createFakeDependencies>,
): void {
  fake.messageStores.messages.set(
    MESSAGE_ID,
    createInboundMessage({
      id: MESSAGE_ID,
      domainId: DOMAIN_ID,
      threadId: createThreadId("thread-attachment-upload"),
      rfcMessageId: "message@sender.example",
      inReplyTo: null,
      references: [],
      subject: "Attachment message",
      fromAddress: createEmailAddress("sender@sender.example"),
      fromName: null,
      textBody: "body",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    }),
  );
  fake.messageStores.recipients.set(MESSAGE_ID, []);
}

function attachedAttachment(id: string): Attachment {
  return createAttachment({
    id: createAttachmentId(id),
    messageId: MESSAGE_ID,
    fileName: "message.txt",
    contentType: "text/plain",
    size: 3,
    blobKey: `att/${id}/message.txt`,
    contentId: null,
    inline: false,
    createdAt: NOW,
  });
}

describe("attachment upload use cases", () => {
  test("stages a small upload and stores its blob", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const stage = createStageAttachmentUploadUseCase(fake.deps);

    const attachment = await stage(VIEWER, {
      fileName: "hello.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(attachment.messageId).toBeNull();
    expect(attachment.size).toBe(3);
    expect(fake.blobs.keys()).toEqual([attachment.blobKey]);
    expect(fake.blobs.raw(attachment.blobKey)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      await fake.deps.messageRepository.findAttachmentById(attachment.id),
    ).toEqual(attachment);
  });

  test("refuses a staged upload from a credential that cannot send", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const stage = createStageAttachmentUploadUseCase(fake.deps);
    const upload = {
      fileName: "hello.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([1]),
    };

    for (const viewer of [READ_ONLY_VIEWER, viewerViewer(), memberViewer()]) {
      await expect(stage(viewer, upload)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(fake.blobs.keys()).toEqual([]);

    // A member with an ALLOW rule and an admin may stage.
    const permitted = memberViewer(
      "usr-member",
      buildMailPermissions(createUserId("usr-member"), [
        { effect: "ALLOW", addressPattern: "*" },
      ]),
    );
    await expect(stage(permitted, upload)).resolves.toMatchObject({
      messageId: null,
    });
    await expect(stage(adminViewer(), upload)).resolves.toMatchObject({
      messageId: null,
    });
  });

  test("rejects content above the upload cap without storing it", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const stage = createStageAttachmentUploadUseCase(fake.deps);

    await expect(
      stage(VIEWER, {
        fileName: "large.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array(MAX_ATTACHMENT_UPLOAD_BYTES + 1),
      }),
    ).rejects.toMatchObject({
      code: "BAD_USER_INPUT",
      field: "content",
    });
    expect(fake.blobs.keys()).toEqual([]);
  });

  test("defaults an empty name and content type", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const attachment = await createStageAttachmentUploadUseCase(fake.deps)(
      VIEWER,
      { fileName: "", contentType: "", bytes: new Uint8Array([1]) },
    );

    expect(attachment.fileName).toBe("attachment");
    expect(attachment.contentType).toBe("application/octet-stream");
  });

  test("returns NOT_FOUND for a staged attachment", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const staged = await createStageAttachmentUploadUseCase(fake.deps)(VIEWER, {
      fileName: "staged.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([1]),
    });

    await expect(
      createReadAttachmentUseCase(fake.deps)(VIEWER, staged.id, {
        includeBody: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("returns NOT_FOUND for an unreadable attachment", async () => {
    const fake = createFakeDependencies({ now: NOW });
    seedReadableMessage(fake);
    const attachment = attachedAttachment("unreadable-attachment");
    await fake.deps.messageRepository.saveAttachment(attachment);
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailRead,
        domainId: DOMAIN_ID,
        addressPattern: "other@example.com",
      },
    ]);

    await expect(
      createReadAttachmentUseCase(fake.deps)(viewer, attachment.id, {
        includeBody: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("does not read blob data when includeBody is false", async () => {
    const fake = createFakeDependencies({ now: NOW });
    seedReadableMessage(fake);
    const attachment = attachedAttachment("metadata-only");
    await fake.deps.messageRepository.saveAttachment(attachment);
    const get = vi.spyOn(fake.deps.blobs, "get");

    await expect(
      createReadAttachmentUseCase(fake.deps)(VIEWER, attachment.id, {
        includeBody: false,
      }),
    ).resolves.toEqual({ attachment, blob: null });
    expect(get).not.toHaveBeenCalled();
  });

  test("returns NOT_FOUND when the attachment blob is missing", async () => {
    const fake = createFakeDependencies({ now: NOW });
    seedReadableMessage(fake);
    const attachment = attachedAttachment("missing-blob");
    await fake.deps.messageRepository.saveAttachment(attachment);

    await expect(
      createReadAttachmentUseCase(fake.deps)(VIEWER, attachment.id, {
        includeBody: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
