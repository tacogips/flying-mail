import {
  CarddavAuthError,
  type CarddavCredentials,
  CarddavTransportError,
  type RemoteAddressBookRef,
} from "@flying-mail/application/ports/carddav";
import { describe, expect, test } from "vitest";
import { createCarddavClient } from "./carddav-client";

const CREDENTIALS: CarddavCredentials = {
  serverUrl: "https://contacts.icloud.com/",
  username: "taco@example.com",
  password: "abcd-efgh-ijkl-mnop",
};

const REMOTE: RemoteAddressBookRef = {
  credentials: CREDENTIALS,
  remoteUrl: "https://p42-contacts.icloud.com/1234/carddavhome/card/",
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
    '<D:multistatus xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">' +
    inner +
    (syncToken === undefined
      ? ""
      : `<D:sync-token>${syncToken}</D:sync-token>`) +
    "</D:multistatus>"
  );
}

describe("carddav discovery", () => {
  test("follows a cross-host redirect while keeping Basic auth", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url === "https://contacts.icloud.com/.well-known/carddav"
          ? {
              status: 301,
              headers: {
                location: "https://p42-contacts.icloud.com/.well-known/carddav",
              },
            }
          : null,
      (request) =>
        request.url === "https://p42-contacts.icloud.com/.well-known/carddav"
          ? {
              body: multistatus(
                "<D:response><D:href>/.well-known/carddav</D:href><D:propstat>" +
                  "<D:prop><D:current-user-principal><D:href>/1234/principal/</D:href></D:current-user-principal></D:prop>" +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url === "https://p42-contacts.icloud.com/1234/principal/"
          ? {
              body: multistatus(
                "<D:response><D:href>/1234/principal/</D:href><D:propstat>" +
                  "<D:prop><CARD:addressbook-home-set><D:href>https://p42-contacts.icloud.com/1234/carddavhome/</D:href></CARD:addressbook-home-set></D:prop>" +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url === "https://p42-contacts.icloud.com/1234/carddavhome/"
          ? {
              body: multistatus(
                // The home set itself.
                "<D:response><D:href>/1234/carddavhome/</D:href><D:propstat><D:prop>" +
                  "<D:resourcetype><D:collection/></D:resourcetype>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
                  // An addressbook collection.
                  "<D:response><D:href>/1234/carddavhome/card/</D:href><D:propstat><D:prop>" +
                  "<D:resourcetype><D:collection/><CARD:addressbook/></D:resourcetype>" +
                  "<D:displayname>Contacts &amp; Family</D:displayname>" +
                  "<CS:getctag>ctag-1</CS:getctag>" +
                  "<D:sync-token>token-1</D:sync-token>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
    ]);

    const discovery = await createCarddavClient({ fetchImpl }).discover(
      CREDENTIALS,
    );

    expect(discovery.principalUrl).toBe(
      "https://p42-contacts.icloud.com/1234/principal/",
    );
    expect(discovery.homeSetUrl).toBe(
      "https://p42-contacts.icloud.com/1234/carddavhome/",
    );
    expect(discovery.addressBooks).toEqual([
      {
        remoteUrl: "https://p42-contacts.icloud.com/1234/carddavhome/card/",
        displayName: "Contacts & Family",
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
        request.url === "https://contacts.icloud.com/"
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
                  "<CARD:addressbook-home-set><D:href>/1234/carddavhome/</D:href></CARD:addressbook-home-set>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      (request) =>
        request.url.endsWith("/1234/carddavhome/")
          ? { body: multistatus("") }
          : null,
    ]);

    const discovery = await createCarddavClient({ fetchImpl }).discover(
      CREDENTIALS,
    );
    expect(discovery.homeSetUrl).toBe(
      "https://contacts.icloud.com/1234/carddavhome/",
    );
    expect(discovery.addressBooks).toEqual([]);
  });

  test("maps a 401 onto CarddavAuthError", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 401, body: "" })]);
    await expect(
      createCarddavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CarddavAuthError);
  });

  test("maps a 5xx onto CarddavTransportError", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 503, body: "" })]);
    await expect(
      createCarddavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CarddavTransportError);
  });

  test("throws when no addressbook-home-set is returned", async () => {
    const { fetchImpl } = fakeFetch([
      (request) =>
        request.url.includes(".well-known")
          ? {
              body: multistatus(
                "<D:response><D:href>/.well-known/carddav</D:href><D:propstat>" +
                  "<D:prop><D:current-user-principal><D:href>/1234/principal/</D:href></D:current-user-principal></D:prop>" +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              ),
            }
          : null,
      () => ({ body: multistatus("") }),
    ]);
    await expect(
      createCarddavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CarddavTransportError);
  });
});

describe("carddav listChanges", () => {
  const ctagResponse = {
    body: multistatus(
      "<D:response><D:href>/1234/carddavhome/card/</D:href><D:propstat><D:prop>" +
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
                "<D:response><D:href>/1234/carddavhome/card/a.vcf</D:href><D:propstat>" +
                  '<D:prop><D:getetag>"etag-a"</D:getetag></D:prop>' +
                  "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
                  "<D:response><D:href>/1234/carddavhome/card/gone.vcf</D:href>" +
                  "<D:status>HTTP/1.1 404 Not Found</D:status></D:response>",
                "token-2",
              ),
            }
          : null,
    ]);

    const changes = await createCarddavClient({ fetchImpl }).listChanges(
      REMOTE,
      "token-1",
    );

    expect(changes.changedHrefs).toEqual([
      "https://p42-contacts.icloud.com/1234/carddavhome/card/a.vcf",
    ]);
    expect(changes.deletedHrefs).toEqual([
      "https://p42-contacts.icloud.com/1234/carddavhome/card/gone.vcf",
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
    const changes = await createCarddavClient({ fetchImpl }).listChanges(
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
            "<D:response><D:href>/1234/carddavhome/card/</D:href><D:propstat><D:prop>" +
              "<D:resourcetype><D:collection/></D:resourcetype></D:prop>" +
              "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
              "<D:response><D:href>/1234/carddavhome/card/a.vcf</D:href><D:propstat>" +
              '<D:prop><D:getetag>"etag-a"</D:getetag></D:prop>' +
              "<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>" +
              "<D:response><D:href>/1234/carddavhome/card/b.vcf</D:href><D:propstat>" +
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

    const changes = await createCarddavClient({ fetchImpl }).listChanges(
      REMOTE,
      "stale-token",
    );
    expect(changes.changedHrefs).toEqual([
      "https://p42-contacts.icloud.com/1234/carddavhome/card/a.vcf",
      "https://p42-contacts.icloud.com/1234/carddavhome/card/b.vcf",
    ]);
    expect(changes.fullResync).toBe(true);
    expect(changes.syncToken).toBeNull();
  });
});

