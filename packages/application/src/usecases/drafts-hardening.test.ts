import { Capability } from "@flying-mail/domain/entities/api-key";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  MailStatus,
  type MessageRecipient,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { BadUserInputError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, apiKeyViewer } from "../test-support/viewer-fixtures";
import { createDeleteDraftUseCase } from "./delete-draft";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";
import {
  createGetMessageUseCase,
  createGetThreadUseCase,
  createListMessagesUseCase,
} from "./messages";
import { MAX_RECIPIENTS_PER_MESSAGE } from "./send";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

function addresses(count: number, prefix: string): readonly string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}@other.com`);
}

describe("draft hardening", () => {
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

  describe("recipient cap", () => {
    test("saving a draft with more than the cap in total is rejected", async () => {
      const save = createSaveDraftUseCase(fake.deps);
      await expect(
        save(adminViewer(), {
          from: "support@example.com",
          to: addresses(30, "to"),
          cc: addresses(15, "cc"),
          bcc: addresses(MAX_RECIPIENTS_PER_MESSAGE - 45 + 1, "bcc"),
          subject: "Too many",
        }),
      ).rejects.toBeInstanceOf(BadUserInputError);
      expect(fake.messageStores.messages.size).toBe(0);
    });

    test("exactly the cap is accepted", async () => {
      const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: addresses(MAX_RECIPIENTS_PER_MESSAGE, "to"),
        subject: "At the cap",
      });
      expect(draft.status).toBe(MailStatus.Draft);
    });

    test("sending a stored draft re-checks the recipient count", async () => {
      const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["a@other.com"],
        subject: "Sneaky",
        text: "body",
      });
      // Simulates a row that predates the cap.
      const oversized: MessageRecipient[] = addresses(
        MAX_RECIPIENTS_PER_MESSAGE + 1,
        "r",
      ).map((address, position) => ({
        kind: RecipientKind.To,
        address: createEmailAddress(address),
        name: null,
        position,
      }));
      fake.messageStores.recipients.set(draft.id, oversized);

      await expect(
        createSendDraftUseCase(fake.deps)(adminViewer(), draft.id),
      ).rejects.toBeInstanceOf(BadUserInputError);
      expect(fake.mailSender.sent).toHaveLength(0);
      expect(fake.messageStores.messages.get(draft.id)?.status).toBe(
        MailStatus.Draft,
      );
    });
  });

  describe("event addresses", () => {
    test("draft saved, updated and deleted events carry the sender only", async () => {
      const save = createSaveDraftUseCase(fake.deps);
      const draft = await save(adminViewer(), {
        from: "support@example.com",
        to: ["customer@other.com"],
        bcc: ["secret@other.com"],
        subject: "Private",
        text: "body",
      });
      await save(adminViewer(), {
        draftId: draft.id,
        from: "support@example.com",
        to: ["customer@other.com"],
        bcc: ["secret@other.com"],
        subject: "Private v2",
        text: "body",
      });
      await createDeleteDraftUseCase(fake.deps)(adminViewer(), draft.id);

      const records = fake.fakeMailEventLog.records();
      expect(records.map((record) => record.type)).toEqual([
        MailEventType.DraftSaved,
        MailEventType.DraftSaved,
        MailEventType.DraftDeleted,
      ]);
      for (const record of records) {
        expect(record.addresses).toEqual(["support@example.com"]);
      }
    });

    test("a sent message event still carries every recipient", async () => {
      const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["customer@other.com"],
        subject: "Public now",
        text: "body",
      });
      await createSendDraftUseCase(fake.deps)(adminViewer(), draft.id);
      expect(fake.fakeMailEventLog.records().at(-1)).toMatchObject({
        type: MailEventType.MessageSent,
        addresses: ["customer@other.com", "support@example.com"],
      });
    });
  });

  describe("draft privacy on the read path", () => {
    const recipientReader = apiKeyViewer(
      [
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "customer@example.com",
        },
      ],
      "key-recipient",
    );
    const senderAgent = apiKeyViewer(
      [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
        {
          capability: Capability.MailSend,
          domainId,
          addressPattern: "support@example.com",
        },
      ],
      "key-sender",
    );

    async function seedDraftToInternalRecipient() {
      return createSaveDraftUseCase(fake.deps)(adminViewer(), {
        from: "support@example.com",
        to: ["customer@example.com"],
        subject: "Unsent",
        text: "body",
      });
    }

    test("a reader of a recipient mailbox cannot open someone else's draft", async () => {
      const draft = await seedDraftToInternalRecipient();
      const get = createGetMessageUseCase(fake.deps);

      await expect(get(recipientReader, draft.id)).resolves.toBeNull();
      await expect(get(senderAgent, draft.id)).resolves.toMatchObject({
        id: draft.id,
      });
      await expect(get(adminViewer(), draft.id)).resolves.toMatchObject({
        id: draft.id,
      });
    });

    test("getThread hides the draft from a recipient-only reader", async () => {
      const draft = await seedDraftToInternalRecipient();
      const thread = createGetThreadUseCase(fake.deps);

      await expect(thread(recipientReader, draft.threadId)).resolves.toBeNull();
      const visible = await thread(senderAgent, draft.threadId);
      expect(visible?.messages.map((message) => message.id)).toEqual([
        draft.id,
      ]);
    });

    test("listings drop drafts the viewer could not open directly", async () => {
      const draft = await seedDraftToInternalRecipient();
      const list = createListMessagesUseCase(fake.deps);

      const hidden = await list(recipientReader, {});
      expect(hidden.nodes.map((message) => message.id)).not.toContain(draft.id);
      const shown = await list(senderAgent, {});
      expect(shown.nodes.map((message) => message.id)).toContain(draft.id);
    });
  });
});
