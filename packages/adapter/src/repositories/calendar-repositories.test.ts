import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type CalendarEvent,
  createCalendarEvent,
} from "@mailcal/domain/entities/calendar-event";
import {
  type AttachmentId,
  type CalendarEventId,
  createAttachmentId,
  createCaldavAccountId,
  createCaldavCalendarId,
  createCalendarEventId,
  createCalendarId,
  createEventLinkId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { createIsoDate } from "@mailcal/domain/value-objects/iso-date";
import { createRecurrenceRule } from "@mailcal/domain/value-objects/recurrence";
import { createTimeZoneId } from "@mailcal/domain/value-objects/time-zone";
import { beforeEach, describe, expect, test } from "vitest";
import { createCaldavAccountRepository } from "./caldav-account-repository";
import { createCalendarEventRepository } from "./calendar-event-repository";
import { createCalendarRepository } from "./calendar-repository";
import { createMigratedDatabase, seedUser } from "./test-support";

const OWNER = createUserId("usr-owner");
const CALENDAR_ID = createCalendarId("cal-1");
const OTHER_CALENDAR_ID = createCalendarId("cal-2");
const TOKYO = createTimeZoneId("Asia/Tokyo");
const NOW = "2026-08-24T00:00:00.000Z";

let db: SqlDatabase;

async function seedCalendars(): Promise<void> {
  const calendars = createCalendarRepository(db);
  for (const [id, name] of [
    [CALENDAR_ID, "Work"],
    [OTHER_CALENDAR_ID, "Personal"],
  ] as const) {
    await calendars.save({
      id,
      ownerUserId: OWNER,
      name,
      color: "#3b82f6",
      description: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}

function timedEvent(
  id: string,
  startIso: string,
  endIso: string,
  overrides: Partial<Parameters<typeof createCalendarEvent>[0]> = {},
): CalendarEvent {
  return createCalendarEvent({
    id: createCalendarEventId(id),
    calendarId: CALENDAR_ID,
    uid: `${id}@mailcal`,
    title: `Event ${id}`,
    time: {
      kind: "TIMED",
      startsAt: Date.parse(startIso),
      endsAt: Date.parse(endIso),
      timeZone: TOKYO,
    },
    createdAt: NOW,
    ...overrides,
  });
}

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedUser(db, { id: OWNER, email: "owner@example.com" });
  await seedCalendars();
});

describe("calendar repository", () => {
  test("saves, reads, updates and lists calendars", async () => {
    const repository = createCalendarRepository(db);
    const found = await repository.findById(CALENDAR_ID);
    expect(found?.name).toBe("Work");

    await repository.save({
      id: CALENDAR_ID,
      ownerUserId: OWNER,
      name: "Work renamed",
      color: "#ff0000",
      description: "Team calendar",
      createdAt: NOW,
      updatedAt: "2026-08-25T00:00:00.000Z",
    });
    const updated = await repository.findById(CALENDAR_ID);
    expect(updated).toMatchObject({
      name: "Work renamed",
      color: "#ff0000",
      description: "Team calendar",
      updatedAt: "2026-08-25T00:00:00.000Z",
    });

    expect((await repository.listByOwner(OWNER)).map((c) => c.id)).toEqual([
      OTHER_CALENDAR_ID,
      CALENDAR_ID,
    ]);
    expect(await repository.listAll()).toHaveLength(2);
    expect(
      (await repository.findByIds([CALENDAR_ID])).map((c) => c.id),
    ).toEqual([CALENDAR_ID]);
    expect(await repository.findByIds([])).toEqual([]);
  });

  test("deleting a calendar cascades its events", async () => {
    const events = createCalendarEventRepository(db);
    await events.createEvent(
      timedEvent("evt-1", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
    );
    await createCalendarRepository(db).delete(CALENDAR_ID);
    expect(await events.findById(createCalendarEventId("evt-1"))).toBeNull();
  });
});

describe("calendar event repository", () => {
  test("writes the event, mentions and links in one batch and reads them back", async () => {
    const repository = createCalendarEventRepository(db);
    const event = timedEvent(
      "evt-1",
      "2026-09-01T00:00:00Z",
      "2026-09-01T01:00:00Z",
      {
        description: "Notes",
        location: "Room 1",
        mentions: ["taco@example.com", "ops@example.com"],
        links: [
          {
            id: createEventLinkId("lnk-1"),
            url: "https://example.com/a",
            title: "A",
          },
          { id: createEventLinkId("lnk-2"), url: "https://example.com/b" },
        ],
      },
    );
    await repository.createEvent(event);

    const loaded = await repository.findById(event.id);
    expect(loaded).toEqual(event);
  });

  test("replaces mentions and links on update rather than accumulating", async () => {
    const repository = createCalendarEventRepository(db);
    const event = timedEvent(
      "evt-1",
      "2026-09-01T00:00:00Z",
      "2026-09-01T01:00:00Z",
      {
        mentions: ["taco@example.com", "ops@example.com"],
        links: [
          { id: createEventLinkId("lnk-1"), url: "https://example.com/a" },
        ],
      },
    );
    await repository.createEvent(event);

    await repository.updateEvent(
      createCalendarEvent({
        ...event,
        mentions: ["ops@example.com"],
        links: [],
        updatedAt: "2026-08-25T00:00:00.000Z",
      }),
    );
    const loaded = await repository.findById(event.id);
    expect(loaded?.mentions).toEqual(["ops@example.com"]);
    expect(loaded?.links).toEqual([]);
  });

  test("a failing statement rolls the whole event batch back", async () => {
    const repository = createCalendarEventRepository(db);
    const broken = createCalendarEvent({
      id: createCalendarEventId("evt-broken"),
      // A calendar that does not exist: the foreign key fails, and the
      // mention/link inserts in the same batch must not survive it.
      calendarId: createCalendarId("cal-missing"),
      uid: "broken@mailcal",
      title: "Broken",
      time: {
        kind: "TIMED",
        startsAt: Date.parse("2026-09-01T00:00:00Z"),
        endsAt: Date.parse("2026-09-01T01:00:00Z"),
        timeZone: TOKYO,
      },
      mentions: ["taco@example.com"],
      createdAt: NOW,
    });
    await expect(repository.createEvent(broken)).rejects.toThrow();

    const mentions = await db.query<{ count: number }>(
      "SELECT count(*) AS count FROM event_mentions WHERE event_id = 'evt-broken'",
    );
    expect(mentions[0]?.count).toBe(0);
  });

  test("finds an event by uid, with and without a recurrence instance", async () => {
    const repository = createCalendarEventRepository(db);
    const master = timedEvent(
      "evt-master",
      "2026-09-01T00:00:00Z",
      "2026-09-01T01:00:00Z",
      {
        uid: "series@mailcal",
        recurrence: createRecurrenceRule({ freq: "WEEKLY" }),
      },
    );
    await repository.createEvent(master);
    const override = timedEvent(
      "evt-override",
      "2026-09-08T02:00:00Z",
      "2026-09-08T03:00:00Z",
      {
        uid: "series@mailcal",
        overrideOf: {
          parentEventId: master.id,
          recurrenceInstanceStart: Date.parse("2026-09-08T00:00:00Z"),
        },
      },
    );
    await repository.createEvent(override);

    expect(
      (await repository.findByUid(CALENDAR_ID, "series@mailcal", null))?.id,
    ).toBe(master.id);
    expect(
      (
        await repository.findByUid(
          CALENDAR_ID,
          "series@mailcal",
          Date.parse("2026-09-08T00:00:00Z"),
        )
      )?.id,
    ).toBe(override.id);
    expect(
      await repository.findByUid(OTHER_CALENDAR_ID, "series@mailcal", null),
    ).toBeNull();

    expect(
      (await repository.listOverrides(master.id)).map((e) => e.id),
    ).toEqual([override.id]);
    expect(
      (await repository.listOverridesForEvents([master.id])).map((e) => e.id),
    ).toEqual([override.id]);
    expect(await repository.listOverridesForEvents([])).toEqual([]);
  });

  describe("listCandidatesInRange", () => {
    const range = {
      startUtc: Date.parse("2026-10-01T00:00:00Z"),
      endUtc: Date.parse("2026-10-08T00:00:00Z"),
    };

    async function candidateIds(): Promise<readonly string[]> {
      const events = await createCalendarEventRepository(
        db,
      ).listCandidatesInRange([CALENDAR_ID, OTHER_CALENDAR_ID], range);
      return events.map((event) => event.id as string);
    }

    test("selects timed, all-day, recurring and unbounded candidates", async () => {
      const repository = createCalendarEventRepository(db);
      // Inside the range.
      await repository.createEvent(
        timedEvent("inside", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"),
      );
      // Straddles the start boundary.
      await repository.createEvent(
        timedEvent("straddle", "2026-09-30T22:00:00Z", "2026-10-01T02:00:00Z"),
      );
      // Ends exactly at the range start: the range is half-open, so this is
      // not a candidate.
      await repository.createEvent(
        timedEvent("touching", "2026-09-30T22:00:00Z", "2026-10-01T00:00:00Z"),
      );
      // Entirely before, entirely after.
      await repository.createEvent(
        timedEvent("before", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
      );
      await repository.createEvent(
        timedEvent("after", "2026-11-01T00:00:00Z", "2026-11-01T01:00:00Z"),
      );
      // All-day covering the range start.
      await repository.createEvent(
        timedEvent("allday", "", "", {
          time: {
            kind: "ALL_DAY",
            startDate: createIsoDate("2026-09-30"),
            endDateExclusive: createIsoDate("2026-10-02"),
          },
        }),
      );
      // Unbounded weekly series starting long before the range.
      await repository.createEvent(
        timedEvent(
          "unbounded",
          "2026-01-06T00:00:00Z",
          "2026-01-06T01:00:00Z",
          {
            recurrence: createRecurrenceRule({ freq: "WEEKLY" }),
          },
        ),
      );
      // COUNT-bounded series: stored as unbounded, so still a candidate.
      await repository.createEvent(
        timedEvent("counted", "2026-01-06T00:00:00Z", "2026-01-06T01:00:00Z", {
          recurrence: createRecurrenceRule({ freq: "WEEKLY", count: 3 }),
        }),
      );
      // UNTIL well before the range: excluded.
      await repository.createEvent(
        timedEvent("expired", "2026-01-06T00:00:00Z", "2026-01-06T01:00:00Z", {
          recurrence: createRecurrenceRule({
            freq: "WEEKLY",
            untilUtc: Date.parse("2026-03-01T00:00:00Z"),
          }),
        }),
      );
      // UNTIL just before the range start, but the occurrence's own duration
      // still reaches into it.
      await repository.createEvent(
        timedEvent("edge", "2026-01-05T23:00:00Z", "2026-01-06T01:00:00Z", {
          recurrence: createRecurrenceRule({
            freq: "WEEKLY",
            untilUtc: Date.parse("2026-09-30T23:00:00Z"),
          }),
        }),
      );
      // A series that only starts after the range ends.
      await repository.createEvent(
        timedEvent("future", "2026-12-01T00:00:00Z", "2026-12-01T01:00:00Z", {
          recurrence: createRecurrenceRule({ freq: "WEEKLY" }),
        }),
      );

      expect([...(await candidateIds())].sort()).toEqual([
        "allday",
        "counted",
        "edge",
        "inside",
        "straddle",
        "unbounded",
      ]);
    });

    test("ignores calendars that were not asked for", async () => {
      const repository = createCalendarEventRepository(db);
      await repository.createEvent(
        timedEvent("inside", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"),
      );
      const events = await repository.listCandidatesInRange(
        [OTHER_CALENDAR_ID],
        range,
      );
      expect(events).toEqual([]);
      expect(await repository.listCandidatesInRange([], range)).toEqual([]);
    });
  });

  test("lists events by mention address, optionally within a range", async () => {
    const repository = createCalendarEventRepository(db);
    await repository.createEvent(
      timedEvent("evt-1", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z", {
        mentions: ["taco@example.com"],
      }),
    );
    await repository.createEvent(
      timedEvent("evt-2", "2026-12-02T00:00:00Z", "2026-12-02T01:00:00Z", {
        mentions: ["taco@example.com"],
      }),
    );
    await repository.createEvent(
      timedEvent("evt-3", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z", {
        mentions: ["other@example.com"],
      }),
    );

    const all = await repository.listByMentionAddress(
      "taco@example.com" as never,
    );
    expect(all.map((event) => event.id)).toEqual(["evt-1", "evt-2"]);

    const ranged = await repository.listByMentionAddress(
      "taco@example.com" as never,
      {
        startUtc: Date.parse("2026-10-01T00:00:00Z"),
        endUtc: Date.parse("2026-10-08T00:00:00Z"),
      },
    );
    expect(ranged.map((event) => event.id)).toEqual(["evt-1"]);
  });

  describe("attachment claims", () => {
    const ATTACHMENT: AttachmentId = createAttachmentId("att-1");
    const EVENT_ID: CalendarEventId = createCalendarEventId("evt-1");

    async function seedAttachment(
      id: string,
      messageId: string | null,
    ): Promise<void> {
      await db.execute(
        `INSERT INTO attachments
           (id, message_id, file_name, content_type, size, blob_key,
            content_id, inline, kind, created_at)
         VALUES (?, ?, 'agenda.pdf', 'application/pdf', 10, ?, NULL, 0, 'PDF', ?)`,
        [id, messageId, `att/${id}`, NOW],
      );
    }

    beforeEach(async () => {
      await createCalendarEventRepository(db).createEvent(
        timedEvent("evt-1", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
      );
      await seedAttachment("att-1", null);
    });

    test("claims a staged upload and lists it back", async () => {
      const repository = createCalendarEventRepository(db);
      await repository.attachAttachment(EVENT_ID, ATTACHMENT, 0, NOW);
      expect(
        (await repository.listAttachments(EVENT_ID)).map((a) => a.id),
      ).toEqual([ATTACHMENT]);
      expect(await repository.findEventIdsByAttachment(ATTACHMENT)).toEqual([
        EVENT_ID,
      ]);
      expect(
        (await repository.listAttachmentsForEvents([EVENT_ID])).get(EVENT_ID),
      ).toHaveLength(1);

      // Re-claiming for the same event is a no-op rather than a PK error.
      await repository.attachAttachment(EVENT_ID, ATTACHMENT, 0, NOW);
      expect(await repository.listAttachments(EVENT_ID)).toHaveLength(1);

      expect(await repository.detachAttachment(EVENT_ID, ATTACHMENT)).toBe(
        true,
      );
      expect(await repository.detachAttachment(EVENT_ID, ATTACHMENT)).toBe(
        false,
      );
    });

    test("refuses an attachment that already belongs to a message", async () => {
      const repository = createCalendarEventRepository(db);
      await db.execute(
        `INSERT INTO domains
           (id, name, status, catch_all, verification_token, verified_at, created_at, updated_at)
         VALUES ('dom-1', 'example.com', 'ACTIVE', 1, 'tok', ?, ?, ?)`,
        [NOW, NOW, NOW],
      );
      await db.execute(
        `INSERT INTO messages
           (id, domain_id, direction, thread_id, rfc_message_id, subject,
            from_address, status, delivery_status, occurred_at, created_at, updated_at)
         VALUES ('msg-1', 'dom-1', 'INBOUND', 'thr-1', 'rfc-1', 'Hi',
                 'a@example.com', 'RECEIVED', 'RECEIVED', ?, ?, ?)`,
        [NOW, NOW, NOW],
      );
      await seedAttachment("att-mail", "msg-1");

      await expect(
        repository.attachAttachment(
          EVENT_ID,
          createAttachmentId("att-mail"),
          0,
          NOW,
        ),
      ).rejects.toThrow(/staged upload/);
    });

    test("refuses an attachment already claimed by another event", async () => {
      const repository = createCalendarEventRepository(db);
      await repository.createEvent(
        timedEvent("evt-2", "2026-09-02T00:00:00Z", "2026-09-02T01:00:00Z"),
      );
      await repository.attachAttachment(EVENT_ID, ATTACHMENT, 0, NOW);
      await expect(
        repository.attachAttachment(
          createCalendarEventId("evt-2"),
          ATTACHMENT,
          0,
          NOW,
        ),
      ).rejects.toThrow(/already claimed/);
    });
  });
});

describe("caldav account repository", () => {
  const ACCOUNT_ID = createCaldavAccountId("acc-1");
  const LINK_ID = createCaldavCalendarId("lnk-1");

  async function seedAccountAndLink(): Promise<void> {
    const repository = createCaldavAccountRepository(db);
    await repository.saveAccount({
      id: ACCOUNT_ID,
      userId: OWNER,
      serverUrl: "https://caldav.icloud.com/",
      username: "taco@example.com",
      passwordCiphertext: "v1:opaque",
      principalUrl: null,
      homeSetUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repository.saveCalendarLink({
      id: LINK_ID,
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
      remoteUrl: "https://p42-caldav.icloud.com/1/calendars/work/",
      displayName: "Work",
      ctag: "ctag-1",
      syncToken: "token-1",
      lastSyncedAt: null,
    });
  }

  test("stores only ciphertext and round-trips accounts and links", async () => {
    const repository = createCaldavAccountRepository(db);
    await seedAccountAndLink();

    const account = await repository.findAccountById(ACCOUNT_ID);
    expect(account?.passwordCiphertext).toBe("v1:opaque");
    expect(await repository.listAccountsByUser(OWNER)).toHaveLength(1);

    const columns = await db.query<Record<string, unknown>>(
      "SELECT * FROM caldav_accounts WHERE id = ?",
      [ACCOUNT_ID],
    );
    expect(JSON.stringify(columns[0])).not.toContain("abcd-efgh");

    expect((await repository.findCalendarLinkByCalendar(CALENDAR_ID))?.id).toBe(
      LINK_ID,
    );
    expect(
      (await repository.listCalendarLinksByAccount(ACCOUNT_ID)).map(
        (link) => link.id,
      ),
    ).toEqual([LINK_ID]);

    await repository.saveCalendarLink({
      id: LINK_ID,
      accountId: ACCOUNT_ID,
      calendarId: CALENDAR_ID,
      remoteUrl: "https://p42-caldav.icloud.com/1/calendars/work/",
      displayName: "Work",
      ctag: "ctag-2",
      syncToken: "token-2",
      lastSyncedAt: NOW,
    });
    expect((await repository.findCalendarLinkById(LINK_ID))?.syncToken).toBe(
      "token-2",
    );
  });

  test("keeps event states per href and cascades them with the event", async () => {
    const repository = createCaldavAccountRepository(db);
    await seedAccountAndLink();
    const events = createCalendarEventRepository(db);
    await events.createEvent(
      timedEvent("evt-1", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
    );

    await repository.saveEventState({
      eventId: "evt-1",
      caldavCalendarId: LINK_ID,
      href: "https://p42-caldav.icloud.com/1/calendars/work/evt-1.ics",
      etag: '"etag-1"',
      lastSyncedAt: NOW,
      remoteUnsupported: true,
    });
    const state = await repository.findEventState(
      createCalendarEventId("evt-1"),
    );
    expect(state?.remoteUnsupported).toBe(true);
    expect(
      (
        await repository.findEventStateByHref(
          LINK_ID,
          "https://p42-caldav.icloud.com/1/calendars/work/evt-1.ics",
        )
      )?.eventId,
    ).toBe("evt-1");
    expect(await repository.listEventStates(LINK_ID)).toHaveLength(1);

    await events.deleteEvent(createCalendarEventId("evt-1"));
    expect(
      await repository.findEventState(createCalendarEventId("evt-1")),
    ).toBeNull();
  });

  test("tombstones survive the event they refer to", async () => {
    const repository = createCaldavAccountRepository(db);
    await seedAccountAndLink();
    const events = createCalendarEventRepository(db);
    await events.createEvent(
      timedEvent("evt-1", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
    );
    const href = "https://p42-caldav.icloud.com/1/calendars/work/evt-1.ics";
    await repository.saveEventState({
      eventId: "evt-1",
      caldavCalendarId: LINK_ID,
      href,
      etag: '"etag-1"',
      lastSyncedAt: NOW,
      remoteUnsupported: false,
    });

    await repository.addDeletion({
      caldavCalendarId: LINK_ID,
      href,
      etag: '"etag-1"',
      deletedAt: NOW,
    });
    await events.deleteEvent(createCalendarEventId("evt-1"));

    const deletions = await repository.listDeletions(LINK_ID);
    expect(deletions.map((entry) => entry.href)).toEqual([href]);

    // Re-recording the same href replaces rather than duplicating.
    await repository.addDeletion({
      caldavCalendarId: LINK_ID,
      href,
      etag: '"etag-2"',
      deletedAt: NOW,
    });
    expect(await repository.listDeletions(LINK_ID)).toHaveLength(1);

    await repository.removeDeletion(LINK_ID, href);
    expect(await repository.listDeletions(LINK_ID)).toEqual([]);
  });

  test("deleting an account leaves local calendars and their events alone", async () => {
    const repository = createCaldavAccountRepository(db);
    await seedAccountAndLink();
    const events = createCalendarEventRepository(db);
    await events.createEvent(
      timedEvent("evt-1", "2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"),
    );

    await repository.deleteAccount(ACCOUNT_ID);
    expect(await repository.findCalendarLinkById(LINK_ID)).toBeNull();
    expect(
      await createCalendarRepository(db).findById(CALENDAR_ID),
    ).not.toBeNull();
    expect(
      await events.findById(createCalendarEventId("evt-1")),
    ).not.toBeNull();
  });

  test("deleting a linked calendar removes the link", async () => {
    const repository = createCaldavAccountRepository(db);
    await seedAccountAndLink();
    await createCalendarRepository(db).delete(CALENDAR_ID);
    expect(await repository.findCalendarLinkById(LINK_ID)).toBeNull();
  });
});
