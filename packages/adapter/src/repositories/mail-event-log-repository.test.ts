import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createDomainId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { createMailEventLogRepository } from "./mail-event-log-repository";
import { createMigratedDatabase } from "./test-support";

const firstEvent = {
  type: MailEventType.MessageReceived,
  messageId: createMessageId("msg-one"),
  domainId: createDomainId("dom-one"),
  addresses: [" B@example.com", "a@example.com", "b@example.com"],
} as const;

describe("mail event log repository", () => {
  test("assigns increasing sequence numbers and lists in sequence order", async () => {
    const repository = createMailEventLogRepository(
      await createMigratedDatabase(),
    );
    const timing = {
      occurredAt: "2026-08-23T00:00:00.000Z",
      retentionCutoff: "2026-08-16T00:00:00.000Z",
    };
    await repository.append([firstEvent], timing);
    await repository.append(
      [{ ...firstEvent, messageId: createMessageId("msg-two") }],
      timing,
    );
    await repository.append(
      [{ ...firstEvent, messageId: createMessageId("msg-three") }],
      timing,
    );

    const records = await repository.listAfter(0, 2);
    expect(records.map((record) => record.seq)).toEqual([1, 2]);
    expect(records.map((record) => record.messageId)).toEqual([
      "msg-one",
      "msg-two",
    ]);
    expect(records[0]?.addresses).toEqual(["a@example.com", "b@example.com"]);
  });

  test("returns seeded log state with a 16-hex epoch on an empty log", async () => {
    const repository = createMailEventLogRepository(
      await createMigratedDatabase(),
    );
    const state = await repository.state();
    expect(state).toMatchObject({ prunedThroughSeq: 0, headSeq: 0 });
    expect(state.epoch).toMatch(/^[0-9a-f]{16}$/);
  });

  test("prunes expired rows through the watermark and preserves newer sequence rows", async () => {
    const repository = createMailEventLogRepository(
      await createMigratedDatabase(),
    );
    await repository.append([firstEvent], {
      occurredAt: "2026-08-22T00:00:00.000Z",
      retentionCutoff: "2026-08-23T00:00:00.000Z",
    });
    await repository.append(
      [{ ...firstEvent, messageId: createMessageId("msg-new") }],
      {
        occurredAt: "2026-08-24T00:00:00.000Z",
        retentionCutoff: "2026-08-23T00:00:00.000Z",
      },
    );

    const state = await repository.state();
    expect(state.prunedThroughSeq).toBe(1);
    expect(
      (await repository.listAfter(0, 10)).map((record) => record.seq),
    ).toEqual([2]);
  });

  test("an empty append does not touch an uninitialized database", async () => {
    const db = await createMigratedDatabase();
    const repository = createMailEventLogRepository(db);
    await repository.append([], {
      occurredAt: "2026-08-23T00:00:00.000Z",
      retentionCutoff: "2026-08-16T00:00:00.000Z",
    });
    expect((await repository.state()).headSeq).toBe(0);
  });

  test("maps malformed stored address JSON to an empty address list", async () => {
    const db = await createMigratedDatabase();
    const repository = createMailEventLogRepository(db);
    await db.execute(
      `INSERT INTO mail_events (type, message_id, domain_id, addresses, occurred_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        firstEvent.type,
        firstEvent.messageId,
        firstEvent.domainId,
        "{not json",
        "2026-08-23T00:00:00.000Z",
      ],
    );
    expect((await repository.listAfter(0, 1))[0]?.addresses).toEqual([]);
  });
});
