import { createFakeDependencies } from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { Capability } from "@mailcal/domain/entities/api-key";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import { createUserId } from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

/** End-to-end operation tests for the calendar SDL module, mirroring
 * `schema.test.ts`'s style: real yoga requests over in-memory fakes. */

const NOW = "2026-08-23T00:00:00.000Z";
const OWNER = memberViewer("usr-owner");
const OTHER = memberViewer("usr-other");
const ADMIN = adminViewer();

const EVENT_FIELDS = `
  id
  calendarId
  calendar { id name }
  uid
  title
  description
  location
  time { allDay startsAt endsAt timeZone startDate endDateExclusive }
  recurrence { freq interval count until byDay weekStart }
  exdates
  overrideOfEventId
  recurrenceInstanceStart
  mentions
  links { id url title position }
  attachments { id fileName }
  createdAt
  updatedAt
`;

const CREATE_CALENDAR = `
  mutation Create($input: CreateCalendarInput!) {
    createCalendar(input: $input) {
      id ownerUserId name color description createdAt updatedAt
    }
  }
`;

const CREATE_EVENT = `
  mutation CreateEvent($input: CreateCalendarEventInput!) {
    createCalendarEvent(input: $input) { ${EVENT_FIELDS} }
  }
`;

const EVENTS_IN_RANGE = `
  query Events($input: CalendarEventRangeInput!) {
    calendarEvents(input: $input) {
      truncated
      occurrences {
        occurrenceStart
        startsAt
        endsAt
        isOverride
        event { id title }
      }
    }
  }
`;

/** Narrows one field of a successful result, failing the test loudly rather
 * than letting an unexpected `null` surface as a confusing property error. */
function field<T>(
  result: { readonly data?: Record<string, unknown> | null },
  name: string,
): T {
  const value = result.data?.[name];
  if (value === undefined || value === null) {
    throw new Error(`expected ${name} in the result`);
  }
  return value as T;
}

let harness: GraphQLHarness;

async function seedUsers(): Promise<void> {
  for (const [id, email] of [
    ["usr-owner", "owner@example.com"],
    ["usr-other", "other@example.com"],
    ["usr-admin", "admin@example.com"],
  ] as const) {
    harness.fake.stores.users.set(
      id,
      createUser({
        id: createUserId(id),
        email: createEmailAddress(email),
        name: email,
        role: id === "usr-admin" ? UserRole.Admin : UserRole.Member,
        createdAt: NOW,
      }),
    );
  }
}

async function createCalendar(viewer = OWNER, name = "Work"): Promise<string> {
  const result = await harness.run(CREATE_CALENDAR, viewer, {
    input: { name },
  });
  if (result.data?.["createCalendar"] == null) {
    throw new Error(`createCalendar failed: ${JSON.stringify(result.errors)}`);
  }
  return field<{ id: string }>(result, "createCalendar").id;
}

beforeEach(async () => {
  harness = createGraphQLHarness(createFakeDependencies({ now: NOW }));
  await seedUsers();
});

