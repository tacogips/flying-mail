import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  createClassificationRule,
  RuleAction,
  RuleField,
  RuleMatcher,
  setRuleEnabled,
} from "@mailcal/domain/entities/classification-rule";
import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import {
  createMessageEvent,
  MessageEventKind,
  setMessageEventCompleted,
} from "@mailcal/domain/entities/message-event";
import { createAddressPattern } from "@mailcal/domain/value-objects/address-pattern";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createClassificationRuleId,
  createDomainId,
  createMessageEventId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createClassificationRuleRepository } from "./classification-rule-repository";
import { createMessageEventRepository } from "./message-event-repository";
import { createMessageRepository } from "./message-repository";
import { createMigratedDatabase, seedDomain } from "./test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

async function seedMessage(
  db: SqlDatabase,
  id: string,
  to: string,
): Promise<void> {
  const messages = createMessageRepository(db);
  await messages.insertWithRelations({
    message: createInboundMessage({
      id: createMessageId(id),
      domainId,
      threadId: createThreadId(id),
      rfcMessageId: `${id}@other.com`,
      inReplyTo: null,
      references: [],
      subject: "s",
      fromAddress: createEmailAddress("sender@other.com"),
      fromName: null,
      textBody: null,
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: null,
    }),
    recipients: [
      {
        kind: RecipientKind.Envelope,
        address: createEmailAddress(to),
        name: null,
        position: 0,
      },
    ],
    attachments: [],
    tagIds: [],
    taggedAt: NOW,
  });
}

describe("messageEventRepository", () => {
  let db: SqlDatabase;
  let repo: ReturnType<typeof createMessageEventRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: domainId, name: "example.com" });
    await seedMessage(db, "msg-1", "support@example.com");
    await seedMessage(db, "msg-2", "billing@example.com");
    repo = createMessageEventRepository(db);
  });

  function event(id: string, messageId: string, dueAt: string | null) {
    return createMessageEvent({
      id: createMessageEventId(id),
      messageId: createMessageId(messageId),
      kind: dueAt === null ? MessageEventKind.Other : MessageEventKind.Deadline,
      dueAt,
      title: `event ${id}`,
      note: null,
      createdAt: NOW,
    });
  }

  test("round-trips and groups by message", async () => {
    await repo.save(event("e1", "msg-1", "2026-10-01T00:00:00.000Z"));
    await repo.save(event("e2", "msg-1", null));
    await repo.save(event("e3", "msg-2", "2026-09-01T00:00:00.000Z"));
    const grouped = await repo.listByMessages([
      createMessageId("msg-1"),
      createMessageId("msg-2"),
    ]);
    // Dated first, undated last.
    expect(grouped.get("msg-1")?.map((entry) => entry.id)).toEqual([
      "e1",
      "e2",
    ]);
    expect(grouped.get("msg-2")).toHaveLength(1);
    expect((await repo.findById(createMessageEventId("e1")))?.title).toBe(
      "event e1",
    );
  });

  test("agenda list: due order, completion filter, scope allowlist", async () => {
    await repo.save(event("late", "msg-1", "2026-12-01T00:00:00.000Z"));
    await repo.save(event("soon", "msg-2", "2026-09-01T00:00:00.000Z"));
    const finished = setMessageEventCompleted(
      event("done", "msg-1", "2026-08-30T00:00:00.000Z"),
      true,
      NOW,
    );
    await repo.save(finished);

    const open = await repo.list(
      { allowedPatterns: null, mailPermissionFilter: null },
      10,
    );
    expect(open.map((entry) => entry.id)).toEqual(["soon", "late"]);

    const withDone = await repo.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: null,
        includeCompleted: true,
      },
      10,
    );
    expect(withDone.map((entry) => entry.id)).toEqual(["done", "soon", "late"]);

    // A key scoped to billing@ sees only msg-2's events.
    const scoped = await repo.list(
      {
        allowedPatterns: [createAddressPattern("billing@example.com")],
        mailPermissionFilter: null,
      },
      10,
    );
    expect(scoped.map((entry) => entry.id)).toEqual(["soon"]);

    // An empty allowlist sees nothing rather than everything.
    expect(
      await repo.list({ allowedPatterns: [], mailPermissionFilter: null }, 10),
    ).toEqual([]);
  });

  test("agenda list: mailPermissionFilter scopes through the owning message", async () => {
    await repo.save(event("late", "msg-1", "2026-12-01T00:00:00.000Z"));
    await repo.save(event("soon", "msg-2", "2026-09-01T00:00:00.000Z"));

    // ADMIN baseline with a DENY on msg-1's address excludes only its event.
    const adminMinusDenied = await repo.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: {
          baseline: true,
          rules: [
            {
              effect: "DENY",
              domainId,
              addressPattern: createAddressPattern("support@example.com"),
            },
          ],
        },
      },
      10,
    );
    expect(adminMinusDenied.map((entry) => entry.id)).toEqual(["soon"]);

    // MEMBER with an ALLOW on msg-2's address sees only its event.
    const memberAllowed = await repo.list(
      {
        allowedPatterns: null,
        mailPermissionFilter: {
          baseline: false,
          rules: [
            {
              effect: "ALLOW",
              domainId,
              addressPattern: createAddressPattern("billing@example.com"),
            },
          ],
        },
      },
      10,
    );
    expect(memberAllowed.map((entry) => entry.id)).toEqual(["soon"]);

    // A non-baseline filter with zero ALLOW rules sees nothing.
    expect(
      await repo.list(
        {
          allowedPatterns: null,
          mailPermissionFilter: { baseline: false, rules: [] },
        },
        10,
      ),
    ).toEqual([]);
  });

  test("deleting the message cascades to its events", async () => {
    await repo.save(event("e1", "msg-1", null));
    const messages = createMessageRepository(db);
    await messages.delete([createMessageId("msg-1")]);
    expect(await repo.findById(createMessageEventId("e1"))).toBeNull();
  });
});

