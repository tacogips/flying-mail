import {
  CaldavAuthError,
  type CaldavCredentials,
  CaldavTransportError,
  type RemoteCalendarRef,
} from "@mailcal/application/ports/caldav";
import { describe, expect, test } from "vitest";
import { createCaldavClient } from "./caldav-client";

const CREDENTIALS: CaldavCredentials = {
  serverUrl: "https://caldav.icloud.com/",
  username: "taco@example.com",
  password: "abcd-efgh-ijkl-mnop",
};

const REMOTE: RemoteCalendarRef = {
  credentials: CREDENTIALS,
  remoteUrl: "https://p42-caldav.icloud.com/1234/calendars/work/",
};

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface CannedResponse {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

type Route = (request: RecordedRequest) => CannedResponse | null;

/** A scripted `fetch` that records every call. Every test drives canned
 * fixtures -- nothing here ever touches a network or a real credential. */
function fakeFetch(routes: readonly Route[]): {
  readonly fetchImpl: typeof fetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const recorded: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(recorded);

    for (const route of routes) {
      const canned = route(recorded);
      if (canned !== null) {
        const status = canned.status ?? 207;
        // 204/205/304 must be constructed with a null body.
        const nullBody = status === 204 || status === 205 || status === 304;
        return new Response(nullBody ? null : (canned.body ?? ""), {
          status,
          headers: canned.headers ?? {},
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function multistatus(inner: string, syncToken?: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">' +
    inner +
    (syncToken === undefined
      ? ""
      : `<D:sync-token>${syncToken}</D:sync-token>`) +
    "</D:multistatus>"
  );
}

describe("caldav discovery", () => {
  test("follows a cross-host redirect while keeping Basic auth", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url === "https://caldav.icloud.com/.well-known/caldav"
          ? {
              status: 301,
              headers: {
                location: "https://p42-caldav.icloud.com/.well-known/caldav",
              },
            }
          : null,
      (request) =>
        request.url === "https://p42-caldav.icloud.com/.well-known/caldav"
          ? {
              body: multistatus(
                "<D:response><D:href>/.well-known/caldav</D:href><D:propstat>" +
                  "<D:prop><D:current-user-principal><D:href>/1234/principal/</D:href></D:current-user-principal></D:prop>" +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url === "https://p42-caldav.icloud.com/1234/principal/"
          ? {
              body: multistatus(
                "<D:response><D:href>/1234/principal/</D:href><D:propstat>" +
                  "<D:prop><C:calendar-home-set><D:href>https://p42-caldav.icloud.com/1234/calendars/</D:href></C:calendar-home-set></D:prop>" +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url === "https://p42-caldav.icloud.com/1234/calendars/"
          ? {
              body: multistatus(
                // The home set itself.
                "<D:response><D:href>/1234/calendars/</D:href><D:propstat><D:prop>" +
                  "<D:resourcetype><D:collection/></D:resourcetype>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
                  // A VEVENT calendar.
                  "<D:response><D:href>/1234/calendars/work/</D:href><D:propstat><D:prop>" +
                  "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>" +
                  "<D:displayname>Work &amp; Life</D:displayname>" +
                  '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
                  "<CS:getctag>ctag-1</CS:getctag>" +
                  "<D:sync-token>token-1</D:sync-token>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
                  // A tasks-only collection, which must be filtered out.
                  "<D:response><D:href>/1234/calendars/tasks/</D:href><D:propstat><D:prop>" +
                  "<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>" +
                  "<D:displayname>Reminders</D:displayname>" +
                  '<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>' +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
    ]);

    const discovery = await createCaldavClient({ fetchImpl }).discover(
      CREDENTIALS,
    );

    expect(discovery.principalUrl).toBe(
      "https://p42-caldav.icloud.com/1234/principal/",
    );
    expect(discovery.homeSetUrl).toBe(
      "https://p42-caldav.icloud.com/1234/calendars/",
    );
    expect(discovery.calendars).toEqual([
      {
        remoteUrl: "https://p42-caldav.icloud.com/1234/calendars/work/",
        displayName: "Work & Life",
        ctag: "ctag-1",
        syncToken: "token-1",
      },
    ]);

    // Every request, including the ones after the cross-host redirect,
    // carries the Authorization header.
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.headers["authorization"]).toMatch(/^Basic /);
    }
  });

  test("falls back to the server URL when .well-known is not served", async () => {
    const { fetchImpl } = fakeFetch([
      (request) =>
        request.url.includes(".well-known") ? { status: 404, body: "" } : null,
      (request) =>
        request.url === "https://caldav.icloud.com/"
          ? {
              body: multistatus(
                "<D:response><D:href>/</D:href><D:propstat><D:prop>" +
                  "<D:current-user-principal><D:href>/1234/principal/</D:href></D:current-user-principal>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url.endsWith("/1234/principal/")
          ? {
              body: multistatus(
                "<D:response><D:href>/1234/principal/</D:href><D:propstat><D:prop>" +
                  "<C:calendar-home-set><D:href>/1234/calendars/</D:href></C:calendar-home-set>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url.endsWith("/1234/calendars/")
          ? { body: multistatus("") }
          : null,
    ]);

    const discovery = await createCaldavClient({ fetchImpl }).discover(
      CREDENTIALS,
    );
    expect(discovery.homeSetUrl).toBe(
      "https://caldav.icloud.com/1234/calendars/",
    );
    expect(discovery.calendars).toEqual([]);
  });

  test("maps a 401 onto CaldavAuthError", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 401, body: "" })]);
    await expect(
      createCaldavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CaldavAuthError);
  });

  test("maps a 5xx onto CaldavTransportError", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 503, body: "" })]);
    await expect(
      createCaldavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CaldavTransportError);
  });
});

