import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createAttachmentId,
  createDomainId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { NotFoundError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { createDeleteDraftUseCase } from "./delete-draft";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("delete-draft-domain");

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

describe("deleteDraft", () => {
  test("deletes a draft and its unreferenced attachment blob", async () => {
    const fake = await setup();
    const attachment = createAttachment({
      id: createAttachmentId("delete-draft-file"),
      messageId: null,
      fileName: "draft.txt",
      contentType: "text/plain",
      size: 4,
      blobKey: "att/delete-draft/draft.txt",
      contentId: null,
      inline: false,
      createdAt: NOW,
    });
    await fake.deps.messageRepository.saveAttachment(attachment);
    await fake.blobs.put(attachment.blobKey, new Uint8Array([1, 2, 3, 4]));
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      text: "unfinished",
      attachmentIds: [attachment.id],
    });

    await expect(
      createDeleteDraftUseCase(fake.deps)(adminViewer(), draft.id),
    ).resolves.toBe(true);
    expect(fake.messageStores.messages.has(draft.id)).toBe(false);
    expect(fake.messageStores.attachments.has(attachment.id)).toBe(false);
    expect(fake.blobs.keys()).not.toContain(attachment.blobKey);
  });

  test("returns NOT_FOUND when asked to delete a sent message", async () => {
    const fake = await setup();
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["recipient@outside.test"],
      subject: "Ready",
      text: "body",
    });
    await createSendDraftUseCase(fake.deps)(adminViewer(), draft.id);

    await expect(
      createDeleteDraftUseCase(fake.deps)(adminViewer(), draft.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
