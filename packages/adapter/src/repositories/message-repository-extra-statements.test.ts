import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createExternalMailAccount } from "@flying-mail/domain/entities/external-mail-account";
import { createInboundMessage } from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createExternalAccountId,
  createMailAddressId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createExternalMailAccountRepository } from "./external-mail-account-repository";
import { createExternalMessageStateRepository } from "./external-message-state-repository";
import { createMessageRepository } from "./message-repository";
import {
  createMigratedDatabase,
  seedDomain,
  seedMailAddress,
} from "./test-support";

/** `insertWithRelations`' `extraStatements` is what lets the external-mail
 * dedupe ledger write land in the same atomic `batch()` call as the message
 * insert (see `external-mail-repository.ts` `buildSaveStatement`). These
 * tests exercise that batching directly, kept separate from
 * `message-repository.test.ts` so that already-substantial file does not
 * grow further. */

const NOW = "2026-08-24T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-1");
const ACCOUNT_ID = createExternalAccountId("acc-1");

let db: SqlDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: DOMAIN_ID, name: "example.com" });
  await seedMailAddress(db, {
    id: createMailAddressId("addr-1"),
    domainId: DOMAIN_ID,
    localPart: "support",
    address: "support@example.com",
  });
  await createExternalMailAccountRepository(db).save(
    createExternalMailAccount({
      id: ACCOUNT_ID,
      mailAddressId: createMailAddressId("addr-1"),
      externalAddress: createEmailAddress("taco@gmail.com"),
      fetch: {
        kind: "JMAP",
        sessionUrl: "https://api.fastmail.com/jmap/session",
        username: "taco@fastmail.com",
        passwordCiphertext: "cipher-1",
      },
      createdAt: NOW,
    }),
  );
});

function buildMessage(id: string) {
  return createInboundMessage({
    id: createMessageId(id),
    domainId: DOMAIN_ID,
    threadId: createThreadId(id),
    rfcMessageId: `${id}@remote.example`,
    inReplyTo: null,
    references: [],
    subject: `Subject ${id}`,
    fromAddress: createEmailAddress("sender@remote.example"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: `raw/${id}.eml`,
    rawSize: 10,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
  });
}

describe("insertWithRelations extraStatements batching", () => {
  test("an extraStatements entry lands in the same batch() call as the message", async () => {
    const messages = createMessageRepository(db);
    const states = createExternalMessageStateRepository(db);
    const message = buildMessage("msg-1");

    await messages.insertWithRelations({
      message,
      recipients: [],
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
      extraStatements: [
        states.buildSaveStatement({
          accountId: ACCOUNT_ID,
          remoteId: "remote-1",
          messageId: message.id,
          fetchedAt: NOW,
        }),
      ],
    });

    expect(await messages.findById(message.id)).not.toBeNull();
    expect(await states.find(ACCOUNT_ID, "remote-1")).toMatchObject({
      messageId: message.id,
    });
  });

  test("a forced failure in an extra statement rolls back the message insert too", async () => {
    const messages = createMessageRepository(db);
    const message = buildMessage("msg-2");

    await expect(
      messages.insertWithRelations({
        message,
        recipients: [],
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
        extraStatements: [
          {
            // A non-existent account_id violates the foreign key on
            // external_message_states, forcing the whole batch() to fail.
            sql: `INSERT INTO external_message_states
                    (account_id, remote_id, message_id, fetched_at)
                  VALUES (?, ?, ?, ?)`,
            params: ["acc-does-not-exist", "remote-x", message.id, NOW],
          },
        ],
      }),
    ).rejects.toThrow();

    expect(await messages.findById(message.id)).toBeNull();
  });

  test("an omitted extraStatements behaves exactly as before", async () => {
    const messages = createMessageRepository(db);
    const message = buildMessage("msg-3");

    await messages.insertWithRelations({
      message,
      recipients: [],
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });

    expect(await messages.findById(message.id)).not.toBeNull();
  });
});
