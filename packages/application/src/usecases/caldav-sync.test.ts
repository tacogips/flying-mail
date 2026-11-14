import {
  type CalendarEvent,
  createCalendarEvent,
} from "@mailcal/domain/entities/calendar-event";
import {
  createCalendarEventId,
  createCaldavAccountId,
  createCaldavCalendarId,
} from "@mailcal/domain/value-objects/ids";
import { createRecurrenceRule } from "@mailcal/domain/value-objects/recurrence";
import { createTimeZoneId } from "@mailcal/domain/value-objects/time-zone";
import { beforeEach, describe, expect, test } from "vitest";
import { BadUserInputError, ServiceUnavailableError } from "../errors";
import type { CaldavObject } from "../ports/caldav";
import type { IcsCodec, ParsedIcsEvent } from "../ports/ics-codec";
import {
  CALENDAR_ID,
  type CalendarFixture,
  NOW,
  seedCalendarFixture,
} from "../test-support/calendar-fixtures";
import {
  createFakeDependencies,
  type CreateFakeDependenciesOptions,
  type FakeDependencies,
} from "../test-support/fakes";
import { createUseCases, type UseCases } from "../usecases";

/** Sync policy: remote-wins conflicts, tombstone pushes, and the
 * never-push rule for rules we cannot represent.
 *
 * The codec is a JSON stand-in rather than the real adapter one -- the
 * application layer must not depend on `@mailcal/adapter`, and RFC 5545
 * grammar is covered by that package's own round-trip fixtures. */

const ACCOUNT_ID = createCaldavAccountId("acc-1");
const LINK_ID = createCaldavCalendarId("cdl-1");
const REMOTE_URL = "https://p42-caldav.icloud.com/1/calendars/work/";

interface JsonEvent {
  readonly uid: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly recurrenceInstanceStart?: string;
  readonly recurrenceUnsupported?: boolean;
}

function toJsonEvent(event: {
  readonly uid: string;
  readonly title: string;
  readonly time: CalendarEvent["time"];
  readonly overrideOf: CalendarEvent["overrideOf"];
}): JsonEvent {
  return {
    uid: event.uid,
    title: event.title,
    startsAt:
      event.time.kind === "TIMED"
        ? new Date(event.time.startsAt).toISOString()
        : event.time.startDate,
    endsAt:
      event.time.kind === "TIMED"
        ? new Date(event.time.endsAt).toISOString()
        : event.time.endDateExclusive,
    ...(event.overrideOf === null
      ? {}
      : {
          recurrenceInstanceStart: new Date(
            Number(event.overrideOf.recurrenceInstanceStart),
          ).toISOString(),
        }),
  };
}

function jsonIcsCodec(): IcsCodec {
  return {
    serializeEvent(event) {
      return JSON.stringify([toJsonEvent(event)]);
    },
    // Mirrors the real codec's contract: one body, every component of the
    // resource inside it.
    serializeCalendarObject(events) {
      return JSON.stringify(events.map(toJsonEvent));
    },
    parseCalendarObject(ics): readonly ParsedIcsEvent[] {
      const parsed = JSON.parse(ics) as JsonEvent | readonly JsonEvent[];
      const components = Array.isArray(parsed) ? parsed : [parsed];
      return components.map((raw) => ({
        uid: raw.uid,
        title: raw.title,
        description: null,
        location: null,
        time: {
          kind: "TIMED",
          startsAt: Date.parse(raw.startsAt),
          endsAt: Date.parse(raw.endsAt),
          timeZone: createTimeZoneId("UTC"),
        },
        recurrence: null,
        exdates: [],
        recurrenceInstanceStart:
          raw.recurrenceInstanceStart === undefined
            ? null
            : Date.parse(raw.recurrenceInstanceStart),
        mentions: [],
        links: [],
        recurrenceUnsupported: raw.recurrenceUnsupported ?? false,
        warnings:
          raw.recurrenceUnsupported === true
            ? [
                {
                  kind: "RECURRENCE_UNSUPPORTED",
                  uid: raw.uid,
                  value: "FREQ=MONTHLY;BYSETPOS=-1",
                },
              ]
            : [],
      }));
    },
  };
}

function remoteObject(
  href: string,
  event: JsonEvent | readonly JsonEvent[],
  etag: string,
): CaldavObject {
  return { href, etag, ics: JSON.stringify(event) };
}

let fake: FakeDependencies;
let usecases: UseCases;
let fixture: CalendarFixture;

