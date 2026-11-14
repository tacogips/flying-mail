import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  createInboundMessage,
  type Message,
  type MessageRecipient,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMessageRepository } from "./message-repository";
import { createMigratedDatabase, seedDomain } from "./test-support";

/** Split out of `message-repository.test.ts` (which was pushing 1000+
 * lines) -- covers `MessageListFilter.mailPermissionFilter`, the
 * interactive-user mailbox-rule scoping added alongside the pre-existing
 * `allowedPatterns` API-key scope allowlist. See that file for the general
 * listing/filtering coverage this complements. */

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const otherDomainId = createDomainId("dom-2");

function buildMessage(options: {
  readonly id: string;
  readonly occurredAt: string;
  readonly domainId: string;
}): Message {
  return createInboundMessage({
    id: createMessageId(options.id),
    domainId: createDomainId(options.domainId),
    threadId: createThreadId(options.id),
    rfcMessageId: `${options.id}@other.com`,
    inReplyTo: null,
    references: [],
    subject: `Subject ${options.id}`,
    fromAddress: createEmailAddress("sender@other.com"),
    fromName: null,
    textBody: "body text",
    htmlBody: null,
    rawKey: `raw/${options.id}.eml`,
    rawSize: 100,
    occurredAt: options.occurredAt,
    createdAt: options.occurredAt,
    spamScore: null,
  });
}

function envelopeTo(address: string): readonly MessageRecipient[] {
  return [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(address),
      name: null,
      position: 0,
    },
  ];
}

const UNRESTRICTED = {
  allowedPatterns: null,
  mailPermissionFilter: null,
} as const;

describe("messageRepository: mailPermissionFilter (user mailbox rules)", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMessageRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: domainId, name: "example.com" });
    await seedDomain(db, { id: otherDomainId, name: "other-domain.com" });
    repository = createMessageRepository(db);

    // Domain A: wildcard-pattern rule; Domain B: exact-address rule. The
    // exact address that Domain B's rule matches is deliberately also used
    // in Domain A, so a cross-product bug (splitting the rule's domain from
    // its pattern) would show up as a false positive there.
    await repository.insertWithRelations({
      message: buildMessage({
        id: "msg-a-wild",
        occurredAt: "2026-08-23T01:00:00.000Z",
        domainId,
      }),
      recipients: envelopeTo("anything@example.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
    await repository.insertWithRelations({
      message: buildMessage({
        id: "msg-a-crossproduct",
        occurredAt: "2026-08-23T02:00:00.000Z",
        domainId,
      }),
      recipients: envelopeTo("exact@other-domain.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
    await repository.insertWithRelations({
      message: buildMessage({
        id: "msg-b-exact",
        occurredAt: "2026-08-23T03:00:00.000Z",
        domainId: otherDomainId,
      }),
      recipients: envelopeTo("exact@other-domain.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
    await repository.insertWithRelations({
      message: buildMessage({
        id: "msg-b-nomatch",
        occurredAt: "2026-08-23T04:00:00.000Z",
        domainId: otherDomainId,
      }),
      recipients: envelopeTo("random@other-domain.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
  });

  test("each rule's own domain/pattern pairing is enforced -- no cross-product", async () => {
    const page = await repository.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: {
          baseline: false,
          rules: [
            {
              effect: "ALLOW",
              domainId,
              addressPattern: MATCH_ALL_ADDRESSES,
            },
            {
              effect: "ALLOW",
              domainId: otherDomainId,
              addressPattern: createAddressPattern("exact@other-domain.com"),
            },
          ],
        },
      },
      10,
      null,
    );
    // Domain A: everything (its own wildcard rule), including the address
    // that only Domain B's rule literally matches.
    // Domain B: only the exact-address match, not the unrelated address.
    expect(page.nodes.map((message) => message.id).sort()).toEqual(
      ["msg-a-crossproduct", "msg-a-wild", "msg-b-exact"].sort(),
    );
  });

  test("ADMIN baseline with a DENY rule excludes only the denied address", async () => {
    const page = await repository.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: {
          baseline: true,
          rules: [
            {
              effect: "DENY",
              domainId: otherDomainId,
              addressPattern: createAddressPattern("exact@other-domain.com"),
            },
          ],
        },
      },
      10,
      null,
    );
    expect(page.nodes.map((message) => message.id).sort()).toEqual(
      ["msg-a-crossproduct", "msg-a-wild", "msg-b-nomatch"].sort(),
    );
  });

  test("a non-baseline filter with zero ALLOW rules returns an empty page", async () => {
    const page = await repository.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: { baseline: false, rules: [] },
      },
      10,
      null,
    );
    expect(page.nodes).toEqual([]);
    expect(page.totalCount).toBe(0);
  });

  test("mailPermissionFilter: null behaves exactly as before (unrestricted)", async () => {
    const page = await repository.list(UNRESTRICTED, 10, null);
    expect(page.nodes.map((message) => message.id).sort()).toEqual(
      [
        "msg-a-crossproduct",
        "msg-a-wild",
        "msg-b-exact",
        "msg-b-nomatch",
      ].sort(),
    );
  });
});