describe("caldav listChanges", () => {
  const ctagResponse = {
    body: multistatus(
      "<D:response><D:href>/1234/calendars/work/</D:href><D:propstat><D:prop>" +
        "<CS:getctag>ctag-9</CS:getctag></D:prop>" +
        "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
    ),
  };

  test("reads changed and deleted hrefs plus the new sync token", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) => (request.method === "PROPFIND" ? ctagResponse : null),
      (request) =>
        request.method === "REPORT"
          ? {
              body: multistatus(
                "<D:response><D:href>/1234/calendars/work/a.ics</D:href><D:propstat>" +
                  '<D:prop><D:getetag>"etag-a"</D:getetag></D:prop>' +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
                  "<D:response><D:href>/1234/calendars/work/gone.ics</D:href>" +
                  "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
                "token-2",
              ),
            }
          : null,
    ]);

    const changes = await createCaldavClient({ fetchImpl }).listChanges(
      REMOTE,
      "token-1",
    );

    expect(changes.changedHrefs).toEqual([
      "https://p42-caldav.icloud.com/1234/calendars/work/a.ics",
    ]);
    expect(changes.deletedHrefs).toEqual([
      "https://p42-caldav.icloud.com/1234/calendars/work/gone.ics",
    ]);
    expect(changes.syncToken).toBe("token-2");
    expect(changes.ctag).toBe("ctag-9");
    expect(changes.fullResync).toBe(false);

    const report = requests.find((request) => request.method === "REPORT");
    expect(report?.body).toContain("<d:sync-token>token-1</d:sync-token>");
    expect(report?.headers["depth"]).toBe("1");
  });

  test("marks an initial sync (no token) as a full resync", async () => {
    const { fetchImpl } = fakeFetch([
      (request) => (request.method === "PROPFIND" ? ctagResponse : null),
      (request) =>
        request.method === "REPORT"
          ? { body: multistatus("", "token-first") }
          : null,
    ]);
    const changes = await createCaldavClient({ fetchImpl }).listChanges(
      REMOTE,
      null,
    );
    expect(changes.fullResync).toBe(true);
    expect(changes.syncToken).toBe("token-first");
  });

  test("falls back to an etag PROPFIND listing when the report is refused", async () => {
    let propfindCalls = 0;
    const { fetchImpl } = fakeFetch([
      (request) => {
        if (request.method !== "PROPFIND") {
          return null;
        }
        propfindCalls += 1;
        if (propfindCalls === 1) {
          return ctagResponse;
        }
        return {
          body: multistatus(
            "<D:response><D:href>/1234/calendars/work/</D:href><D:propstat><D:prop>" +
              "<D:resourcetype><D:collection/></D:resourcetype></D:prop>" +
              "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
              "<D:response><D:href>/1234/calendars/work/a.ics</D:href><D:propstat>" +
              '<D:prop><D:getetag>"etag-a"</D:getetag></D:prop>' +
              "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
              "<D:response><D:href>/1234/calendars/work/b.ics</D:href><D:propstat>" +
              '<D:prop><D:getetag>"etag-b"</D:getetag></D:prop>' +
              "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
          ),
        };
      },
      // 507 Insufficient Storage is what a server returns for a token it
      // can no longer honor.
      (request) =>
        request.method === "REPORT" ? { status: 507, body: "" } : null,
    ]);

    const changes = await createCaldavClient({ fetchImpl }).listChanges(
      REMOTE,
      "stale-token",
    );
    expect(changes.changedHrefs).toEqual([
      "https://p42-caldav.icloud.com/1234/calendars/work/a.ics",
      "https://p42-caldav.icloud.com/1234/calendars/work/b.ics",
    ]);
    expect(changes.fullResync).toBe(true);
    expect(changes.syncToken).toBeNull();
  });
});