async function setup(
  options: Omit<CreateFakeDependenciesOptions, "now" | "icsCodec"> = {},
): Promise<void> {
  fake = createFakeDependencies({
    now: NOW,
    icsCodec: jsonIcsCodec(),
    ...options,
  });
  usecases = createUseCases(fake.deps);
  fixture = await seedCalendarFixture(fake);
  await fake.deps.caldavAccountRepository.saveAccount({
    id: ACCOUNT_ID,
    userId:
      fixture.ownerViewer.kind === "USER"
        ? fixture.ownerViewer.userId
        : (() => {
            throw new Error("owner fixture must be a USER viewer");
          })(),
    serverUrl: "https://caldav.icloud.com/",
    username: "owner@example.com",
    passwordCiphertext: "fake:app-password",
    principalUrl: null,
    homeSetUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await fake.deps.caldavAccountRepository.saveCalendarLink({
    id: LINK_ID,
    accountId: ACCOUNT_ID,
    calendarId: CALENDAR_ID,
    remoteUrl: REMOTE_URL,
    displayName: "Work",
    ctag: null,
    syncToken: null,
    lastSyncedAt: null,
  });
}

beforeEach(async () => {
  await setup();
});

describe("syncCalendar pull", () => {
  test("imports remote objects and records their etags", async () => {
    await setup({
      caldav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}a.ics`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: "ctag-2",
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}a.ics`,
            remoteObject(
              `${REMOTE_URL}a.ics`,
              {
                uid: "remote-1",
                title: "Remote meeting",
                startsAt: "2026-09-01T00:00:00.000Z",
                endsAt: "2026-09-01T01:00:00.000Z",
              },
              '"etag-a"',
            ),
          ],
        ]),
      },
    });

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result).toMatchObject({ pulled: 1, deleted: 0, truncated: false });

    const imported = await fake.deps.calendarEventRepository.findByUid(
      CALENDAR_ID,
      "remote-1",
      null,
    );
    expect(imported?.title).toBe("Remote meeting");

    const state = await fake.deps.caldavAccountRepository.findEventState(
      imported?.id ?? createCalendarEventId("missing"),
    );
    expect(state?.etag).toBe('"etag-a"');
    expect(state?.href).toBe(`${REMOTE_URL}a.ics`);

    const link =
      await fake.deps.caldavAccountRepository.findCalendarLinkByCalendar(
        CALENDAR_ID,
      );
    expect(link?.syncToken).toBe("token-2");
    expect(link?.ctag).toBe("ctag-2");
  });

  test("a remote deletion removes the local event", async () => {
    await setup({
      caldav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}a.ics`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
          {
            changedHrefs: [],
            deletedHrefs: [`${REMOTE_URL}a.ics`],
            syncToken: "token-3",
            ctag: null,
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}a.ics`,
            remoteObject(
              `${REMOTE_URL}a.ics`,
              {
                uid: "remote-1",
                title: "Remote meeting",
                startsAt: "2026-09-01T00:00:00.000Z",
                endsAt: "2026-09-01T01:00:00.000Z",
              },
              '"etag-a"',
            ),
          ],
        ]),
      },
    });

    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    const second = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(second.deleted).toBe(1);
    expect(
      await fake.deps.calendarEventRepository.findByUid(
        CALENDAR_ID,
        "remote-1",
        null,
      ),
    ).toBeNull();
  });

  test("a full resync treats an absent href as a remote deletion", async () => {
    await setup({
      caldav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}a.ics`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
          // The server could not honor the token, so the adapter fell back
          // to a full listing -- which no longer mentions a.ics.
          {
            changedHrefs: [],
            deletedHrefs: [],
            syncToken: null,
            ctag: null,
            fullResync: true,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}a.ics`,
            remoteObject(
              `${REMOTE_URL}a.ics`,
              {
                uid: "remote-1",
                title: "Remote meeting",
                startsAt: "2026-09-01T00:00:00.000Z",
                endsAt: "2026-09-01T01:00:00.000Z",
              },
              '"etag-a"',
            ),
          ],
        ]),
      },
    });

    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    const second = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(second.deleted).toBe(1);
    expect(
      await fake.deps.calendarEventRepository.findByUid(
        CALENDAR_ID,
        "remote-1",
        null,
      ),
    ).toBeNull();
  });

  test("an unsupported remote recurrence rule is warned about and never pushed", async () => {
    await setup({
      caldav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}odd.ics`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}odd.ics`,
            remoteObject(
              `${REMOTE_URL}odd.ics`,
              {
                uid: "odd-1",
                title: "Last Friday",
                startsAt: "2026-09-25T00:00:00.000Z",
                endsAt: "2026-09-25T01:00:00.000Z",
                recurrenceUnsupported: true,
              },
              '"etag-odd"',
            ),
          ],
        ]),
      },
    });

    const first = await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    expect(first.warnings.join(" ")).toContain("Unsupported recurrence rule");

    // The imported event is dirty by construction (its updatedAt is the sync
    // instant), yet the next sync must not push it back.
    const second = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(second.pushed).toBe(0);
    expect(fake.caldavClient.calls.filter((c) => c.kind === "PUT")).toEqual([]);
    expect(second.warnings.join(" ")).toContain("Not pushing odd-1");
  });
});

