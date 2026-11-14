import type {
  Message,
  MessageRecipient,
} from "@flying-mail/domain/entities/message";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@flying-mail/domain/value-objects/address-pattern";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMessageRepository } from "./message-repository";
import { createMigratedDatabase, seedDomain } from "./test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const T_ID = createDomainId("dom-t");
const M_ID = createDomainId("dom-m");

function buildMessage(
  id: string,
  domainId: ReturnType<typeof createDomainId>,
): Message {
  return createInboundMessage({
    id: createMessageId(id),
    domainId,
    threadId: createThreadId("shared-thread"),
    rfcMessageId: "shared@outside.example",
    inReplyTo: null,
    references: [],
    subject: "Shared delivery",
    fromAddress: createEmailAddress("sender@outside.example"),
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

function envelope(address: string): readonly MessageRecipient[] {
  return [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(address),
      name: null,
      position: 0,
    },
  ];
}

describe("messageRepository multi-domain inbound copies", () => {
  let repository: ReturnType<typeof createMessageRepository>;

  beforeEach(async () => {
    const db = await createMigratedDatabase();
    await seedDomain(db, { id: T_ID, name: "tacoserve.online" });
    await seedDomain(db, { id: M_ID, name: "mutvar-test.online" });
    repository = createMessageRepository(db);
    await repository.insertWithRelations({
      message: buildMessage("inbound-t", T_ID),
      recipients: envelope("alice@tacoserve.online"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
    await repository.insertWithRelations({
      message: buildMessage("inbound-m", M_ID),
      recipients: envelope("bob@mutvar-test.online"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
  });

  test("domain filters return the matching copy of a shared Message-ID", async () => {
    const tPage = await repository.list(
      { allowedPatterns: null, mailPermissionFilter: null, domainIds: [T_ID] },
      10,
      null,
    );
    const mPage = await repository.list(
      { allowedPatterns: null, mailPermissionFilter: null, domainIds: [M_ID] },
      10,
      null,
    );
    expect(tPage.nodes.map((message) => message.id)).toEqual(["inbound-t"]);
    expect(mPage.nodes.map((message) => message.id)).toEqual(["inbound-m"]);
  });

  test("an M-domain ALLOW sees its copy and a T-domain DENY does not hide it", async () => {
    const page = await repository.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: {
          baseline: false,
          rules: [
            {
              effect: "ALLOW",
              domainId: M_ID,
              addressPattern: createAddressPattern("bob@mutvar-test.online"),
            },
            {
              effect: "DENY",
              domainId: T_ID,
              addressPattern: MATCH_ALL_ADDRESSES,
            },
          ],
        },
      },
      10,
      null,
    );
    expect(page.nodes.map((message) => message.id)).toEqual(["inbound-m"]);
  });
});
