import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createAttachmentId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import {
  createFakeMessageStores,
  fakeMessageRepository,
} from "../test-support/message-repository-fake";
import {
  deleteAttachmentsAndUnreferencedBlobs,
  deleteUnreferencedBlobs,
} from "./attachment-blobs";

function attachment(id: string, blobKey: string) {
  return createAttachment({
    id: createAttachmentId(id),
    messageId: createMessageId(`msg-${id}`),
    fileName: `${id}.txt`,
    contentType: "text/plain",
    size: 1,
    blobKey,
    contentId: null,
    inline: false,
    createdAt: "2026-08-24T00:00:00.000Z",
  });
}

function dependencies() {
  const stores = createFakeMessageStores();
  const deleteBlob = vi.fn(async (_key: string) => undefined);
  return {
    stores,
    deleteBlob,
    deps: {
      messageRepository: fakeMessageRepository(stores),
      blobs: {
        put: async () => undefined,
        get: async () => null,
        delete: deleteBlob,
      },
    },
  };
}

describe("attachment blob cleanup", () => {
  test("keeps a blob while another attachment row references it", async () => {
    const { stores, deleteBlob, deps } = dependencies();
    const removed = attachment("removed", "shared/blob");
    const remaining = attachment("remaining", "shared/blob");
    stores.attachments.set(removed.id, removed);
    stores.attachments.set(remaining.id, remaining);
    await deleteAttachmentsAndUnreferencedBlobs(deps, [removed]);
    expect(stores.attachments.has(remaining.id)).toBe(true);
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  test("deletes the blob after the last reference is removed", async () => {
    const { stores, deleteBlob, deps } = dependencies();
    const last = attachment("last", "last/blob");
    stores.attachments.set(last.id, last);
    await deleteAttachmentsAndUnreferencedBlobs(deps, [last]);
    expect(deleteBlob).toHaveBeenCalledWith("last/blob");
  });

  test("swallows a blob deletion failure", async () => {
    const { deps } = dependencies();
    deps.blobs.delete.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      deleteUnreferencedBlobs(deps, ["orphan/blob"]),
    ).resolves.toBeUndefined();
  });
});
