import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createInboundMessage,
  DeliveryStatus,
  MailStatus,
} from "@mailcal/domain/entities/message";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createUserId } from "@mailcal/domain/value-objects/ids";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  mailboxAgentViewer,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";
import { createListMessagesUseCase } from "./messages";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

describe("drafts", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: domainId,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "tok",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  });

  test("a saved draft has DRAFT status and nothing is delivered", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "WIP",
      text: "half-written",
    });
    expect(draft.status).toBe(MailStatus.Draft);
    expect(fake.mailSender.sent).toHaveLength(0);
    expect(fake.messageStores.messages.get(draft.id)?.status).toBe(
      MailStatus.Draft,
    );
  });

  test("saving with draftId updates in place, including recipients", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const first = await save(adminViewer(), {
      from: "support@example.com",
      to: ["a@other.com"],
      subject: "v1",
      text: "one",
    });
    const second = await save(adminViewer(), {
      draftId: first.id,
      from: "support@example.com",
      to: ["b@other.com"],
      subject: "v2",
      text: "two",
    });
    expect(second.id).toBe(first.id);
    expect(second.subject).toBe("v2");
    expect(
      fake.messageStores.recipients.get(first.id)?.map((r) => r.address),
    ).toEqual(["b@other.com"]);
  });

  test("sendDraft dispatches and the row becomes the sent message", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const send = createSendDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Ready",
      text: "final",
    });
    const sent = await send(adminViewer(), draft.id);
    expect(sent.id).toBe(draft.id);
    expect(sent.status).toBe(MailStatus.Sent);
    expect(sent.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(sent.rfcMessageId).toBe(`${draft.id}@example.com`);
    expect(fake.mailSender.sent).toHaveLength(1);
    // No longer listed among drafts.
    const list = createListMessagesUseCase(fake.deps);
    const drafts = await list(adminViewer(), {
      filter: { statuses: [MailStatus.Draft] },
    });
    expect(drafts.totalCount).toBe(0);
  });

  test("a recipient-less or body-less draft refuses to send", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const send = createSendDraftUseCase(fake.deps);
    const noRecipient = await save(adminViewer(), {
      from: "support@example.com",
      subject: "no to",
      text: "body",
    });
    await expect(send(adminViewer(), noRecipient.id)).rejects.toBeInstanceOf(
      BadUserInputError,
    );
    const noBody = await save(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "no body",
    });
    await expect(send(adminViewer(), noBody.id)).rejects.toBeInstanceOf(
      BadUserInputError,
    );
  });

  test("sending an already-sent message as a draft is NOT_FOUND", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const send = createSendDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "x",
      text: "y",
    });
    await send(adminViewer(), draft.id);
    await expect(send(adminViewer(), draft.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("a key without MAIL_SEND on the sender cannot stage a draft", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    await expect(
      save(mailboxAgentViewer(domainId, "other@example.com"), {
        from: "support@example.com",
        text: "body",
      }),
    ).rejects.toThrow();
    expect(
      await save(adminViewer(), { from: "support@example.com" }),
    ).toBeDefined();
    await expect(
      save(adminViewer(), { from: "someone@unmanaged.example" }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("a MEMBER user with no matching ALLOW rule cannot stage a draft", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    await expect(
      save(memberViewer(), {
        from: "support@example.com",
        text: "body",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a VIEWER user can never stage a draft, even with a matching ALLOW rule", async () => {
    const userId = createUserId("usr-viewer-1");
    const permissions = buildMailPermissions(userId, [
      { effect: "ALLOW", domainId, addressPattern: "support@example.com" },
    ]);
    const save = createSaveDraftUseCase(fake.deps);
    await expect(
      save(viewerViewer("usr-viewer-1", permissions), {
        from: "support@example.com",
        text: "body",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("drafts never appear in a plain listing of sent mail", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    await save(adminViewer(), { from: "support@example.com", subject: "d" });
    const list = createListMessagesUseCase(fake.deps);
    const sentOnly = await list(adminViewer(), {
      filter: { statuses: [MailStatus.Sent] },
    });
    expect(sentOnly.totalCount).toBe(0);
  });
});

describe("draft reply threading", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: domainId,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "tok",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  });

  test("a reply saved as draft keeps its thread when finally sent", async () => {
    // The message being replied to.
    const parent = createInboundMessage({
      id: createMessageId("msg-parent"),
      domainId,
      threadId: createThreadId("thr-parent"),
      rfcMessageId: "parent@other.com",
      inReplyTo: null,
      references: ["root@other.com"],
      subject: "Question",
      fromAddress: createEmailAddress("customer@other.com"),
      fromName: null,
      textBody: "?",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    });
    fake.messageStores.messages.set(parent.id, parent);
    fake.messageStores.recipients.set(parent.id, []);
    fake.messageStores.messageTags.set(parent.id, new Set());

    const save = createSaveDraftUseCase(fake.deps);
    const send = createSendDraftUseCase(fake.deps);
    const draft = await save(adminViewer(), {
      from: "support@example.com",
      to: ["customer@other.com"],
      subject: "Re: Question",
      text: "Answer",
      inReplyToMessageId: parent.id,
    });
    // Same thread as the parent, references extended with its Message-ID.
    expect(draft.threadId).toBe("thr-parent");
    expect(draft.inReplyTo).toBe("parent@other.com");
    expect(draft.references).toEqual(["root@other.com", "parent@other.com"]);

    await send(adminViewer(), draft.id);
    // The built MIME carries the threading headers.
    const raw = fake.mailSender.sent[0]?.raw ?? "";
    expect(raw).toContain("In-Reply-To: <parent@other.com>");
  });
});
