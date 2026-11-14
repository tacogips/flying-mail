import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { SystemTagSlug } from "@flying-mail/domain/entities/tag";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { ServiceUnavailableError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { apiKeyViewer } from "../test-support/viewer-fixtures";
import { createTrashMessagesUseCase } from "./trash";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-trash");
const MESSAGE_ID = createMessageId("message-trash");

function seedMessage(fake: FakeDependencies): void {
  fake.messageStores.messages.set(
    MESSAGE_ID,
    createInboundMessage({
      id: MESSAGE_ID,
      domainId: DOMAIN_ID,
      threadId: createThreadId("thread-trash"),
      rfcMessageId: "message@sender.example",
      inReplyTo: null,
      references: [],
      subject: "Trash me",
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
  fake.messageStores.recipients.set(MESSAGE_ID, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("owner@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(MESSAGE_ID, new Set());
}

describe("trashMessages", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
    seedMessage(fake);
  });

  test("adds Trash and records one update; repeating is idempotent", async () => {
    const trash = createTrashMessagesUseCase(fake.deps);
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailManage,
        domainId: DOMAIN_ID,
        addressPattern: "*",
      },
    ]);

    expect(await trash(viewer, [MESSAGE_ID])).toBe(1);
    const trashTag = await fake.deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    expect(trashTag).not.toBeNull();
    expect(
      fake.messageStores.messageTags.get(MESSAGE_ID)?.has(trashTag?.id ?? ""),
    ).toBe(true);
    expect(fake.fakeMailEventLog.records().map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
    ]);

    expect(await trash(viewer, [MESSAGE_ID])).toBe(1);
    expect(
      await fake.deps.messageRepository.findById(MESSAGE_ID),
    ).not.toBeNull();
    expect(fake.fakeMailEventLog.records()).toHaveLength(1);
  });

  test("silently skips a MAIL_READ-only key", async () => {
    const trash = createTrashMessagesUseCase(fake.deps);
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailRead,
        domainId: DOMAIN_ID,
        addressPattern: "*",
      },
    ]);

    expect(await trash(viewer, [MESSAGE_ID])).toBe(0);
    expect(fake.messageStores.messageTags.get(MESSAGE_ID)?.size).toBe(0);
  });

  test("silently skips a message outside the key address scope", async () => {
    const trash = createTrashMessagesUseCase(fake.deps);
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailManage,
        domainId: DOMAIN_ID,
        addressPattern: "other@example.com",
      },
    ]);

    expect(await trash(viewer, [MESSAGE_ID])).toBe(0);
    expect(fake.messageStores.messageTags.get(MESSAGE_ID)?.size).toBe(0);
  });

  test("throws when the Trash system tag is missing without deleting", async () => {
    const trash = createTrashMessagesUseCase(fake.deps);
    const viewer = apiKeyViewer([
      {
        capability: Capability.MailManage,
        domainId: DOMAIN_ID,
        addressPattern: "*",
      },
    ]);
    fake.stores.tags.delete("tag-trash");

    await expect(trash(viewer, [MESSAGE_ID])).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(
      await fake.deps.messageRepository.findById(MESSAGE_ID),
    ).not.toBeNull();
  });
});
