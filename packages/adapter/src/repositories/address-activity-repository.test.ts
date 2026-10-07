import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMessageRepository } from "./message-repository";
import {
  createMigratedDatabase,
  SYSTEM_TAG_IDS,
  seedDomain,
  seedMailAddress,
} from "./test-support";

const NOW = "2026-10-07T00:00:00.000Z";

describe("message repository address activity", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMessageRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: "dom-a", name: "alpha.example" });
    await seedDomain(db, { id: "dom-b", name: "beta.example" });
    await seedMailAddress(db, {
      id: "addr-a",
      domainId: "dom-a",
      localPart: "ada",
      address: "ada@alpha.example",
    });
    await seedMailAddress(db, {
      id: "addr-b",
      domainId: "dom-b",
      localPart: "bob",
      address: "bob@beta.example",
    });
    repository = createMessageRepository(db);
  });

  async function message(options: {
    readonly id: string;
    readonly domainId?: string;
    readonly direction: "INBOUND" | "OUTBOUND";
    readonly from: string;
    readonly occurredAt: string;
    readonly readAt?: string | null;
    readonly status?: "DRAFT" | "SENT" | "RECEIVED";
    readonly spam?: boolean;
    readonly trash?: boolean;
    readonly envelope?: string;
  }): Promise<void> {
    const domainId = options.domainId ?? "dom-a";
    await db.execute(
      `INSERT INTO messages
        (id, domain_id, direction, thread_id, subject, from_address, snippet,
         status, delivery_status, read_at, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, '', ?, 'RECEIVED', ?, ?, ?, ?)`,
      [
        options.id,
        domainId,
        options.direction,
        `thread-${options.id}`,
        options.from,
        options.status ??
          (options.direction === "OUTBOUND" ? "SENT" : "RECEIVED"),
        options.readAt ?? null,
        options.occurredAt,
        NOW,
        NOW,
      ],
    );
    if (options.envelope !== undefined) {
      await db.execute(
        `INSERT INTO message_recipients (message_id, kind, address, name, position)
         VALUES (?, 'ENVELOPE', ?, NULL, 0)`,
        [options.id, options.envelope],
      );
    }
    if (options.spam === true) {
      await db.execute(
        "INSERT INTO message_spam (message_id, score, marked_by, marked_at) VALUES (?, 5, 'SYSTEM', ?)",
        [options.id, NOW],
      );
    }
    if (options.trash === true) {
      await db.execute(
        "INSERT INTO message_tags (message_id, tag_id, tagged_at) VALUES (?, ?, ?)",
        [options.id, SYSTEM_TAG_IDS.trash, NOW],
      );
    }
  }

  test("aggregates latest sent and delivered activity and unread mail once", async () => {
    await message({
      id: "sent-old",
      direction: "OUTBOUND",
      from: "ada@alpha.example",
      occurredAt: "2026-10-01T00:00:00.000Z",
    });
    await message({
      id: "sent-draft",
      direction: "OUTBOUND",
      from: "ada@alpha.example",
      occurredAt: "2026-10-06T00:00:00.000Z",
      status: "DRAFT",
    });
    await message({
      id: "received-new",
      direction: "INBOUND",
      from: "sender@example.net",
      envelope: "ada@alpha.example",
      occurredAt: "2026-10-05T00:00:00.000Z",
    });
    await message({
      id: "received-read",
      direction: "INBOUND",
      from: "sender@example.net",
      envelope: "ada@alpha.example",
      occurredAt: "2026-10-04T00:00:00.000Z",
      readAt: NOW,
    });
    await message({
      id: "received-spam",
      direction: "INBOUND",
      from: "sender@example.net",
      envelope: "ada@alpha.example",
      occurredAt: "2026-10-03T00:00:00.000Z",
      spam: true,
    });
    await message({
      id: "received-trash",
      direction: "INBOUND",
      from: "sender@example.net",
      envelope: "ada@alpha.example",
      occurredAt: "2026-10-02T00:00:00.000Z",
      trash: true,
    });

    const query = vi.spyOn(db, "query");
    const result = await repository.listAddressActivity([
      {
        address: createEmailAddress("ada@alpha.example"),
        domainId: createDomainId("dom-a"),
      },
      {
        address: createEmailAddress("bob@beta.example"),
        domainId: createDomainId("dom-b"),
      },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        address: createEmailAddress("ada@alpha.example"),
        domainId: createDomainId("dom-a"),
        lastActivityAt: "2026-10-05T00:00:00.000Z",
        unreadCount: 1,
      },
      {
        address: createEmailAddress("bob@beta.example"),
        domainId: createDomainId("dom-b"),
        lastActivityAt: null,
        unreadCount: 0,
      },
    ]);
  });

  test("scopes activity and unread counts to matching domain and envelope", async () => {
    await message({
      id: "wrong-domain",
      domainId: "dom-b",
      direction: "INBOUND",
      from: "sender@example.net",
      envelope: "ada@alpha.example",
      occurredAt: "2026-10-06T00:00:00.000Z",
    });
    await message({
      id: "header-only",
      direction: "INBOUND",
      from: "sender@example.net",
      occurredAt: "2026-10-05T00:00:00.000Z",
    });
    const result = await repository.listAddressActivity([
      {
        address: createEmailAddress("ada@alpha.example"),
        domainId: createDomainId("dom-a"),
      },
    ]);
    expect(result[0]).toMatchObject({ lastActivityAt: null, unreadCount: 0 });
  });

  test("supports more than fifty readable addresses with one bound parameter", async () => {
    const addresses = Array.from({ length: 60 }, (_, index) => ({
      address: createEmailAddress(`user${index}@alpha.example`),
      domainId: createDomainId("dom-a"),
    }));
    const query = vi.spyOn(db, "query");

    const result = await repository.listAddressActivity(addresses);

    expect(result).toHaveLength(60);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toHaveLength(1);
  });

  test("uses the address activity index for outbound MAX lookups", async () => {
    const plan = await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT MAX(occurred_at) FROM messages
       WHERE domain_id = ? AND direction = 'OUTBOUND'
         AND status <> 'DRAFT' AND from_address = ?`,
      ["dom-a", "ada@alpha.example"],
    );

    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "idx_messages_from_activity",
    );
  });
});
