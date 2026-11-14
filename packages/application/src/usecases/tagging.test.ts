import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { SpamMarkedBy } from "@mailcal/domain/entities/spam-mark";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createTagId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { NotFoundError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  mailboxAgentViewer,
} from "../test-support/viewer-fixtures";
import { createCreateTagUseCase } from "./tags";
import {
  createMarkNotSpamUseCase,
  createMarkSpamUseCase,
  createTagMessagesUseCase,
  createUntagMessagesUseCase,
} from "./tagging";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

function seedMessage(fake: FakeDependencies, id: string, to: string): void {
  const messageId = createMessageId(id);
  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId,
      threadId: createThreadId(id),
      rfcMessageId: `${id}@other.com`,
      inReplyTo: null,
      references: [],
      subject: "Subject",
      fromAddress: createEmailAddress("sender@other.com"),
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
  fake.messageStores.recipients.set(messageId, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(to),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(messageId, new Set());
}

describe("tagging", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
    seedMessage(fake, "msg-1", "support@example.com");
    seedMessage(fake, "msg-2", "billing@example.com");
  });

  test("adds and removes a user tag", async () => {
    const createTag = createCreateTagUseCase(fake.deps);
    const tag = await createTag(adminViewer(), "Invoices", null);

    const tagMessages = createTagMessagesUseCase(fake.deps);
    await tagMessages(adminViewer(), [createMessageId("msg-1")], [tag.id]);
    expect(fake.messageStores.messageTags.get("msg-1")?.has(tag.id)).toBe(true);

    const untagMessages = createUntagMessagesUseCase(fake.deps);
    await untagMessages(adminViewer(), [createMessageId("msg-1")], [tag.id]);
    expect(fake.messageStores.messageTags.get("msg-1")?.has(tag.id)).toBe(
      false,
    );
  });

  test("rejects an unknown tag id", async () => {
    const tagMessages = createTagMessagesUseCase(fake.deps);
    await expect(
      tagMessages(
        adminViewer(),
        [createMessageId("msg-1")],
        [createTagId("nope")],
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("skips messages the viewer may not manage", async () => {
    const createTag = createCreateTagUseCase(fake.deps);
    const tag = await createTag(adminViewer(), "Invoices", null);

    const tagMessages = createTagMessagesUseCase(fake.deps);
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    const tagged = await tagMessages(
      viewer,
      [createMessageId("msg-1"), createMessageId("msg-2")],
      [tag.id],
    );
    expect(tagged.map((message) => message.id)).toEqual(["msg-1"]);
    expect(fake.messageStores.messageTags.get("msg-2")?.has(tag.id)).toBe(
      false,
    );
  });

  test("marks and unmarks spam as verdict rows", async () => {
    const markSpam = createMarkSpamUseCase(fake.deps);
    await markSpam(adminViewer(), [createMessageId("msg-1")]);
    const mark = fake.messageStores.spamMarks.get("msg-1");
    expect(mark?.markedBy).toBe(SpamMarkedBy.User);
    // A hand mark records no score: no scorer ran.
    expect(mark?.score).toBeNull();

    const markNotSpam = createMarkNotSpamUseCase(fake.deps);
    await markNotSpam(adminViewer(), [createMessageId("msg-1")]);
    expect(fake.messageStores.spamMarks.has("msg-1")).toBe(false);
  });
});