describe("classificationRuleRepository", () => {
  let db: SqlDatabase;
  let repo: ReturnType<typeof createClassificationRuleRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: domainId, name: "example.com" });
    await seedDomain(db, { id: createDomainId("dom-2"), name: "two.com" });
    repo = createClassificationRuleRepository(db);
  });

  function rule(id: string, domain: string | null, enabled = true) {
    const created = createClassificationRule({
      id: createClassificationRuleId(id),
      domainId: domain === null ? null : createDomainId(domain),
      field: RuleField.SenderDomain,
      matcher: RuleMatcher.Exact,
      pattern: "spam.example",
      action: RuleAction.Spam,
      tagId: null,
      description: null,
      createdAt: NOW,
    });
    return enabled ? created : setRuleEnabled(created, false, NOW);
  }

  test("round-trips and lists per domain including globals", async () => {
    await repo.save(rule("r-global", null));
    await repo.save(rule("r-dom1", "dom-1"));
    await repo.save(rule("r-dom2", "dom-2"));
    await repo.save(rule("r-off", "dom-1", false));

    const forDom1 = await repo.listEnabledForDomain(domainId);
    expect(forDom1.map((entry) => entry.id).sort()).toEqual([
      "r-dom1",
      "r-global",
    ]);
    expect((await repo.list()).map((entry) => entry.id)).toHaveLength(4);
    expect(
      (await repo.findById(createClassificationRuleId("r-off")))?.enabled,
    ).toBe(false);
  });

  test("deleting a domain cascades its rules but keeps globals", async () => {
    await repo.save(rule("r-global", null));
    await repo.save(rule("r-dom1", "dom-1"));
    await db.execute("DELETE FROM domains WHERE id = ?", [domainId]);
    expect((await repo.list()).map((entry) => entry.id)).toEqual(["r-global"]);
  });
});
