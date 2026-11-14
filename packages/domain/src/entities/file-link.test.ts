import { describe, expect, test } from "vitest";
import { InvalidStateTransitionError, ValidationError } from "../errors";
import {
  createAttachmentId,
  createFileLinkId,
  createMessageId,
} from "../value-objects/ids";
import {
  consumeFileLink,
  createAttachmentFileLink,
  createRawMessageFileLink,
  FileLinkTarget,
  isFileLinkUsable,
  revokeFileLink,
} from "./file-link";

const createdAt = "2026-08-23T00:00:00.000Z";
const expiresAt = "2026-08-23T01:00:00.000Z";

const attachmentLink = (maxDownloads: number | null = null) =>
  createAttachmentFileLink({
    id: createFileLinkId("link-1"),
    tokenHash: "hash",
    attachmentId: createAttachmentId("att-1"),
    expiresAt,
    maxDownloads,
    createdByApiKeyId: null,
    createdByUserId: null,
    createdAt,
  });

describe("createAttachmentFileLink", () => {
  test("targets the attachment and starts unused", () => {
    const link = attachmentLink();
    expect(link.target).toBe(FileLinkTarget.Attachment);
    expect(link.attachmentId).toBe("att-1");
    expect(link.messageId).toBeNull();
    expect(link.downloadCount).toBe(0);
    expect(link.revokedAt).toBeNull();
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s maxDownloads", (_name, maxDownloads) => {
    expect(() => attachmentLink(maxDownloads)).toThrow(ValidationError);
  });

  test("rejects an expiry at or before creation", () => {
    expect(() =>
      createAttachmentFileLink({
        id: createFileLinkId("link-2"),
        tokenHash: "hash",
        attachmentId: createAttachmentId("att-1"),
        expiresAt: createdAt,
        maxDownloads: null,
        createdByApiKeyId: null,
        createdByUserId: null,
        createdAt,
      }),
    ).toThrow(ValidationError);
  });
});

describe("createRawMessageFileLink", () => {
  test("targets the message", () => {
    const link = createRawMessageFileLink({
      id: createFileLinkId("link-3"),
      tokenHash: "hash",
      messageId: createMessageId("msg-1"),
      expiresAt,
      maxDownloads: 2,
      createdByApiKeyId: null,
      createdByUserId: null,
      createdAt,
    });
    expect(link.target).toBe(FileLinkTarget.RawMessage);
    expect(link.messageId).toBe("msg-1");
    expect(link.attachmentId).toBeNull();
    expect(link.maxDownloads).toBe(2);
  });
});

describe("isFileLinkUsable", () => {
  test("is usable before expiry", () => {
    expect(isFileLinkUsable(attachmentLink(), "2026-08-23T00:30:00.000Z")).toBe(
      true,
    );
  });

  test("is not usable at or after expiry", () => {
    expect(isFileLinkUsable(attachmentLink(), expiresAt)).toBe(false);
    expect(isFileLinkUsable(attachmentLink(), "2026-08-24T00:00:00.000Z")).toBe(
      false,
    );
  });

  test("is not usable once revoked", () => {
    const revoked = revokeFileLink(
      attachmentLink(),
      "2026-08-23T00:10:00.000Z",
    );
    expect(isFileLinkUsable(revoked, "2026-08-23T00:30:00.000Z")).toBe(false);
  });

  test("is not usable once the download allowance is exhausted", () => {
    const link = { ...attachmentLink(1), downloadCount: 1 };
    expect(isFileLinkUsable(link, "2026-08-23T00:30:00.000Z")).toBe(false);
  });

  test("an unlimited link stays usable after many downloads", () => {
    const link = { ...attachmentLink(null), downloadCount: 1000 };
    expect(isFileLinkUsable(link, "2026-08-23T00:30:00.000Z")).toBe(true);
  });
});

describe("consumeFileLink", () => {
  test("increments the download count", () => {
    const consumed = consumeFileLink(
      attachmentLink(2),
      "2026-08-23T00:30:00.000Z",
    );
    expect(consumed.downloadCount).toBe(1);
  });

  test("exhausts exactly at maxDownloads", () => {
    const first = consumeFileLink(
      attachmentLink(2),
      "2026-08-23T00:10:00.000Z",
    );
    const second = consumeFileLink(first, "2026-08-23T00:20:00.000Z");
    expect(second.downloadCount).toBe(2);
    expect(() => consumeFileLink(second, "2026-08-23T00:30:00.000Z")).toThrow(
      InvalidStateTransitionError,
    );
  });

  test("refuses an expired link", () => {
    expect(() => consumeFileLink(attachmentLink(), expiresAt)).toThrow(
      InvalidStateTransitionError,
    );
  });

  test("refuses a revoked link", () => {
    const revoked = revokeFileLink(
      attachmentLink(),
      "2026-08-23T00:10:00.000Z",
    );
    expect(() => consumeFileLink(revoked, "2026-08-23T00:30:00.000Z")).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe("revokeFileLink", () => {
  test("re-revoking keeps the original timestamp", () => {
    const first = revokeFileLink(attachmentLink(), "2026-08-23T00:10:00.000Z");
    const second = revokeFileLink(first, "2026-08-23T00:20:00.000Z");
    expect(second.revokedAt).toBe("2026-08-23T00:10:00.000Z");
  });
});