describe("calendar queries and mutations", () => {
  test("creates, reads, updates and deletes a calendar", async () => {
    const id = await createCalendar();

    const listed = await harness.run(
      "query { calendars { id name color } }",
      OWNER,
    );
    expect(listed.data?.["calendars"]).toEqual([
      { id, name: "Work", color: "#3b82f6" },
    ]);

    const updated = await harness.run(
      `mutation Update($id: ID!, $input: UpdateCalendarInput!) {
         updateCalendar(id: $id, input: $input) { id name color description }
       }`,
      OWNER,
      { id, input: { name: "Team", color: "#ff0000", description: "Ours" } },
    );
    expect(updated.data?.["updateCalendar"]).toEqual({
      id,
      name: "Team",
      color: "#ff0000",
      description: "Ours",
    });

    const deleted = await harness.run(
      `mutation Delete($id: ID!) { deleteCalendar(id: $id) }`,
      OWNER,
      { id },
    );
    expect(deleted.data?.["deleteCalendar"]).toBe(true);
    expect(
      (await harness.run("query { calendars { id } }", OWNER)).data?.[
        "calendars"
      ],
    ).toEqual([]);
  });

  test("hides another owner's calendar behind NOT_FOUND rather than FORBIDDEN", async () => {
    const id = await createCalendar();
    const read = await harness.run(
      `query Read($id: ID!) { calendar(id: $id) { id } }`,
      OTHER,
      { id },
    );
    expect(read.data?.["calendar"]).toBeNull();

    const write = await harness.run(
      `mutation Update($id: ID!, $input: UpdateCalendarInput!) {
         updateCalendar(id: $id, input: $input) { id }
       }`,
      OTHER,
      { id, input: { name: "Stolen" } },
    );
    expect(errorCodes(write)).toEqual(["NOT_FOUND"]);
  });

  test("rejects an unauthenticated request", async () => {
    const result = await harness.run("query { calendars { id } }", null);
    expect(errorCodes(result)).toEqual(["UNAUTHENTICATED"]);
  });

  test("creates a timed event with mentions and links and reads it back", async () => {
    const calendarId = await createCalendar();
    const created = await harness.run(CREATE_EVENT, OWNER, {
      input: {
        calendarId,
        title: "Standup",
        description: "Daily",
        location: "Room 1",
        time: {
          allDay: false,
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-01T00:30:00.000Z",
          timeZone: "Asia/Tokyo",
        },
        mentions: ["Taco@Example.com"],
        links: [{ url: "https://example.com/agenda", title: "Agenda" }],
      },
    });
    expect(created.errors).toBeUndefined();
    const event = field<Record<string, unknown>>(
      created,
      "createCalendarEvent",
    );
    expect(event).toMatchObject({
      title: "Standup",
      mentions: ["taco@example.com"],
      time: {
        allDay: false,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-01T00:30:00.000Z",
        timeZone: "Asia/Tokyo",
        startDate: null,
        endDateExclusive: null,
      },
      recurrence: null,
      exdates: [],
      overrideOfEventId: null,
      attachments: [],
    });
    expect(
      (event["links"] as readonly Record<string, unknown>[])[0],
    ).toMatchObject({ url: "https://example.com/agenda", title: "Agenda" });
    expect((event["calendar"] as { id: string }).id).toBe(calendarId);
  });

  test("creates an all-day event", async () => {
    const calendarId = await createCalendar();
    const created = await harness.run(CREATE_EVENT, OWNER, {
      input: {
        calendarId,
        title: "Conference",
        time: {
          allDay: true,
          startDate: "2026-09-01",
          endDateExclusive: "2026-09-03",
        },
      },
    });
    expect(
      field<Record<string, unknown>>(created, "createCalendarEvent")["time"],
    ).toEqual({
      allDay: true,
      startsAt: null,
      endsAt: null,
      timeZone: null,
      startDate: "2026-09-01",
      endDateExclusive: "2026-09-03",
    });
  });

  test("expands a recurring series over a range and reports overrides", async () => {
    const calendarId = await createCalendar();
    const created = await harness.run(CREATE_EVENT, OWNER, {
      input: {
        calendarId,
        title: "Weekly sync",
        time: {
          allDay: false,
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-01T01:00:00.000Z",
          timeZone: "UTC",
        },
        recurrence: { freq: "WEEKLY", interval: 1, count: 4 },
      },
    });
    const eventId = field<{ id: string }>(created, "createCalendarEvent").id;

    const listed = await harness.run(EVENTS_IN_RANGE, OWNER, {
      input: {
        rangeStart: "2026-09-01T00:00:00.000Z",
        rangeEnd: "2026-10-01T00:00:00.000Z",
      },
    });
    const page = field<{
      truncated: boolean;
      occurrences: readonly { occurrenceStart: string; isOverride: boolean }[];
    }>(listed, "calendarEvents");
    expect(page.truncated).toBe(false);
    expect(page.occurrences.map((entry) => entry.occurrenceStart)).toEqual([
      "2026-09-01T00:00:00.000Z",
      "2026-09-08T00:00:00.000Z",
      "2026-09-15T00:00:00.000Z",
      "2026-09-22T00:00:00.000Z",
    ]);

    // THIS_OCCURRENCE moves one instance: the series keeps its other three.
    const moved = await harness.run(
      `mutation Move($id: ID!, $input: UpdateCalendarEventInput!) {
         updateCalendarEvent(id: $id, input: $input) {
           id overrideOfEventId recurrenceInstanceStart title
         }
       }`,
      OWNER,
      {
        id: eventId,
        input: {
          title: "Moved sync",
          editScope: "THIS_OCCURRENCE",
          occurrenceStart: "2026-09-08T00:00:00.000Z",
        },
      },
    );
    expect(moved.data?.["updateCalendarEvent"]).toMatchObject({
      overrideOfEventId: eventId,
      recurrenceInstanceStart: "2026-09-08T00:00:00.000Z",
      title: "Moved sync",
    });

    const afterOverride = await harness.run(EVENTS_IN_RANGE, OWNER, {
      input: {
        rangeStart: "2026-09-01T00:00:00.000Z",
        rangeEnd: "2026-10-01T00:00:00.000Z",
      },
    });
    const occurrences = field<{
      occurrences: readonly {
        isOverride: boolean;
        event: { title: string };
      }[];
    }>(afterOverride, "calendarEvents").occurrences;
    expect(occurrences).toHaveLength(4);
    expect(
      occurrences.filter((entry) => entry.isOverride).map((e) => e.event.title),
    ).toEqual(["Moved sync"]);

    // THIS_OCCURRENCE delete drops exactly one instance via an EXDATE.
    const deleted = await harness.run(
      `mutation Del($id: ID!, $input: DeleteCalendarEventInput) {
         deleteCalendarEvent(id: $id, input: $input)
       }`,
      OWNER,
      {
        id: eventId,
        input: {
          editScope: "THIS_OCCURRENCE",
          occurrenceStart: "2026-09-15T00:00:00.000Z",
        },
      },
    );
    expect(deleted.data?.["deleteCalendarEvent"]).toBe(true);
    const afterExdate = await harness.run(EVENTS_IN_RANGE, OWNER, {
      input: {
        rangeStart: "2026-09-01T00:00:00.000Z",
        rangeEnd: "2026-10-01T00:00:00.000Z",
      },
    });
    expect(
      field<{ occurrences: readonly unknown[] }>(afterExdate, "calendarEvents")
        .occurrences,
    ).toHaveLength(3);
  });

  test("manages mentions and links by address and id", async () => {
    const calendarId = await createCalendar();
    const created = await harness.run(CREATE_EVENT, OWNER, {
      input: {
        calendarId,
        title: "Review",
        time: {
          allDay: false,
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-01T01:00:00.000Z",
        },
      },
    });
    const eventId = field<{ id: string }>(created, "createCalendarEvent").id;

    const mentioned = await harness.run(
      `mutation Mention($eventId: ID!, $address: String!) {
         addEventMention(eventId: $eventId, address: $address) { mentions }
       }`,
      OWNER,
      { eventId, address: "other@example.com" },
    );
    expect(mentioned.data?.["addEventMention"]).toEqual({
      mentions: ["other@example.com"],
    });

    const linked = await harness.run(
      `mutation Link($eventId: ID!, $input: EventLinkInput!) {
         addEventLink(eventId: $eventId, input: $input) {
           links { id url title }
         }
       }`,
      OWNER,
      { eventId, input: { url: "https://example.com/doc", title: "Doc" } },
    );
    const links = field<{
      links: readonly { id: string; url: string }[];
    }>(linked, "addEventLink").links;
    expect(links).toHaveLength(1);

    const unlinked = await harness.run(
      `mutation Unlink($eventId: ID!, $linkId: ID!) {
         removeEventLink(eventId: $eventId, linkId: $linkId) { links { id } }
       }`,
      OWNER,
      { eventId, linkId: links[0]?.id },
    );
    expect(unlinked.data?.["removeEventLink"]).toEqual({ links: [] });

    const unmentioned = await harness.run(
      `mutation Unmention($eventId: ID!, $address: String!) {
         removeEventMention(eventId: $eventId, address: $address) { mentions }
       }`,
      OWNER,
      { eventId, address: "other@example.com" },
    );
    expect(unmentioned.data?.["removeEventMention"]).toEqual({ mentions: [] });
  });

  test("a mentioned user reads the event through eventsMentioning", async () => {
    const calendarId = await createCalendar();
    await harness.run(CREATE_EVENT, OWNER, {
      input: {
        calendarId,
        title: "Planning",
        time: {
          allDay: false,
          startsAt: "2026-09-01T00:00:00.000Z",
          endsAt: "2026-09-01T01:00:00.000Z",
        },
        mentions: ["other@example.com"],
      },
    });

    const mine = await harness.run(
      `query Mentions($address: String!) {
         eventsMentioning(address: $address) { title mentions }
       }`,
      OTHER,
      { address: "other@example.com" },
    );
    expect(mine.data?.["eventsMentioning"]).toEqual([
      { title: "Planning", mentions: ["other@example.com"] },
    ]);

    // Someone else's address is reported absent, not forbidden: asking must
    // not confirm the address exists here.
    const theirs = await harness.run(
      `query Mentions($address: String!) {
         eventsMentioning(address: $address) { title }
       }`,
      OTHER,
      { address: "owner@example.com" },
    );
    expect(errorCodes(theirs)).toEqual(["NOT_FOUND"]);

    // An ADMIN may.
    const asAdmin = await harness.run(
      `query Mentions($address: String!) {
         eventsMentioning(address: $address) { title }
       }`,
      ADMIN,
      { address: "other@example.com" },
    );
    expect(asAdmin.data?.["eventsMentioning"]).toHaveLength(1);
  });

  test("a mail-only API key cannot see calendars at all", async () => {
    await createCalendar();
    const mailKey = apiKeyViewer([{ capability: Capability.MailRead }]);
    const result = await harness.run("query { calendars { id } }", mailKey);
    expect(result.data?.["calendars"]).toEqual([]);

    const write = await harness.run(CREATE_CALENDAR, mailKey, {
      input: { name: "Agent calendar" },
    });
    expect(errorCodes(write)).toEqual(["FORBIDDEN"]);
  });

  test("a CALENDAR_READ-scoped key reads the matching owner's calendars", async () => {
    const id = await createCalendar();
    const readKey = apiKeyViewer([
      {
        capability: Capability.CalendarRead,
        addressPattern: "owner@example.com",
      },
    ]);
    const listed = await harness.run("query { calendars { id } }", readKey);
    expect(listed.data?.["calendars"]).toEqual([{ id }]);

    const write = await harness.run(
      `mutation Update($id: ID!, $input: UpdateCalendarInput!) {
         updateCalendar(id: $id, input: $input) { id }
       }`,
      readKey,
      { id, input: { name: "Agent edit" } },
    );
    // The key holds no CALENDAR_WRITE scope at all, so the refusal is at the
    // capability level rather than the probe-resistant per-object level.
    expect(errorCodes(write)).toEqual(["FORBIDDEN"]);
  });
});