describe("syncCalendar push", () => {
  async function seedLocalEvent(): Promise<void> {
    await fake.deps.calendarEventRepository.createEvent(
      createCalendarEvent({
        id: createCalendarEventId("evt-local"),
        calendarId: CALENDAR_ID,
        uid: "local-1",
        title: "Local meeting",
        time: {
          kind: "TIMED",
          startsAt: Date.parse("2026-09-02T00:00:00.000Z"),
          endsAt: Date.parse("2026-09-02T01:00:00.000Z"),
          timeZone: createTimeZoneId("UTC"),
        },
        createdAt: "2026-08-23T00:00:00.000Z",
        // Before the fixed clock's NOW, so the first sync sees it as dirty
        // (no event state yet) and the second sees it as clean.
        updatedAt: "2026-08-23T00:00:00.000Z",
      }),
    );
  }

  test("pushes a locally created event and stores the returned etag", async () => {
    await seedLocalEvent();
    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result.pushed).toBe(1);
    const put = fake.caldavClient.calls.find((call) => call.kind === "PUT");
    expect(put?.href).toBe(`${REMOTE_URL}local-1.ics`);
    expect(put?.etag).toBeNull();

    const state = await fake.deps.caldavAccountRepository.findEventState(
      createCalendarEventId("evt-local"),
    );
    expect(state?.etag).not.toBeNull();

    // Now clean: a second sync pushes nothing.
    expect(
      (await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID)).pushed,
    ).toBe(0);
  });

  test("a 412 on push resolves remote-wins and reports the conflict", async () => {
    await setup({
      caldav: {
        putResults: new Map([
          [`${REMOTE_URL}local-1.ics`, { outcome: "CONFLICT", etag: null }],
        ]),
        objects: new Map([
          [
            `${REMOTE_URL}local-1.ics`,
            remoteObject(
              `${REMOTE_URL}local-1.ics`,
              {
                uid: "local-1",
                title: "Remote version wins",
                startsAt: "2026-09-02T02:00:00.000Z",
                endsAt: "2026-09-02T03:00:00.000Z",
              },
              '"etag-remote"',
            ),
          ],
        ]),
      },
    });
    await seedLocalEvent();

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result.conflictsResolvedRemoteWins).toBe(1);
    expect(result.pushed).toBe(0);

    const stored = await fake.deps.calendarEventRepository.findByUid(
      CALENDAR_ID,
      "local-1",
      null,
    );
    expect(stored?.title).toBe("Remote version wins");
  });

  test("deleting a synced event pushes a tombstone on the next sync", async () => {
    await seedLocalEvent();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);

    expect(
      await usecases.deleteCalendarEvent(
        fixture.ownerViewer,
        createCalendarEventId("evt-local"),
      ),
    ).toBe(true);
    // The event state cascaded away, so the pending remote DELETE has to be
    // remembered in the tombstone table.
    expect(
      await fake.deps.caldavAccountRepository.listDeletions(LINK_ID),
    ).toHaveLength(1);

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result.deleted).toBe(1);
    expect(
      fake.caldavClient.calls.filter((call) => call.kind === "DELETE"),
    ).toHaveLength(1);
    expect(
      await fake.deps.caldavAccountRepository.listDeletions(LINK_ID),
    ).toEqual([]);
  });

  test("a 412 on a tombstone delete brings the remote event back", async () => {
    await setup({
      caldav: {
        deleteResults: new Map([
          [`${REMOTE_URL}local-1.ics`, { outcome: "CONFLICT" }],
        ]),
        objects: new Map([
          [
            `${REMOTE_URL}local-1.ics`,
            remoteObject(
              `${REMOTE_URL}local-1.ics`,
              {
                uid: "local-1",
                title: "Edited remotely after our delete",
                startsAt: "2026-09-02T00:00:00.000Z",
                endsAt: "2026-09-02T01:00:00.000Z",
              },
              '"etag-remote"',
            ),
          ],
        ]),
      },
    });
    await seedLocalEvent();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    await usecases.deleteCalendarEvent(
      fixture.ownerViewer,
      createCalendarEventId("evt-local"),
    );

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result.conflictsResolvedRemoteWins).toBe(1);
    expect(
      (
        await fake.deps.calendarEventRepository.findByUid(
          CALENDAR_ID,
          "local-1",
          null,
        )
      )?.title,
    ).toBe("Edited remotely after our delete");
    // The tombstone is cleared either way, so it cannot re-fire forever.
    expect(
      await fake.deps.caldavAccountRepository.listDeletions(LINK_ID),
    ).toEqual([]);
  });
});

