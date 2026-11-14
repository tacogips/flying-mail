import { Capability } from "@mailcal/domain/entities/api-key";
import { createCaldavCalendarId } from "@mailcal/domain/value-objects/ids";
import type { CalendarEvent } from "@mailcal/domain/entities/calendar-event";
import { beforeEach, describe, expect, test } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  CALENDAR_ID,
  calendarKeyViewer,
  type CalendarFixture,
  mailOnlyKeyViewer,
  NOW,
  OTHER_EMAIL,
  seedCalendarFixture,
} from "../test-support/calendar-fixtures";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { createUseCases, type UseCases } from "../usecases";

/** Event-level authorization, editScope semantics and mention visibility. */

let fake: FakeDependencies;
let usecases: UseCases;
let fixture: CalendarFixture;

async function createTimedEvent(
  overrides: Record<string, unknown> = {},
): Promise<CalendarEvent> {
  return usecases.createCalendarEvent(fixture.ownerViewer, {
    calendarId: CALENDAR_ID,
    title: "Standup",
    time: {
      allDay: false,
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-01T01:00:00.000Z",
      timeZone: "UTC",
    },
    ...overrides,
  });
}

async function createSeries(): Promise<CalendarEvent> {
  return createTimedEvent({
    title: "Weekly",
    recurrence: { freq: "WEEKLY", count: 4 },
  });
}

function occurrenceStarts(
  result: Awaited<ReturnType<UseCases["listCalendarEvents"]>>,
): readonly string[] {
  return result.occurrences.map((entry) =>
    typeof entry.occurrenceStart === "number"
      ? new Date(entry.occurrenceStart).toISOString()
      : entry.occurrenceStart,
  );
}

const SEPTEMBER = {
  rangeStart: "2026-09-01T00:00:00.000Z",
  rangeEnd: "2026-10-01T00:00:00.000Z",
};

beforeEach(async () => {
  fake = createFakeDependencies({ now: NOW });
  usecases = createUseCases(fake.deps);
  fixture = await seedCalendarFixture(fake);
});