describe("carddav multiget", () => {
  test("chunks hrefs and returns each object with its etag", async () => {
    const hrefs = Array.from(
      { length: 5 },
      (_unused, index) =>
        `https://p42-contacts.icloud.com/1234/carddavhome/card/${index}.vcf`,
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
                  "<CARD:address-data>BEGIN:VCARD&#13;&#10;END:VCARD</CARD:address-data>" +
                  "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>",
              )
              .join(""),
          ),
        };
      },
    ]);

    const objects = await createCarddavClient({
      fetchImpl,
      multigetChunkSize: 2,
    }).multigetContacts(REMOTE, hrefs);

    expect(bodies).toHaveLength(3);
    expect(objects).toHaveLength(5);
    expect(objects[0]?.etag).toBe('"etag-0"');
    expect(objects[0]?.vcard).toContain("BEGIN:VCARD");
  });
});

describe("carddav writes", () => {
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
    const client = createCarddavClient({ fetchImpl });

    const created = await client.putContact(
      REMOTE,
      "https://p42-contacts.icloud.com/1234/carddavhome/card/a.vcf",
      "BEGIN:VCARD\r\nEND:VCARD\r\n",
      null,
    );
    expect(created).toEqual({ outcome: "CREATED", etag: '"new-etag"' });

    const updated = await client.putContact(
      REMOTE,
      "https://p42-contacts.icloud.com/1234/carddavhome/card/a.vcf",
      "BEGIN:VCARD\r\nEND:VCARD\r\n",
      '"old-etag"',
    );
    expect(updated).toEqual({ outcome: "UPDATED", etag: '"next-etag"' });
    expect(requests[1]?.headers["if-match"]).toBe('"old-etag"');
    expect(requests[1]?.headers["content-type"]).toMatch(/text\/vcard/);
  });

  test("reports a 412 as a conflict rather than throwing", async () => {
    const { fetchImpl } = fakeFetch([() => ({ status: 412, body: "" })]);
    const client = createCarddavClient({ fetchImpl });
    expect(
      await client.putContact(REMOTE, "a.vcf", "vcard", '"stale"'),
    ).toEqual({ outcome: "CONFLICT", etag: null });
    expect(await client.deleteContact(REMOTE, "a.vcf", '"stale"')).toEqual({
      outcome: "CONFLICT",
    });
  });

  test("treats a 404 delete as already absent", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) => (request.method === "DELETE" ? { status: 404 } : null),
    ]);
    expect(
      await createCarddavClient({ fetchImpl }).deleteContact(
        REMOTE,
        "https://p42-contacts.icloud.com/1234/carddavhome/card/a.vcf",
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
      await createCarddavClient({ fetchImpl }).deleteContact(
        REMOTE,
        "a.vcf",
        null,
      ),
    ).toEqual({ outcome: "DELETED" });
  });
});

describe("credential transport safety", () => {
  test("refuses to send credentials over plain http", async () => {
    const { fetchImpl, requests } = fakeFetch([() => ({ status: 207 })]);
    await expect(
      createCarddavClient({ fetchImpl }).discover({
        ...CREDENTIALS,
        serverUrl: "http://attacker.example/",
      }),
    ).rejects.toBeInstanceOf(CarddavTransportError);
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
      createCarddavClient({ fetchImpl }).discover({
        ...CREDENTIALS,
        serverUrl: "http://localhost:8080/",
      }),
    ).rejects.toBeInstanceOf(CarddavTransportError);
    // Reached the network (and failed on discovery, not on the scheme).
    expect(requests.length).toBeGreaterThan(0);
  });

  test("refuses an https -> http redirect without leaking the header", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url.startsWith("https://")
          ? {
              status: 302,
              headers: { location: "http://harvester.example/carddav" },
            }
          : null,
    ]);

    await expect(
      createCarddavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CarddavTransportError);
    expect(requests.some((request) => request.url.startsWith("http://"))).toBe(
      false,
    );
  });

  test("still follows the iCloud cross-host https redirect with auth attached", async () => {
    const { fetchImpl, requests } = fakeFetch([
      (request) =>
        request.url === "https://contacts.icloud.com/.well-known/carddav"
          ? {
              status: 301,
              headers: {
                location: "https://p42-contacts.icloud.com/.well-known/carddav",
              },
            }
          : null,
      () => ({ status: 404, body: "" }),
    ]);

    await expect(
      createCarddavClient({ fetchImpl }).discover(CREDENTIALS),
    ).rejects.toBeInstanceOf(CarddavTransportError);
    const shard = requests.find((request) =>
      request.url.startsWith("https://p42-contacts.icloud.com"),
    );
    expect(shard?.headers["authorization"]).toMatch(/^Basic /);
  });
});