describe("caldav mutations", () => {
  test("reports SERVICE_UNAVAILABLE when no credential key is configured", async () => {
    harness = createGraphQLHarness(
      createFakeDependencies({ now: NOW, credentialCipherAvailable: false }),
    );
    await seedUsers();

    const result = await harness.run(
      `mutation Connect($input: ConnectCaldavAccountInput!) {
         connectCaldavAccount(input: $input) { account { id } }
       }`,
      OWNER,
      {
        input: {
          serverUrl: "https://caldav.icloud.com/",
          username: "owner@example.com",
          appPassword: "abcd-efgh-ijkl-mnop",
        },
      },
    );
    expect(errorCodes(result)).toEqual(["SERVICE_UNAVAILABLE"]);
  });

  test("connects an account, never echoing the password back", async () => {
    harness = createGraphQLHarness(
      createFakeDependencies({
        now: NOW,
        caldav: {
          discovery: {
            principalUrl: "https://p42-caldav.icloud.com/1/principal/",
            homeSetUrl: "https://p42-caldav.icloud.com/1/calendars/",
            calendars: [
              {
                remoteUrl: "https://p42-caldav.icloud.com/1/calendars/work/",
                displayName: "Work",
                ctag: "ctag-1",
                syncToken: "token-1",
              },
            ],
          },
        },
      }),
    );
    await seedUsers();

    const result = await harness.run(
      `mutation Connect($input: ConnectCaldavAccountInput!) {
         connectCaldavAccount(input: $input) {
           account { id userId serverUrl username principalUrl homeSetUrl }
           calendars { remoteUrl displayName ctag syncToken }
         }
       }`,
      OWNER,
      {
        input: {
          serverUrl: "https://caldav.icloud.com/",
          username: "owner@example.com",
          appPassword: "abcd-efgh-ijkl-mnop",
        },
      },
    );
    expect(result.errors).toBeUndefined();
    expect(JSON.stringify(result.data)).not.toContain("abcd-efgh-ijkl-mnop");
    expect(
      field<{ calendars: readonly unknown[] }>(result, "connectCaldavAccount")
        .calendars,
    ).toHaveLength(1);

    const accounts = await harness.run(
      "query { caldavAccounts { id username } }",
      OWNER,
    );
    expect(accounts.data?.["caldavAccounts"]).toHaveLength(1);
  });

  test("an API key may not connect a CalDAV account", async () => {
    const key = apiKeyViewer([{ capability: Capability.CalendarWrite }]);
    const result = await harness.run(
      `mutation Connect($input: ConnectCaldavAccountInput!) {
         connectCaldavAccount(input: $input) { account { id } }
       }`,
      key,
      {
        input: {
          serverUrl: "https://caldav.icloud.com/",
          username: "owner@example.com",
          appPassword: "abcd-efgh-ijkl-mnop",
        },
      },
    );
    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
  });
});

describe("calendar schema shape", () => {
  test("exposes no attendee, RSVP or participation field", async () => {
    const introspection = await harness.run(
      `query {
         __schema { types { name fields { name } inputFields { name } } }
       }`,
      OWNER,
    );
    const types = field<{
      types: readonly {
        name: string;
        fields: readonly { name: string }[] | null;
        inputFields: readonly { name: string }[] | null;
      }[];
    }>(introspection, "__schema").types;
    // Scoped to the calendar types: `Thread.participants` is mail's, and
    // predates this feature.
    const calendarTypes = types.filter((type) =>
      /^(Calendar|Event|Caldav|Recurrence|Sync|Connect|Link|Update|Create|Delete)/.test(
        type.name,
      ),
    );
    expect(calendarTypes.length).toBeGreaterThan(10);
    const serialized = JSON.stringify(calendarTypes).toLowerCase();
    for (const forbidden of ["attendee", "partstat", "rsvp", "participa"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
