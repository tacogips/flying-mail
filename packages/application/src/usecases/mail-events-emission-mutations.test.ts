import {
  createClassificationRule,
  RuleAction,
  RuleField,
  RuleMatcher,
} from "@flying-mail/domain/entities/classification-rule";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { SystemTagSlug } from "@flying-mail/domain/entities/tag";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createClassificationRuleId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMarkMessagesFetchedUseCase } from "./fetch-state";
import { createDeleteMessagesUseCase, createMarkReadUseCase } from "./messages";
import { createApplyClassificationRuleUseCase } from "./rules";
import {
  createMarkNotSpamUseCase,
  createMarkSpamUseCase,
  createTagMessagesUseCase,
  createUntagMessagesUseCase,
} from "./tagging";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  mailboxAgentViewer,
} from "../test-support/viewer-fixtures";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-events");

function seedMessage(
  fake: FakeDependencies,
  id: string,
  to: string,
  subject = "subject",
): void {
  const messageId = createMessageId(id);
  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId,
      threadId: createThreadId(id),
      rfcMessageId: `${id}@sender.example`,
      inReplyTo: null,
      references: [],
      subject,
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

describe("message mutation mail events", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
    seedMessage(fake, "msg-1", "support@example.com", "match one");
    seedMessage(fake, "msg-2", "support@example.com", "match two");
  });

  test("markRead appends one batch for readable messages", async () => {
    await createMarkReadUseCase(fake.deps)(
      adminViewer(),
      [createMessageId("msg-1"), createMessageId("msg-2")],
      true,
    );

    expect(fake.fakeMailEventLog.records().map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
      "MESSAGE_UPDATED",
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("delete trashes then purges with addresses captured before deletion", async () => {
    const remove = createDeleteMessagesUseCase(fake.deps);
    await remove(adminViewer(), [createMessageId("msg-1")]);
    expect(fake.fakeMailEventLog.records().map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
    ]);

    await remove(adminViewer(), [createMessageId("msg-1")]);
    const events = fake.fakeMailEventLog.records();
    expect(events.map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
      "MESSAGE_DELETED",
    ]);
    expect(events[1]?.addresses).toEqual([
      "sender@sender.example",
      "support@example.com",
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(2);
  });

  test("mixed delete emits exactly one update and one delete", async () => {
    const remove = createDeleteMessagesUseCase(fake.deps);
    await remove(adminViewer(), [createMessageId("msg-1")]);
    await remove(adminViewer(), [
      createMessageId("msg-1"),
      createMessageId("msg-2"),
    ]);

    const events = fake.fakeMailEventLog.records();
    expect(events.map((event) => [event.messageId, event.type])).toEqual([
      ["msg-1", "MESSAGE_UPDATED"],
      ["msg-2", "MESSAGE_UPDATED"],
      ["msg-1", "MESSAGE_DELETED"],
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(2);
  });

  test("tag, untag, spam and not-spam each emit updated events", async () => {
    const starred = await fake.deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Starred,
    );
    expect(starred).not.toBeNull();
    if (starred === null) {
      throw new Error("STARRED system tag is not seeded");
    }
    await createTagMessagesUseCase(fake.deps)(
      adminViewer(),
      [createMessageId("msg-1")],
      [starred.id],
    );
    await createUntagMessagesUseCase(fake.deps)(
      adminViewer(),
      [createMessageId("msg-1")],
      [starred.id],
    );
    await createMarkSpamUseCase(fake.deps)(adminViewer(), [
      createMessageId("msg-1"),
    ]);
    await createMarkNotSpamUseCase(fake.deps)(adminViewer(), [
      createMessageId("msg-1"),
    ]);

    expect(fake.fakeMailEventLog.records().map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
      "MESSAGE_UPDATED",
      "MESSAGE_UPDATED",
      "MESSAGE_UPDATED",
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(4);
  });

  test("classification rule appends a batch for matching messages", async () => {
    const ruleId = createClassificationRuleId("rule-events");
    fake.ruleStores.rules.set(
      ruleId,
      createClassificationRule({
        id: ruleId,
        domainId,
        field: RuleField.Subject,
        matcher: RuleMatcher.Contains,
        pattern: "match",
        action: RuleAction.Spam,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );

    const result = await createApplyClassificationRuleUseCase(fake.deps)(
      adminViewer(),
      ruleId,
    );

    expect(result.matched).toBe(2);
    expect(fake.fakeMailEventLog.records().map((event) => event.type)).toEqual([
      "MESSAGE_UPDATED",
      "MESSAGE_UPDATED",
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("unreadable ids and fetch acknowledgements emit no events", async () => {
    seedMessage(fake, "msg-other", "billing@example.com");
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    const updated = await createMarkReadUseCase(fake.deps)(
      viewer,
      [createMessageId("msg-other")],
      true,
    );
    expect(updated).toEqual([]);

    await createMarkMessagesFetchedUseCase(fake.deps)(viewer, [
      createMessageId("msg-1"),
    ]);
    expect(fake.fakeMailEventLog.records()).toEqual([]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
  });

  test("append failure preserves mutation result and skips notify", async () => {
    fake.fakeMailEventLog.failNextAppend();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createMarkReadUseCase(fake.deps)(
        adminViewer(),
        [createMessageId("msg-1")],
        true,
      );
      expect(result).toHaveLength(1);
      expect(fake.messageStores.messages.get("msg-1")?.readAt).toBe(NOW);
      expect(fake.fakeMailEventLog.records()).toEqual([]);
      expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