describe("event authorization", () => {
  test("a bystander gets NOT_FOUND for read and write", async () => {
    const event = await createTimedEvent();
    expect(
      await usecases.getCalendarEvent(fixture.otherViewer, event.id),
    ).toBeNull();
    await expect(
      usecases.updateCalendarEvent(fixture.otherViewer, event.id, {
        title: "Stolen",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await usecases.listCalendarEvents(fixture.otherViewer, SEPTEMBER))
        .occurrences,
    ).toEqual([]);
  });

  test("a mentioned user reads the event but cannot write it", async () => {
    const event = await createTimedEvent({ mentions: [OTHER_EMAIL] });
    expect(
      (await usecases.getCalendarEvent(fixture.otherViewer, event.id))?.id,
    ).toBe(event.id);
    // A write is authorized through the calendar, which a mention does not
    // grant at all -- so the refusal is the probe-resistant NOT_FOUND.
    await expect(
      usecases.updateCalendarEvent(fixture.otherViewer, event.id, {
        title: "Mine now",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A mention grants the event, never the calendar it lives in.
    expect(
      await usecases.getCalendar(fixture.otherViewer, CALENDAR_ID),
    ).toBeNull();
  });

  test("a CALENDAR_WRITE-scoped key may edit; a read-only one may not", async () => {
    const event = await createTimedEvent();
    const writeKey = calendarKeyViewer([
      Capability.CalendarRead,
      Capability.CalendarWrite,
    ]);
    const updated = await usecases.updateCalendarEvent(writeKey, event.id, {
      title: "Agent edit",
    });
    expect(updated.title).toBe("Agent edit");

    const readKey = calendarKeyViewer([Capability.CalendarRead]);
    await expect(
      usecases.updateCalendarEvent(readKey, event.id, { title: "Nope" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const mailKey = mailOnlyKeyViewer();
    expect(await usecases.getCalendarEvent(mailKey, event.id)).toBeNull();
    await expect(
      usecases.updateCalendarEvent(mailKey, event.id, { title: "Nope" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("editScope semantics", () => {
  test("THIS_OCCURRENCE creates an override, leaving the series intact", async () => {
    const series = await createSeries();
    const override = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      series.id,
      {
        title: "Moved",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );
    expect(override.id).not.toBe(series.id);
    expect(override.overrideOf).toEqual({
      parentEventId: series.id,
      recurrenceInstanceStart: Date.parse("2026-09-08T00:00:00.000Z"),
    });
    expect(override.recurrence).toBeNull();

    const master = await usecases.getCalendarEvent(
      fixture.ownerViewer,
      series.id,
    );
    expect(master?.title).toBe("Weekly");
    expect(master?.recurrence).not.toBeNull();

    const listed = await usecases.listCalendarEvents(
      fixture.ownerViewer,
      SEPTEMBER,
    );
    expect(occurrenceStarts(listed)).toHaveLength(4);
    expect(
      listed.occurrences
        .filter((entry) => entry.isOverride)
        .map((entry) => entry.event.title),
    ).toEqual(["Moved"]);
  });

  test("a second THIS_OCCURRENCE edit updates the same override row", async () => {
    const series = await createSeries();
    const first = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      series.id,
      {
        title: "Moved",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );
    const second = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      series.id,
      {
        title: "Moved again",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.title).toBe("Moved again");
    expect(
      (await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER))
        .occurrences,
    ).toHaveLength(4);
  });

  test("ENTIRE_SERIES rewrites the master", async () => {
    const series = await createSeries();
    const updated = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      series.id,
      { title: "Renamed", editScope: "ENTIRE_SERIES" },
    );
    expect(updated.id).toBe(series.id);
    expect(updated.title).toBe("Renamed");
    expect(
      (
        await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER)
      ).occurrences.every((entry) => entry.event.title === "Renamed"),
    ).toBe(true);
  });

  test("THIS_OCCURRENCE delete appends an EXDATE rather than removing the series", async () => {
    const series = await createSeries();
    expect(
      await usecases.deleteCalendarEvent(fixture.ownerViewer, series.id, {
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-15T00:00:00.000Z",
      }),
    ).toBe(true);

    const master = await usecases.getCalendarEvent(
      fixture.ownerViewer,
      series.id,
    );
    expect(master?.exdates).toEqual([Date.parse("2026-09-15T00:00:00.000Z")]);
    expect(
      occurrenceStarts(
        await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER),
      ),
    ).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
    ]);
  });

  test("ENTIRE_SERIES delete removes the whole series", async () => {
    const series = await createSeries();
    expect(
      await usecases.deleteCalendarEvent(fixture.ownerViewer, series.id, {
        editScope: "ENTIRE_SERIES",
      }),
    ).toBe(true);
    expect(
      await usecases.getCalendarEvent(fixture.ownerViewer, series.id),
    ).toBeNull();
    expect(
      (await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER))
        .occurrences,
    ).toEqual([]);
  });

  test("expand: false returns a series master once, unexpanded", async () => {
    await createSeries();
    const listed = await usecases.listCalendarEvents(fixture.ownerViewer, {
      ...SEPTEMBER,
      expand: false,
    });
    expect(listed.occurrences).toHaveLength(1);
  });
});

describe("mentions, links and mention queries", () => {
  test("adds and removes a mention by address", async () => {
    const event = await createTimedEvent();
    const mentioned = await usecases.addEventMention(
      fixture.ownerViewer,
      event.id,
      "Other@Example.com",
    );
    expect(mentioned.mentions).toEqual([OTHER_EMAIL]);

    const removed = await usecases.removeEventMention(
      fixture.ownerViewer,
      event.id,
      OTHER_EMAIL,
    );
    expect(removed.mentions).toEqual([]);
  });

  test("eventsMentioning returns only what the caller may see", async () => {
    await createTimedEvent({ mentions: [OTHER_EMAIL] });
    await createTimedEvent({ title: "Private" });

    const theirs = await usecases.listEventsMentioning(fixture.otherViewer, {
      address: OTHER_EMAIL,
    });
    expect(theirs.map((event) => event.title)).toEqual(["Standup"]);

    // Someone else's address is reported absent, not forbidden.
    await expect(
      usecases.listEventsMentioning(fixture.otherViewer, {
        address: "owner@example.com",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // A key whose CALENDAR_READ scope does not cover the address gets the
    // same answer.
    await expect(
      usecases.listEventsMentioning(mailOnlyKeyViewer(), {
        address: OTHER_EMAIL,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("adds and removes a link", async () => {
    const event = await createTimedEvent();
    const linked = await usecases.addEventLink(fixture.ownerViewer, event.id, {
      url: "https://example.com/doc",
      title: "Doc",
    });
    expect(linked.links).toHaveLength(1);
    const linkId = linked.links[0]?.id;
    if (linkId === undefined) {
      throw new Error("expected a link id");
    }
    expect(
      (await usecases.removeEventLink(fixture.ownerViewer, event.id, linkId))
        .links,
    ).toEqual([]);
  });
});

describe("editing and deleting through an override", () => {
  /** Creates the series and moves its 2026-09-08 instance, returning both
   * rows -- the shape `editScope: THIS_OCCURRENCE` produces and the one the
   * web dialog then hands back to the caller. */
  async function seriesWithOverride(): Promise<{
    readonly master: CalendarEvent;
    readonly override: CalendarEvent;
  }> {
    const master = await createSeries();
    const override = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      master.id,
      {
        title: "Moved instance",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );
    return { master, override };
  }

  test("THIS_OCCURRENCE delete of an override removes the instance for good", async () => {
    const { master, override } = await seriesWithOverride();

    expect(
      await usecases.deleteCalendarEvent(fixture.ownerViewer, override.id, {
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      }),
    ).toBe(true);

    const listed = await usecases.listCalendarEvents(
      fixture.ownerViewer,
      SEPTEMBER,
    );
    // The instance must be gone entirely -- not resurrected at the master's
    // original 00:00 slot, which is what a plain row delete would do.
    expect(occurrenceStarts(listed)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
    ]);
    expect(
      listed.occurrences.some(
        (entry) => entry.event.title === "Moved instance",
      ),
    ).toBe(false);

    // The EXDATE is what makes it stick, and it marks the master dirty.
    const reloaded = await usecases.getCalendarEvent(
      fixture.ownerViewer,
      master.id,
    );
    expect(reloaded?.exdates).toEqual([Date.parse("2026-09-08T00:00:00.000Z")]);
  });

  test("a bare delete of an override behaves the same way", async () => {
    const { override } = await seriesWithOverride();
    expect(
      await usecases.deleteCalendarEvent(fixture.ownerViewer, override.id),
    ).toBe(true);
    expect(
      occurrenceStarts(
        await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER),
      ),
    ).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
    ]);
  });

  test("ENTIRE_SERIES delete of an override removes the master and siblings", async () => {
    const { master, override } = await seriesWithOverride();

    expect(
      await usecases.deleteCalendarEvent(fixture.ownerViewer, override.id, {
        editScope: "ENTIRE_SERIES",
      }),
    ).toBe(true);

    expect(
      await usecases.getCalendarEvent(fixture.ownerViewer, master.id),
    ).toBeNull();
    expect(
      await usecases.getCalendarEvent(fixture.ownerViewer, override.id),
    ).toBeNull();
    expect(
      (await usecases.listCalendarEvents(fixture.ownerViewer, SEPTEMBER))
        .occurrences,
    ).toEqual([]);
  });

  test("ENTIRE_SERIES delete of an override records the master's tombstone", async () => {
    const { master, override } = await seriesWithOverride();
    // Only the master carries a state row after the resource-grouping fix,
    // so the tombstone has to be looked up there rather than on the override.
    await fake.deps.caldavAccountRepository.saveEventState({
      eventId: master.id,
      caldavCalendarId: createCaldavCalendarId("cdl-1"),
      href: "https://p42-caldav.icloud.com/1/calendars/work/series.ics",
      etag: '"etag-series"',
      lastSyncedAt: NOW,
      remoteUnsupported: false,
    });

    await usecases.deleteCalendarEvent(fixture.ownerViewer, override.id, {
      editScope: "ENTIRE_SERIES",
    });

    const deletions = await fake.deps.caldavAccountRepository.listDeletions(
      createCaldavCalendarId("cdl-1"),
    );
    expect(deletions.map((entry) => entry.href)).toEqual([
      "https://p42-caldav.icloud.com/1/calendars/work/series.ics",
    ]);
  });

  test("ENTIRE_SERIES edit from an override renames every occurrence", async () => {
    const { master, override } = await seriesWithOverride();

    const updated = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      override.id,
      { title: "Renamed series", editScope: "ENTIRE_SERIES" },
    );
    // The master is what changed, not the exception the caller had open.
    expect(updated.id).toBe(master.id);

    const listed = await usecases.listCalendarEvents(
      fixture.ownerViewer,
      SEPTEMBER,
    );
    expect(listed.occurrences).toHaveLength(4);
    for (const entry of listed.occurrences) {
      // The override keeps its own title: it is a deliberate exception, and
      // flattening it would discard an edit the user made on purpose.
      expect(entry.event.title).toBe(
        entry.isOverride ? "Moved instance" : "Renamed series",
      );
    }
  });

  test("THIS_OCCURRENCE edit of an override still patches that override", async () => {
    const { master, override } = await seriesWithOverride();
    const patched = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      override.id,
      { title: "Moved again", editScope: "THIS_OCCURRENCE" },
    );
    expect(patched.id).toBe(override.id);
    expect(
      (await usecases.getCalendarEvent(fixture.ownerViewer, master.id))?.title,
    ).toBe("Weekly");
  });
});