describe("caldav multiget", () => {
  test("chunks hrefs and returns each object with its etag", async () => {
    const hrefs = Array.from(
      { length: 5 },
      (_unused, index) =>
        `https://p42-caldav.icloud.com/1234/calendars/work/${index}.ics`,
    );
    const bodies: string[] = [];
    const { fetchImpl } = fakeFetch([
      (request) => {
        bodies.push(request.body);
        const matched = [
          ...request.body.matchAll(/<d:href>([^<]+)<\/d:href>/g),
        ];
        return {
          body: multistatus(
            matched
              .map(
                (match) =>
                  `<D:response><D:href>${match[1]}</D:href><D:propstat><D:prop>` +
                  `<D:getetag>"etag-${match[1]?.slice(-5, -4)}"</D:getetag>` +
                  "<C:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR</C:calendar-data>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              )
              .join(""),
          ),
        };
      },
    ]);

    const objects = await createCaldavClient({
      fetchImpl,
      multigetChunkSize: 2,
    }).multigetEvents(REMOTE, hrefs);

    expect(bodies).toHaveLength(3);
    expect(objects).toHaveLength(5);
    expect(objects[0]?.etag).toBe('"etag-0"');
    expect(objects[0]?.ics).toContain("BEGIN:VCALENDAR");
  });
});

describe("caldav writes", () => {
  test("creates with If-None-Match and updates with If-Match", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.method === "PUT" && request.headers["if-none-match"] === "*"
          ? { status: 201, headers: { etag: '"new-etag"' } }
          : null,
      (request) =>
        request.method === "PUT"
          ? { status: 204, headers: { etag: '"next-etag"' } }
          : null,
    ]);
    const client = createCaldavClient({ fetchImpl });

    const created = await client.putEvent(
      REMOTE,
      "https://p42-caldav.icloud.com/1234/calendars/work/a.ics",
      "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      null,
    );
    expect(created).toEqual({ outcome: "CREATED", etag: '"new-etag"' });

    const updated = await client.putEvent(
      REMOTE,
      "https://p42-caldav.icloud.com/1234/calendars/work/a.ics",
      "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      '"old-etag"',
    );
    expect(updated).toEqual({ outcome: "UPDATED", etag: '"next-etag"' });
    expect(requests[1]?.headers["if-match"]).toBe('"old-etag"');
    expect(requests[1]?.headers["content-type"]).toMatch(/text\/calendar/);
  });

  test("reports a 412 as a conflict rather than throwing", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 412, body: "" })]);
    const client = createCaldavClient({ fetchImpl });
    expect(await client.putEvent(REMOTE, "a.ics", "ics", '"stale"')).toEqual({
      outcome: "CONFLICT",
      etag: null,
    });
    expect(await client.deleteEvent(REMOTE, "a.ics", '"stale"')).toEqual({
      outcome: "CONFLICT",
    });
  });

  test("treats a 404 delete as already absent", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) => (request.method === "DELETE" ? { status: 404 } : null),
    ]);
    expect(
      await createCaldavClient({ fetchImpl }).deleteEvent(
        REMOTE,
        "https://p42-caldav.icloud.com/1234/calendars/work/a.ics",
        '"etag-a"',
      ),
    ).toEqual({ outcome: "ALREADY_ABSENT" });
    expect(requests[0]?.headers["if-match"]).toBe('"etag-a"');
  });

  test("deletes successfully and reports DELETED", async () => {
    const { fetchImpl } = fakeFetch([
      (request) => (request.method === "DELETE" ? { status: 204 } : null),
    ]);
    expect(
      await createCaldavClient({ fetchImpl }).deleteEvent(
        REMOTE,
        "a.ics",
        null,
      ),
    ).toEqual({ outcome: "DELETED" });
  });
});

describe("credential transport safety", () => {
  test("refuses to send credentials over plain http", async () => {
    const { fetchImpl, requests } = fakeFetch([() => ({ status: 207 })]);
    await expect(
      createCaldavClient({ fetchImpl }).discover({
        ...CREDENTIALS,
        serverUrl: "http://attacker.example/",
      }),
    ).rejects.toBeInstanceOf(CaldavTransportError);
    // The point of the check: nothing was sent at all.
    expect(requests).toHaveLength(0);
  });

  test("still allows plain http on localhost, as the domain rule does", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url.startsWith("http://localhost")
          ? { status: 404, body: "" }
          : null,
    ]);
    await expect(
      createCaldavClient({ fetchImpl }).discover({
        ...CREDENTIALS,
        serverUrl: "http://localhost:8080/",
      }),
    ).rejects.toBeInstanceOf(CaldavTransportError);
    // Reached the network (and failed on discovery, not on the scheme).
    expect(requests.length).toBeGreaterThan(0);
  });

  test("refuses an https -> http redirect without leaking the header", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url.startsWith("https://")
          ? {
              status: 302,
              headers: { location: "http://harvester.example/caldav" },
            }
          : null,
    ]);

    await expect(
      createCaldavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CaldavTransportError);
    expect(requests.some((request) => request.url.startsWith("http://"))).toBe(
      false,
    );
  });

  test("still follows the iCloud cross-host https redirect with auth attached", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url === "https://caldav.icloud.com/.well-known/caldav"
          ? {
              status: 301,
              headers: {
                location: "https://p42-caldav.icloud.com/.well-known/caldav",
              },
            }
          : null,
      () => ({ status: 404, body: "" }),
    ]);

    await expect(
      createCaldavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CaldavTransportError);
    const shard = requests.find((request) =>
      request.url.startsWith("https://p42-caldav.icloud.com"),
    );
    expect(shard?.headers["authorization"]).toMatch(/^Basic /);
  });
});
