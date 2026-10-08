import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  DeliveryStatus,
  MailStatus,
} from "@flying-mail/domain/entities/message";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { BadUserInputError, NotFoundError } from "../errors";
import { createDeleteDraftUseCase } from "./delete-draft";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";
import {
  createReceiveMessageUseCase,
  type ReceiveMessageResult,
} from "./ingest";
import { createRetrySendUseCase, createSendMessageUseCase } from "./send";
import { createUseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-events");

function assertStored(
  result: ReceiveMessageResult,
): asserts result is Extract<ReceiveMessageResult, { kind: "STORED" }> {
  if (result.kind !== "STORED") {
    throw new Error(`Expected STORED, got ${result.kind}`);
  }
}

async function setupDomain(fake: FakeDependencies): Promise<void> {
  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "token",
        createdAt: NOW,
      }),
      NOW,
    ),
  );
}

describe("mail event emission for ingest, send and drafts", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await setupDomain(fake);
  });

  test("stored inbound messages emit normalized sender and envelope addresses", async () => {
    fake.mimeParser.setResult({
      from: { address: "Sender@Other.com", name: "Sender" },
      to: [{ address: "Support@Example.com", name: null }],
      messageId: "received@other.com",
      text: "message body",
    });

    const result = await createReceiveMessageUseCase(fake.deps)({
      envelopeFrom: "SENDER@OTHER.COM",
      envelopeTo: "SUPPORT@EXAMPLE.COM",
      raw: new TextEncoder().encode("stored inbound raw"),
      rawSize: 18,
      headers: new Map(),
    });

    assertStored(result);
    expect(fake.fakeMailEventLog.records()).toMatchObject([
      {
        type: MailEventType.MessageReceived,
        messageId: result.message.id,
        addresses: ["sender@other.com", "support@example.com"],
      },
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("rejected, same-envelope duplicate and same-address delivery emit no extra event", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const rejected = await receive({
      envelopeFrom: "sender@other.com",
      envelopeTo: "missing@unknown.com",
      raw: new TextEncoder().encode("ignored"),
      rawSize: 7,
      headers: new Map(),
    });
    expect(rejected.kind).toBe("REJECTED");
    expect(fake.fakeMailEventLog.records()).toHaveLength(0);

    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      to: [{ address: "support@example.com", name: null }],
      messageId: "duplicate@other.com",
      text: "same body",
    });
    const input = {
      envelopeFrom: "sender@other.com",
      envelopeTo: "support@example.com",
      raw: new TextEncoder().encode("same raw message"),
      rawSize: 16,
      headers: new Map<string, string>(),
    };
    const first = await receive(input);
    const duplicate = await receive(input);

    assertStored(first);
    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.fakeMailEventLog.records()).toHaveLength(1);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("a duplicate delivered to a new envelope address emits once with that address", async () => {
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      to: [{ address: "support@example.com", name: null }],
      messageId: "multi-recipient@other.com",
      text: "same body",
    });
    const receive = createReceiveMessageUseCase(fake.deps);
    const raw = new TextEncoder().encode("same raw bytes");
    const first = await receive({
      envelopeFrom: "sender@other.com",
      envelopeTo: "support@example.com",
      raw,
      rawSize: raw.length,
      headers: new Map(),
    });
    const second = await receive({
      envelopeFrom: "sender@other.com",
      envelopeTo: "sales@example.com",
      raw,
      rawSize: raw.length,
      headers: new Map(),
    });

    assertStored(first);
    expect(second.kind).toBe("DUPLICATE");
    expect(fake.fakeMailEventLog.records()).toMatchObject([
      { type: MailEventType.MessageReceived },
      {
        type: MailEventType.MessageReceived,
        messageId: first.message.id,
        addresses: [
          "sales@example.com",
          "sender@other.com",
          "support@example.com",
        ],
      },
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(2);
  });

  test("send emits MESSAGE_SENT for success and persisted failure", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const sent = await send(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Sent",
      text: "body",
    });
    expect(sent.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(fake.fakeMailEventLog.records().at(-1)).toMatchObject({
      type: MailEventType.MessageSent,
      messageId: sent.id,
    });

    fake.mailSender.failNext(new Error("MailDeliveryError"));
    const failed = await send(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Failed",
      text: "body",
    });
    expect(failed.deliveryStatus).toBe(DeliveryStatus.Failed);
    expect(fake.fakeMailEventLog.records().at(-1)).toMatchObject({
      type: MailEventType.MessageSent,
      messageId: failed.id,
    });
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(2);
  });

  test("append failure does not change send result or notify", async () => {
    fake.fakeMailEventLog.failNextAppend();
    const send = createSendMessageUseCase(fake.deps);
    const sent = await send(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Append failure",
      text: "body",
    });

    expect(sent.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(fake.messageStores.messages.get(sent.id)).toEqual(sent);
    expect(fake.fakeMailEventLog.records()).toHaveLength(0);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
  });

  test("a send failure that throws emits no event", async () => {
    const send = createSendMessageUseCase(fake.deps);

    await expect(
      send(adminViewer(), {
        from: "missing@unknown.com",
        to: ["customer@other.com"],
        subject: "Rejected send",
        text: "body",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
    expect(fake.fakeMailEventLog.records()).toHaveLength(0);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(0);
  });

  test("sendTemplatedMessage emits once through sendMessage", async () => {
    const usecases = createUseCases(fake.deps);
    const template = await usecases.createMailTemplate(adminViewer(), {
      name: "One event",
      subject: "Templated subject",
      textBody: "Templated body",
      from: "support@example.com",
      to: ["customer@other.com"],
      variables: [],
    });

    const message = await usecases.sendTemplatedMessage(adminViewer(), {
      templateId: template.id,
      values: [],
    });

    expect(fake.fakeMailEventLog.records()).toMatchObject([
      { type: MailEventType.MessageSent, messageId: message.id },
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(1);
  });

  test("retrySend emits MESSAGE_UPDATED after the retry outcome persists", async () => {
    fake.mailSender.failNext(new Error("MailDeliveryError"));
    const send = createSendMessageUseCase(fake.deps);
    const failed = await send(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Retry",
      text: "body",
    });
    const retried = await createRetrySendUseCase(fake.deps)(
      adminViewer(),
      failed.id,
    );

    expect(retried.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(fake.fakeMailEventLog.records()).toMatchObject([
      { type: MailEventType.MessageSent, messageId: failed.id },
      { type: MailEventType.MessageUpdated, messageId: failed.id },
    ]);
  });

  test("draft create and update each emit DRAFT_SAVED for the same id", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const created = await save(adminViewer(), {
      from: "support@example.com",
      to: ["first@other.com"],
      subject: "Draft v1",
      text: "first",
    });
    const updated = await save(adminViewer(), {
      draftId: created.id,
      from: "support@example.com",
      to: ["second@other.com"],
      subject: "Draft v2",
      text: "second",
    });

    expect(updated.id).toBe(created.id);
    expect(fake.fakeMailEventLog.records()).toMatchObject([
      { type: MailEventType.DraftSaved, messageId: created.id },
      { type: MailEventType.DraftSaved, messageId: created.id },
    ]);
    expect(fake.fakeMailEventNotifier.notifyCount).toBe(2);
  });

  test("sendDraft emits MESSAGE_SENT and deleteDraft captures pre-delete addresses", async () => {
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Ready",
      text: "body",
    });
    const sent = await createSendDraftUseCase(fake.deps)(
      adminViewer(),
      draft.id,
    );

    expect(sent.status).toBe(MailStatus.Sent);
    expect(fake.fakeMailEventLog.records().at(-1)).toMatchObject({
      type: MailEventType.MessageSent,
      messageId: draft.id,
    });

    const deletable = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["delete-me@other.com"],
      subject: "Discard",
    });
    const deleted = await createDeleteDraftUseCase(fake.deps)(
      adminViewer(),
      deletable.id,
    );

    expect(deleted).toBe(true);
    expect(fake.fakeMailEventLog.records().at(-1)).toMatchObject({
      type: MailEventType.DraftDeleted,
      messageId: deletable.id,
      addresses: ["delete-me@other.com", "support@example.com"],
    });
  });

  test("deleteDraft on a non-draft returns NOT_FOUND without an event", async () => {
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Sent draft",
      text: "body",
    });
    await createSendDraftUseCase(fake.deps)(adminViewer(), draft.id);
    const count = fake.fakeMailEventLog.records().length;

    await expect(
      createDeleteDraftUseCase(fake.deps)(adminViewer(), draft.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fake.fakeMailEventLog.records()).toHaveLength(count);
  });
});
