import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { recordMailEvents } from "./mail-events";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-events");

describe("recordMailEvents", () => {
  let fake: FakeDependencies;
  let message: ReturnType<typeof createInboundMessage>;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
    message = createInboundMessage({
      id: createMessageId("msg-events"),
      domainId,
      threadId: createThreadId("thr-events"),
      rfcMessageId: "event@example.net",
      inReplyTo: null,
      references: [],
      subject: "Private subject",
      fromAddress: createEmailAddress(" Sender@Example.net "),
      fromName: null,
      textBody: "Private body",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    });
    fake.messageStores.recipients.set(message.id, [
      {
        kind: RecipientKind.Envelope,
        address: createEmailAddress("envelope@example.com"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.To,
        address: createEmailAddress("B@Example.com"),
        name: null,
        position: 1,
      },
      {
        kind: RecipientKind.Cc,
        address: createEmailAddress("a@example.com"),
        name: null,
        position: 2,
      },
      {
        kind: RecipientKind.Bcc,
        address: createEmailAddress("b@example.com"),
        name: null,
        position: 3,
      },
    ]);
  });

  test("records normalized sender and all recipients before one notify", async () => {
    await recordMailEvents(fake.deps, [
      { type: MailEventType.MessageReceived, message },
      {
        type: MailEventType.MessageUpdated,
        message,
        addresses: [" B@Example.com", "sender@example.net"],
      },
    ]);

    expect(
      fake.fakeMailEventLog.records().map((record) => record.addresses),
    ).toEqual([
      [
        "a@example.com",
        "b@example.com",
        "envelope@example.com",
        "sender@example.net",
      ],
      ["b@example.com", "sender@example.net"],
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("append failure is swallowed, logged without addresses, and skips notify", async () => {
    fake.fakeMailEventLog.failNextAppend();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordMailEvents(fake.deps, [
        { type: MailEventType.MessageReceived, message },
      ]),
    ).resolves.toBeUndefined();

    expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Failed to record mail events", {
      count: 1,
      types: [MailEventType.MessageReceived],
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "sender@example.net",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain("Private subject");
    error.mockRestore();
  });

  test("empty input does not append or notify", async () => {
    await recordMailEvents(fake.deps, []);
    expect(fake.fakeMailEventLog.records()).toEqual([]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
  });
});
