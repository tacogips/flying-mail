import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createDraftMessage,
  MailStatus,
} from "@flying-mail/domain/entities/message";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { describe, expect, test } from "vitest";
import { BadUserInputError, NotFoundError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import { adminViewer, memberViewer } from "../test-support/viewer-fixtures";
import {
  assertOutboundAttachmentLimits,
  resolveForwardSources,
  resolveOwnAttachments,
} from "./attachment-binding";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-attachment-binding");

function attachment(id: string, messageId: string | null, size = 10) {
  return createAttachment({
    id: createAttachmentId(id),
    messageId: messageId === null ? null : createMessageId(messageId),
    fileName: `${id}.txt`,
    contentType: "text/plain",
    size,
    blobKey: `att/${id}.txt`,
    contentId: null,
    inline: false,
    createdAt: NOW,
  });
}

function draft(id: string) {
  return createDraftMessage({
    id: createMessageId(id),
    domainId: DOMAIN_ID,
    threadId: createThreadId(`thread-${id}`),
    rfcMessageId: null,
    inReplyTo: null,
    references: [],
    subject: "Draft",
    fromAddress: createEmailAddress("sender@example.com"),
    fromName: null,
    textBody: null,
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
  });
}

describe("attachment binding", () => {
  test("accepts staged uploads and attachments already on this draft", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const current = attachment("current", "draft-1");
    const staged = attachment("staged", null);
    await fake.deps.messageRepository.saveAttachment(current);
    await fake.deps.messageRepository.saveAttachment(staged);

    await expect(
      resolveOwnAttachments(
        fake.deps,
        [current.id, staged.id],
        createMessageId("draft-1"),
      ),
    ).resolves.toEqual([current, staged]);
  });

  test("rejects an attachment bound to another message", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const foreign = attachment("foreign", "message-elsewhere");
    await fake.deps.messageRepository.saveAttachment(foreign);

    await expect(
      resolveOwnAttachments(
        fake.deps,
        [foreign.id],
        createMessageId("draft-1"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("requires a source id when forwarding attachment ids", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await expect(
      resolveForwardSources(fake.deps, adminViewer(), undefined, [
        createAttachmentId("forwarded"),
      ]),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects a source the viewer cannot read", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const source = draft("unreadable-source");
    fake.messageStores.messages.set(source.id, {
      ...source,
      status: MailStatus.Sent,
    });

    await expect(
      resolveForwardSources(fake.deps, memberViewer(), source.id, []),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects a draft as a forward source", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const source = draft("draft-source");
    fake.messageStores.messages.set(source.id, source);

    await expect(
      resolveForwardSources(fake.deps, adminViewer(), source.id, []),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("returns only attachments belonging to the readable source", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const source = draft("sent-source");
    const sourceAttachment = attachment("source-att", source.id);
    const foreignAttachment = attachment("foreign-att", "other-source");
    const sentSource = { ...source, status: MailStatus.Sent };
    fake.messageStores.messages.set(source.id, sentSource);
    await fake.deps.messageRepository.saveAttachment(sourceAttachment);
    await fake.deps.messageRepository.saveAttachment(foreignAttachment);

    await expect(
      resolveForwardSources(fake.deps, adminViewer(), source.id, [
        sourceAttachment.id,
      ]),
    ).resolves.toEqual({ source: sentSource, attachments: [sourceAttachment] });
    await expect(
      resolveForwardSources(fake.deps, adminViewer(), source.id, [
        foreignAttachment.id,
      ]),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("enforces the outbound attachment count and total byte limits", () => {
    expect(() =>
      assertOutboundAttachmentLimits(
        Array.from({ length: 33 }, () => ({ size: 1 })),
      ),
    ).toThrow(BadUserInputError);
    expect(() =>
      assertOutboundAttachmentLimits([{ size: 5 * 1024 * 1024 + 1 }]),
    ).toThrow(BadUserInputError);
    expect(() =>
      assertOutboundAttachmentLimits([{ size: 5 * 1024 * 1024 }]),
    ).not.toThrow();
  });
});