describe("syncCalendar guards", () => {
  test("fails with SERVICE_UNAVAILABLE when no credential key is configured", async () => {
    await setup({ credentialCipherAvailable: false });
    await expect(
      usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("requires calendar write authorization", async () => {
    await expect(
      usecases.syncCalendar(fixture.otherViewer, CALENDAR_ID),
    ).rejects.toThrow();
  });
});

describe("calendar object resources (master + overrides)", () => {
  /** A weekly series plus one moved instance, both sharing a UID -- the
   * shape `editScope: THIS_OCCURRENCE` produces and the one CalDAV stores
   * as a single resource. */
  async function seedSeriesWithOverride(): Promise<void> {
    const master = createCalendarEvent({
      id: createCalendarEventId("evt-master"),
      calendarId: CALENDAR_ID,
      uid: "series-1",
      title: "Weekly sync",
      time: {
        kind: "TIMED",
        startsAt: Date.parse("2026-09-01T00:00:00.000Z"),
        endsAt: Date.parse("2026-09-01T01:00:00.000Z"),
        timeZone: createTimeZoneId("UTC"),
      },
      recurrence: createRecurrenceRule({ freq: "WEEKLY", count: 4 }),
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    await fake.deps.calendarEventRepository.createEvent(master);
    await fake.deps.calendarEventRepository.createEvent(
      createCalendarEvent({
        id: createCalendarEventId("evt-override"),
        calendarId: CALENDAR_ID,
        uid: "series-1",
        title: "Moved instance",
        time: {
          kind: "TIMED",
          startsAt: Date.parse("2026-09-08T02:00:00.000Z"),
          endsAt: Date.parse("2026-09-08T03:00:00.000Z"),
          timeZone: createTimeZoneId("UTC"),
        },
        overrideOf: {
          parentEventId: master.id,
          recurrenceInstanceStart: Date.parse("2026-09-08T00:00:00.000Z"),
        },
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      }),
    );
  }

  function putBodies(): readonly { href: string; components: number }[] {
    return fake.caldavClient.calls
      .filter((call) => call.kind === "PUT")
      .map((call) => ({
        href: call.href,
        components: (JSON.parse(call.ics ?? "[]") as readonly unknown[]).length,
      }));
  }

  test("pushes the master and its override as one resource, not two", async () => {
    await seedSeriesWithOverride();
    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );

    // One PUT, one href, both components inside it. Two PUTs to the same
    // href is exactly the bug: the second would overwrite the first.
    expect(putBodies()).toEqual([
      { href: `${REMOTE_URL}series-1.ics`, components: 2 },
    ]);
    expect(result.pushed).toBe(1);
    expect(result.conflictsResolvedRemoteWins).toBe(0);
  });

  test("keeps exactly one event state row for the resource", async () => {
    await seedSeriesWithOverride();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);

    const states =
      await fake.deps.caldavAccountRepository.listEventStates(LINK_ID);
    expect(states.map((state) => state.eventId)).toEqual(["evt-master"]);
    // So the href resolves unambiguously back to the series.
    expect(
      (
        await fake.deps.caldavAccountRepository.findEventStateByHref(
          LINK_ID,
          `${REMOTE_URL}series-1.ics`,
        )
      )?.eventId,
    ).toBe("evt-master");
  });

  test("editing only the override republishes the whole resource", async () => {
    await seedSeriesWithOverride();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    const afterFirst = putBodies().length;

    // The edit has to land after the sync instant, as a real one would:
    // dirtiness is `updatedAt > lastSyncedAt`, and the test clock would
    // otherwise stamp both with the same millisecond.
    fake.clock.advanceSeconds(60);
    await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      createCalendarEventId("evt-override"),
      { title: "Moved again" },
    );
    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );

    expect(result.pushed).toBe(1);
    const pushes = putBodies();
    expect(pushes).toHaveLength(afterFirst + 1);
    // The master travels with it: the server stores the object whole, so a
    // body carrying only the override would delete the series remotely.
    expect(pushes.at(-1)).toEqual({
      href: `${REMOTE_URL}series-1.ics`,
      components: 2,
    });
  });

  test("editing only the master keeps the override in the pushed body", async () => {
    await seedSeriesWithOverride();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);

    fake.clock.advanceSeconds(60);
    await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      createCalendarEventId("evt-master"),
      { title: "Renamed series", editScope: "ENTIRE_SERIES" },
    );
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);

    const last = putBodies().at(-1);
    expect(last?.components).toBe(2);
    const components = JSON.parse(
      fake.caldavClient.calls.filter((call) => call.kind === "PUT").at(-1)
        ?.ics ?? "[]",
    ) as readonly { title: string }[];
    expect(components.map((component) => component.title)).toEqual([
      "Renamed series",
      "Moved instance",
    ]);
  });

  test("a clean resource is not pushed again", async () => {
    await seedSeriesWithOverride();
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    const afterFirst = putBodies().length;
    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    expect(putBodies()).toHaveLength(afterFirst);
  });

  test("pulls a multi-component object then pushes it back whole", async () => {
    await setup({
      caldav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}series-1.ics`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}series-1.ics`,
            remoteObject(
              `${REMOTE_URL}series-1.ics`,
              [
                {
                  uid: "remote-series",
                  title: "Remote series",
                  startsAt: "2026-09-01T00:00:00.000Z",
                  endsAt: "2026-09-01T01:00:00.000Z",
                },
                {
                  uid: "remote-series",
                  title: "Remote override",
                  startsAt: "2026-09-08T02:00:00.000Z",
                  endsAt: "2026-09-08T03:00:00.000Z",
                  recurrenceInstanceStart: "2026-09-08T00:00:00.000Z",
                },
              ],
              '"etag-series"',
            ),
          ],
        ]),
      },
    });

    const pulled = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(pulled.pulled).toBe(2);
    // Both components landed, but only one state row exists for the href.
    const states =
      await fake.deps.caldavAccountRepository.listEventStates(LINK_ID);
    expect(states).toHaveLength(1);
    const override = await fake.deps.calendarEventRepository.findByUid(
      CALENDAR_ID,
      "remote-series",
      Date.parse("2026-09-08T00:00:00.000Z"),
    );
    expect(override?.title).toBe("Remote override");
    // Freshly pulled, so nothing is dirty and nothing is pushed back.
    expect(pulled.pushed).toBe(0);
  });

  test("a 412 on the grouped resource resolves remote-wins once", async () => {
    await setup({
      caldav: {
        putResults: new Map([
          [`${REMOTE_URL}series-1.ics`, { outcome: "CONFLICT", etag: null }],
        ]),
        objects: new Map([
          [
            `${REMOTE_URL}series-1.ics`,
            remoteObject(
              `${REMOTE_URL}series-1.ics`,
              [
                {
                  uid: "series-1",
                  title: "Remote wins",
                  startsAt: "2026-09-01T00:00:00.000Z",
                  endsAt: "2026-09-01T01:00:00.000Z",
                },
              ],
              '"etag-remote"',
            ),
          ],
        ]),
      },
    });
    await seedSeriesWithOverride();

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    // One conflict for the resource, not one per component.
    expect(result.conflictsResolvedRemoteWins).toBe(1);
    expect(result.pushed).toBe(0);
    expect(
      (
        await fake.deps.calendarEventRepository.findByUid(
          CALENDAR_ID,
          "series-1",
          null,
        )
      )?.title,
    ).toBe("Remote wins");
  });
});

