import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { createSweepExpiredAuthUseCase } from "./email-auth";
import { createDeleteMessagesUseCase } from "./messages";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("domain-1");

function seedMessage(fake: FakeDependencies, id: string): void {
  const messageId = createMessageId(id);
  const message = createInboundMessage({
    id: messageId,
    domainId: DOMAIN_ID,
    threadId: createThreadId(id),
    rfcMessageId: `${id}@example.com`,
    inReplyTo: null,
    references: [],
    subject: id,
    fromAddress: createEmailAddress("sender@example.com"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
  });
  fake.messageStores.messages.set(messageId, message);
  fake.messageStores.recipients.set(messageId, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("inbox@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(messageId, new Set());
}

function seedAttachment(
  fake: FakeDependencies,
  options: {
    readonly id: string;
    readonly messageId: string | null;
    readonly blobKey: string;
    readonly createdAt?: string;
  },
): void {
  const id = createAttachmentId(options.id);
  fake.messageStores.attachments.set(
    id,
    createAttachment({
      id,
      messageId:
        options.messageId === null ? null : createMessageId(options.messageId),
      fileName: `${options.id}.bin`,
      contentType: "application/octet-stream",
      size: 1,
      blobKey: options.blobKey,
      contentId: null,
      inline: false,
      createdAt: options.createdAt ?? NOW,
    }),
  );
}

async function purge(fake: FakeDependencies, messageId: string): Promise<void> {
  const remove = createDeleteMessagesUseCase(fake.deps);
  await remove(adminViewer(), [createMessageId(messageId)]);
  await remove(adminViewer(), [createMessageId(messageId)]);
}

describe("attachment blob deletion", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("keeps a shared blob until the last referencing message is purged", async () => {
    seedMessage(fake, "source");
    seedMessage(fake, "forward");
    seedAttachment(fake, {
      id: "source-attachment",
      messageId: "source",
      blobKey: "shared/blob.bin",
    });
    seedAttachment(fake, {
      id: "forward-attachment",
      messageId: "forward",
      blobKey: "shared/blob.bin",
    });
    await fake.deps.blobs.put("shared/blob.bin", new Uint8Array([1]));

    await purge(fake, "source");

    expect(fake.messageStores.messages.has("source")).toBe(false);
    expect(fake.messageStores.attachments.has("source-attachment")).toBe(false);
    expect(fake.messageStores.attachments.has("forward-attachment")).toBe(true);
    expect(await fake.deps.blobs.get("shared/blob.bin")).not.toBeNull();

    await purge(fake, "forward");

    expect(fake.messageStores.messages.has("forward")).toBe(false);
    expect(await fake.deps.blobs.get("shared/blob.bin")).toBeNull();
  });

  test("deletes a unique attachment blob when its message is purged", async () => {
    seedMessage(fake, "unique");
    seedAttachment(fake, {
      id: "unique-attachment",
      messageId: "unique",
      blobKey: "unique/blob.bin",
    });
    await fake.deps.blobs.put("unique/blob.bin", new Uint8Array([1]));

    await purge(fake, "unique");

    expect(fake.messageStores.attachments.has("unique-attachment")).toBe(false);
    expect(await fake.deps.blobs.get("unique/blob.bin")).toBeNull();
  });

  test("deletes stale staged-upload rows before deleting their unique blobs", async () => {
    seedAttachment(fake, {
      id: "stale-upload",
      messageId: null,
      blobKey: "staged/stale.bin",
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    await fake.deps.blobs.put("staged/stale.bin", new Uint8Array([1]));

    await createSweepExpiredAuthUseCase(fake.deps)();

    expect(fake.messageStores.attachments.has("stale-upload")).toBe(false);
    expect(await fake.deps.blobs.get("staged/stale.bin")).toBeNull();
  });

  test("purge resolves and removes rows when deleting the attachment blob fails", async () => {
    seedMessage(fake, "failed-purge");
    seedAttachment(fake, {
      id: "failed-purge-attachment",
      messageId: "failed-purge",
      blobKey: "failed/purge.bin",
    });
    vi.spyOn(fake.deps.blobs, "delete").mockRejectedValue(
      new Error("storage unavailable"),
    );

    await expect(purge(fake, "failed-purge")).resolves.toBeUndefined();

    expect(fake.messageStores.messages.has("failed-purge")).toBe(false);
    expect(fake.messageStores.attachments.has("failed-purge-attachment")).toBe(
      false,
    );
  });

  test("staged sweep resolves and removes rows when deleting the blob fails", async () => {
    seedAttachment(fake, {
      id: "failed-sweep-upload",
      messageId: null,
      blobKey: "failed/sweep.bin",
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    vi.spyOn(fake.deps.blobs, "delete").mockRejectedValue(
      new Error("storage unavailable"),
    );

    await expect(
      createSweepExpiredAuthUseCase(fake.deps)(),
    ).resolves.toBeUndefined();

    expect(fake.messageStores.attachments.has("failed-sweep-upload")).toBe(
      false,
    );
  });
});
