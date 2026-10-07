import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import {
  createInboundMessage,
  createOutboundMessage,
} from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { DuplicateMessageError } from "@flying-mail/application/ports/message-repository";
import { beforeEach, describe, expect, test } from "vitest";
import { createMessageRepository } from "../repositories/message-repository";
import {
  createMigratedDatabase,
  seedDomain,
} from "../repositories/test-support";

const NOW = "2026-08-24T00:00:00.000Z";
const DOMAIN_A = createDomainId("dom-a");
const DOMAIN_B = createDomainId("dom-b");

function message(
  id: string,
  domainId: string,
  direction: "INBOUND" | "OUTBOUND",
) {
  const input = {
    id: createMessageId(id),
    domainId: createDomainId(domainId),
    threadId: createThreadId(id),
    rfcMessageId: "same@example.net",
    inReplyTo: null,
    references: [],
    subject: id,
    fromAddress: createEmailAddress("sender@example.net"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: `raw/${id}`,
    rawSize: 4,
    occurredAt: NOW,
    createdAt: NOW,
  } as const;
  return direction === "INBOUND"
    ? createInboundMessage({ ...input, spamScore: null })
    : createOutboundMessage(input);
}

async function insert(
  db: SqlDatabase,
  id: string,
  domainId: string,
  direction: "INBOUND" | "OUTBOUND",
): Promise<void> {
  await createMessageRepository(db).insertWithRelations({
    message: message(id, domainId, direction),
    recipients: [],
    attachments: [],
    tagIds: [],
    taggedAt: NOW,
  });
}

describe("0013_webmail_completion.sql", () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: DOMAIN_A, name: "a.example" });
    await seedDomain(db, { id: DOMAIN_B, name: "b.example" });
  });

  test("adds reply/forward columns and blob-key index", async () => {
    const columns = await db.query<{ name: string }>(
      "PRAGMA table_info(messages)",
    );
    expect(columns.map(({ name }) => name)).toContain("reply_to");
    expect(columns.map(({ name }) => name)).toContain(
      "forwarded_from_message_id",
    );
    const indexes = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    );
    expect(indexes.map(({ name }) => name)).toContain(
      "idx_attachments_blob_key",
    );
  });

  test("uniqueness is scoped by direction and recipient domain", async () => {
    await insert(db, "in-a", DOMAIN_A, "INBOUND");
    await insert(db, "in-b", DOMAIN_B, "INBOUND");
    await insert(db, "out-a", DOMAIN_A, "OUTBOUND");
    await expect(
      insert(db, "duplicate", DOMAIN_A, "INBOUND"),
    ).rejects.toBeInstanceOf(DuplicateMessageError);
  });
});