describe("credential and collection URL validation", () => {
  test("connect rejects a plain-http server before any request is made", async () => {
    await setup({
      caldav: {
        onDiscover: () => {
          throw new Error("discover must not be reached for an http URL");
        },
      },
    });

    await expect(
      usecases.connectCaldavAccount(fixture.ownerViewer, {
        serverUrl: "http://attacker.example/",
        username: "owner@example.com",
        appPassword: "abcd-efgh-ijkl-mnop",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("linkCaldavCalendar refuses a collection on another origin", async () => {
    await expect(
      usecases.linkCaldavCalendar(fixture.ownerViewer, {
        accountId: ACCOUNT_ID,
        remoteUrl: "https://harvester.example/calendars/work/",
        mode: "IMPORT_NEW",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("linkCaldavCalendar accepts a collection on the account's own origin", async () => {
    const link = await usecases.linkCaldavCalendar(fixture.ownerViewer, {
      accountId: ACCOUNT_ID,
      remoteUrl: "https://caldav.icloud.com/1/calendars/personal/",
      mode: "IMPORT_NEW",
      displayName: "Personal",
    });
    expect(link.remoteUrl).toBe(
      "https://caldav.icloud.com/1/calendars/personal/",
    );
  });
});

describe("deleting an override out of a grouped resource", () => {
  test("re-PUTs the resource with one VEVENT and an EXDATE, issuing no DELETE", async () => {
    await setup();
    const master = await usecases.createCalendarEvent(fixture.ownerViewer, {
      calendarId: CALENDAR_ID,
      title: "Weekly sync",
      time: {
        allDay: false,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-01T01:00:00.000Z",
        timeZone: "UTC",
      },
      recurrence: { freq: "WEEKLY", count: 4 },
    });
    const override = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      master.id,
      {
        title: "Moved instance",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );

    await usecases.syncCalendar(fixture.ownerViewer, CALENDAR_ID);
    const pushesBefore = fake.caldavClient.calls.filter(
      (call) => call.kind === "PUT",
    ).length;

    fake.clock.advanceSeconds(60);
    await usecases.deleteCalendarEvent(fixture.ownerViewer, override.id, {
      editScope: "THIS_OCCURRENCE",
      occurrenceStart: "2026-09-08T00:00:00.000Z",
    });
    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );

    // The master's EXDATE change marks the resource dirty, so it is
    // re-serialized rather than deleted: the series still exists remotely.
    expect(result.pushed).toBe(1);
    const puts = fake.caldavClient.calls.filter((call) => call.kind === "PUT");
    expect(puts).toHaveLength(pushesBefore + 1);
    const body = JSON.parse(puts.at(-1)?.ics ?? "[]") as readonly {
      title: string;
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.title).toBe("Weekly sync");
    // The resource name is the percent-encoded UID, as hrefForEvent builds it.
    expect(puts.at(-1)?.href).toBe(
      `${REMOTE_URL}${encodeURIComponent(master.uid)}.ics`,
    );

    // Deleting one instance must never delete the whole remote object.
    expect(
      fake.caldavClient.calls.filter((call) => call.kind === "DELETE"),
    ).toEqual([]);
    expect(result.deleted).toBe(0);
  });
});

describe("legacy per-override state rows", () => {
  test("a stale override row holding the master's href does not break the push", async () => {
    await setup();
    const master = await usecases.createCalendarEvent(fixture.ownerViewer, {
      calendarId: CALENDAR_ID,
      title: "Weekly sync",
      time: {
        allDay: false,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-01T01:00:00.000Z",
        timeZone: "UTC",
      },
      recurrence: { freq: "WEEKLY", count: 4 },
    });
    const override = await usecases.updateCalendarEvent(
      fixture.ownerViewer,
      master.id,
      {
        title: "Moved instance",
        editScope: "THIS_OCCURRENCE",
        occurrenceStart: "2026-09-08T00:00:00.000Z",
      },
    );

    // What a pre-grouping build would have written: a row keyed by the
    // override but carrying the resource's href. D1 has
    // UNIQUE(caldav_calendar_id, href), so the master's row must not be
    // inserted while this one still exists.
    const href = `${REMOTE_URL}${encodeURIComponent(master.uid)}.ics`;
    await fake.deps.caldavAccountRepository.saveEventState({
      eventId: override.id,
      caldavCalendarId: LINK_ID,
      href,
      etag: '"legacy-etag"',
      lastSyncedAt: "2026-08-23T00:00:00.000Z",
      remoteUnsupported: false,
    });

    const result = await usecases.syncCalendar(
      fixture.ownerViewer,
      CALENDAR_ID,
    );
    expect(result.pushed).toBe(1);

    // Exactly one row survives, keyed by the master, and the href resolves
    // to it unambiguously.
    const states =
      await fake.deps.caldavAccountRepository.listEventStates(LINK_ID);
    expect(states.map((state) => state.eventId)).toEqual([master.id]);
    expect(
      (
        await fake.deps.caldavAccountRepository.findEventStateByHref(
          LINK_ID,
          href,
        )
      )?.eventId,
    ).toBe(master.id);
  });
});
