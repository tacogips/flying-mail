import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { DuplicateMessageError } from "@flying-mail/application/ports/message-repository";
import {
  createAttachment,
  AttachmentKind,
} from "@flying-mail/domain/entities/attachment";
import {
  createDraftMessage,
  createInboundMessage,
  createOutboundMessage,
  type Message,
  MailStatus,
} from "@flying-mail/domain/entities/message";
import type { Attachment } from "@flying-mail/domain/entities/attachment";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMessageRepository } from "./message-repository";
import { createMigratedDatabase, seedDomain } from "./test-support";

const NOW = "2026-08-24T00:00:00.000Z";
const DOMAIN_A = createDomainId("dom-a");
const DOMAIN_B = createDomainId("dom-b");

function buildMessage(options: {
  id: string;
  domainId?: string;
  rfcMessageId?: string;
  status?: "draft";
  direction?: "INBOUND" | "OUTBOUND";
}) {
  const input = {
    id: createMessageId(options.id),
    domainId: createDomainId(options.domainId ?? DOMAIN_A),
    threadId: createThreadId(options.id),
    rfcMessageId: options.rfcMessageId ?? "shared@example.net",
    inReplyTo: null,
    references: [],
    subject: options.id,
    fromAddress: createEmailAddress("sender@example.net"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: `raw/${options.id}`,
    rawSize: 4,
    occurredAt: NOW,
    createdAt: NOW,
  };
  return options.status === "draft"
    ? createDraftMessage(input)
    : options.direction === "OUTBOUND"
      ? createOutboundMessage(input)
      : createInboundMessage({ ...input, spamScore: null });
}

let db: SqlDatabase;
let repository: ReturnType<typeof createMessageRepository>;

async function insert(
  message: Message,
  attachments: readonly Attachment[] = [],
) {
  await repository.insertWithRelations({
    message,
    recipients: [],
    attachments,
    tagIds: [],
    taggedAt: NOW,
  });
}

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: DOMAIN_A, name: "a.example" });
  await seedDomain(db, { id: DOMAIN_B, name: "b.example" });
  repository = createMessageRepository(db);
});

describe("webmail message repository operations", () => {
  test("inbound RFC lookup ignores outbound rows and other domains", async () => {
    await insert(buildMessage({ id: "out", direction: "OUTBOUND" }));
    await insert(buildMessage({ id: "in-a", domainId: DOMAIN_A }));
    await insert(buildMessage({ id: "in-b", domainId: DOMAIN_B }));
    const found = await repository.findInboundByRfcMessageId(
      "shared@example.net",
      DOMAIN_B,
    );
    expect(found?.id).toBe(createMessageId("in-b"));
  });

  test("envelope insert is idempotent and appends after existing envelope rows", async () => {
    const message = buildMessage({ id: "env" });
    await insert(message);
    await repository.addEnvelopeRecipient(
      message.id,
      createEmailAddress("one@a.example"),
    );
    await repository.addEnvelopeRecipient(
      message.id,
      createEmailAddress("two@a.example"),
    );
    await repository.addEnvelopeRecipient(
      message.id,
      createEmailAddress("one@a.example"),
    );
    const recipients = await repository.listRecipients([message.id]);
    expect(recipients.get(message.id)).toMatchObject([
      { address: "one@a.example", position: 0 },
      { address: "two@a.example", position: 1 },
    ]);
  });

  test("conditional save and claim only update a draft once", async () => {
    const draft = buildMessage({ id: "draft", status: "draft" });
    await insert(draft);
    expect(await repository.saveIfDraft({ ...draft, subject: "updated" })).toBe(
      true,
    );
    const updated = await repository.findById(draft.id);
    expect(updated?.subject).toBe("updated");
    if (updated === null) {
      throw new Error("Saved draft was not found");
    }
    const sent = { ...updated, status: MailStatus.Sent };
    expect(await repository.saveIfDraft(sent)).toBe(true);
    expect(await repository.saveIfDraft(sent)).toBe(false);
    expect((await repository.findById(draft.id))?.status).toBe(MailStatus.Sent);
  });

  test("draft deletion refuses non-drafts", async () => {
    const message = buildMessage({ id: "received" });
    await insert(message);
    expect(await repository.deleteDraftIfDraft(message.id)).toBe(false);
    expect(await repository.findById(message.id)).not.toBeNull();
  });

  test("blob reference counts include shared rows and zero-count keys", async () => {
    const message = buildMessage({ id: "attachments" });
    const attachments = ["one", "two"].map((id) =>
      createAttachment({
        id: createAttachmentId(id),
        messageId: message.id,
        fileName: `${id}.txt`,
        contentType: "text/plain",
        size: 1,
        blobKey: "shared/blob",
        contentId: null,
        inline: false,
        kind: AttachmentKind.Text,
        createdAt: NOW,
      }),
    );
    await insert(message, attachments);
    const counts = await repository.countAttachmentsByBlobKeys([
      "shared/blob",
      "missing/blob",
    ]);
    expect(counts.get("shared/blob")).toBe(2);
    expect(counts.get("missing/blob")).toBe(0);
  });

  test("duplicate inbound tuple maps to DuplicateMessageError", async () => {
    await insert(buildMessage({ id: "first" }));
    await expect(insert(buildMessage({ id: "second" }))).rejects.toBeInstanceOf(
      DuplicateMessageError,
    );
  });

  test("save persists a newly assigned RFC Message-ID", async () => {
    const message = buildMessage({
      id: "save",
      rfcMessageId: "before@example.net",
    });
    await insert(message);
    await repository.save({ ...message, rfcMessageId: "after@example.net" });
    expect((await repository.findById(message.id))?.rfcMessageId).toBe(
      "after@example.net",
    );
  });
});
