import {
  CaldavAuthError,
  type CaldavChangeSet,
  type CaldavClient,
  type CaldavCredentials,
  type CaldavDeleteResult,
  type CaldavDiscoveredCalendar,
  type CaldavDiscovery,
  type CaldavObject,
  type CaldavPutResult,
  CaldavTransportError,
  type RemoteCalendarRef,
} from "@mailcal/application/ports/caldav";
import {
  escapeXmlText,
  findChild,
  findOkProp,
  findOkPropText,
  type MultistatusResponse,
  parseMultistatus,
} from "./xml";

export interface CaldavClientOptions {
  /** Injected so tests drive canned multistatus fixtures instead of the
   * network, and so the Worker's own `fetch` binding can be passed in. */
  readonly fetchImpl?: typeof fetch;
  readonly userAgent?: string;
  /** `calendar-multiget` request size. iCloud tolerates far more, but a
   * Worker request has a subrequest budget and a body size to build. */
  readonly multigetChunkSize?: number;
  readonly maxRedirects?: number;
}

const DEFAULT_MULTIGET_CHUNK = 50;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "mailcal/0.1 (+https://github.com/tacogips/mailcal)";

const XML_CONTENT_TYPE = 'application/xml; charset="utf-8"';

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  /** The URL the response actually came from, after redirects -- relative
   * hrefs inside it must be resolved against this, not the request URL. */
  readonly url: string;
}

function basicAuth(credentials: CaldavCredentials): string {
  // `btoa` is Latin-1 only; app-specific passwords are ASCII, but a UTF-8
  // username would otherwise throw rather than authenticate.
  const raw = `${credentials.username}:${credentials.password}`;
  let binary = "";
  for (const byte of new TextEncoder().encode(raw)) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${btoa(binary)}`;
}

/** Basic auth may only ride on a channel that protects it. Mirrors the
 * domain's `normalizeCaldavServerUrl` rule so the transport cannot be talked
 * into something the entity would have rejected. */
function isCredentialSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
  );
}

/** Resolves an href that may be absolute, root-relative or relative. */
export function resolveHref(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

export function createCaldavClient(
  options: CaldavClientOptions = {},
): CaldavClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const multigetChunkSize = options.multigetChunkSize ?? DEFAULT_MULTIGET_CHUNK;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  /** Redirects are followed by hand with `redirect: "manual"`.
   *
   * `fetch` strips `Authorization` when a redirect crosses origins, and
   * iCloud's discovery *always* crosses origins (`caldav.icloud.com` ->
   * `pXX-caldav.icloud.com`). Following the chain ourselves is what keeps
   * Basic auth attached, which is the difference between discovery working
   * and every request coming back 401. */
  async function request(
    method: string,
    url: string,
    init: {
      readonly credentials: CaldavCredentials;
      readonly body?: string;
      readonly depth?: "0" | "1";
      readonly contentType?: string;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<RawResponse> {
    if (!isCredentialSafeUrl(url)) {
      throw new CaldavTransportError(
        `CalDAV ${method} refused to send credentials to ${url}`,
      );
    }
    let currentUrl = url;
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      const headers = new Headers({
        Authorization: basicAuth(init.credentials),
        "User-Agent": userAgent,
        ...(init.depth === undefined ? {} : { Depth: init.depth }),
        ...(init.body === undefined
          ? {}
          : { "Content-Type": init.contentType ?? XML_CONTENT_TYPE }),
        ...init.headers,
      });

      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          redirect: "manual",
        });
      } catch (error) {
        throw new CaldavTransportError(
          `CalDAV ${method} ${currentUrl} failed`,
          error,
        );
      }

      if (
        response.status >= 300 &&
        response.status < 400 &&
        attempt < maxRedirects
      ) {
        const location = response.headers.get("location");
        if (location !== null) {
          const target = resolveHref(location, currentUrl);
          // A cross-host hop is expected here -- iCloud always redirects
          // `caldav.icloud.com` to a `pXX-` shard, and the Authorization
          // header is deliberately re-attached so discovery works. That is
          // exactly why the target has to be checked: without this, a server
          // could 302 to `http://` or to a host of its choosing and be
          // handed the app-specific password in cleartext.
          if (!isCredentialSafeUrl(target)) {
            throw new CaldavTransportError(
              `CalDAV ${method} refused a redirect to an insecure location`,
            );
          }
          currentUrl = target;
          continue;
        }
      }

      const body = await response.text();
      if (response.status === 401) {
        throw new CaldavAuthError(
          "CalDAV server rejected the credentials (401)",
        );
      }
      if (response.status >= 500) {
        throw new CaldavTransportError(
          `CalDAV ${method} ${currentUrl} returned ${response.status}`,
        );
      }
      return {
        status: response.status,
        headers: response.headers,
        body,
        url: response.url === "" ? currentUrl : response.url,
      };
    }
    throw new CaldavTransportError(
      `CalDAV ${method} ${url} exceeded ${maxRedirects} redirects`,
    );
  }

  function propfindBody(properties: readonly string[]): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ' +
      'xmlns:cs="http://calendarserver.org/ns/"><d:prop>' +
      properties.map((name) => `<${name}/>`).join("") +
      "</d:prop></d:propfind>"
    );
  }

  async function propfind(
    credentials: CaldavCredentials,
    url: string,
    depth: "0" | "1",
    properties: readonly string[],
  ): Promise<RawResponse> {
    return request("PROPFIND", url, {
      credentials,
      depth,
      body: propfindBody(properties),
    });
  }

  function firstHrefProp(
    response: RawResponse,
    property: string,
  ): string | null {
    for (const entry of parseMultistatus(response.body).responses) {
      const prop = findOkProp(entry, property);
      const href = prop === null ? null : findChild(prop, "href");
      if (href !== null && href.text.length > 0) {
        return resolveHref(href.text, response.url);
      }
    }
    return null;
  }

  function isVeventCalendar(entry: MultistatusResponse): boolean {
    const resourceType = findOkProp(entry, "resourcetype");
    if (resourceType === null || findChild(resourceType, "calendar") === null) {
      return false;
    }
    const components = findOkProp(entry, "supported-calendar-component-set");
    if (components === null) {
      // Absent means "everything"; a collection that advertises nothing is
      // still a calendar.
      return true;
    }
    return components.children.some(
      (child) =>
        child.name === "comp" &&
        (child.attributes.get("name") ?? "").toUpperCase() === "VEVENT",
    );
  }

  async function discover(
    credentials: CaldavCredentials,
  ): Promise<CaldavDiscovery> {
    const serverUrl = new URL(credentials.serverUrl);
    const wellKnown = new URL("/.well-known/caldav", serverUrl).toString();

    let principalUrl: string | null = null;
    for (const candidate of [wellKnown, serverUrl.toString()]) {
      let response: RawResponse;
      try {
        response = await propfind(credentials, candidate, "0", [
          "d:current-user-principal",
        ]);
      } catch (error) {
        if (error instanceof CaldavAuthError) {
          throw error;
        }
        continue;
      }
      if (response.status >= 400) {
        continue;
      }
      principalUrl = firstHrefProp(response, "current-user-principal");
      if (principalUrl !== null) {
        break;
      }
    }
    if (principalUrl === null) {
      throw new CaldavTransportError(
        "CalDAV discovery failed: no current-user-principal was returned",
      );
    }

    const homeResponse = await propfind(credentials, principalUrl, "0", [
      "c:calendar-home-set",
    ]);
    const homeSetUrl = firstHrefProp(homeResponse, "calendar-home-set");
    if (homeSetUrl === null) {
      throw new CaldavTransportError(
        "CalDAV discovery failed: no calendar-home-set was returned",
      );
    }

    const listing = await propfind(credentials, homeSetUrl, "1", [
      "d:resourcetype",
      "d:displayname",
      "c:supported-calendar-component-set",
      "cs:getctag",
      "d:sync-token",
    ]);
    const calendars: CaldavDiscoveredCalendar[] = [];
    for (const entry of parseMultistatus(listing.body).responses) {
      if (!isVeventCalendar(entry)) {
        continue;
      }
      const remoteUrl = resolveHref(entry.href, listing.url);
      if (remoteUrl === homeSetUrl) {
        continue;
      }
      calendars.push({
        remoteUrl,
        displayName: findOkPropText(entry, "displayname"),
        ctag: findOkPropText(entry, "getctag"),
        syncToken: findOkPropText(entry, "sync-token"),
      });
    }

    return { principalUrl, homeSetUrl, calendars };
  }

  /** RFC 6578 `sync-collection`. An empty `<sync-token/>` asks for the whole
   * collection plus a fresh token, which is what an initial sync wants. */
  function syncCollectionBody(syncToken: string | null): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:sync-collection xmlns:d="DAV:"><d:sync-token>' +
      (syncToken === null ? "" : escapeXmlText(syncToken)) +
      "</d:sync-token><d:sync-level>1</d:sync-level>" +
      "<d:prop><d:getetag/></d:prop></d:sync-collection>"
    );
  }

  async function listChanges(
    calendar: RemoteCalendarRef,
    syncToken: string | null,
  ): Promise<CaldavChangeSet> {
    const { credentials, remoteUrl } = calendar;

    // ctag comes from a cheap Depth 0 PROPFIND: `sync-collection` does not
    // return it, and it is what a future "has anything changed at all"
    // shortcut would compare.
    let ctag: string | null = null;
    try {
      const head = await propfind(credentials, remoteUrl, "0", [
        "cs:getctag",
        "d:sync-token",
      ]);
      const entry = parseMultistatus(head.body).responses[0];
      ctag = entry === undefined ? null : findOkPropText(entry, "getctag");
    } catch (error) {
      if (error instanceof CaldavAuthError) {
        throw error;
      }
      ctag = null;
    }

    let report: RawResponse | null = null;
    try {
      report = await request("REPORT", remoteUrl, {
        credentials,
        depth: "1",
        body: syncCollectionBody(syncToken),
      });
    } catch (error) {
      if (error instanceof CaldavAuthError) {
        throw error;
      }
      report = null;
    }

    // 403 with `valid-sync-token`, 409 and 507 all mean "start over"; so
    // does a server that does not implement the report at all.
    if (report !== null && report.status < 400) {
      const multistatus = parseMultistatus(report.body);
      const changedHrefs: string[] = [];
      const deletedHrefs: string[] = [];
      for (const entry of multistatus.responses) {
        const href = resolveHref(entry.href, report.url);
        const status =
          entry.statusCode ?? entry.propstats[0]?.statusCode ?? 200;
        if (status === 404 || status === 410) {
          deletedHrefs.push(href);
          continue;
        }
        if (href.endsWith("/")) {
          // The collection itself is reported as a member on some servers.
          continue;
        }
        changedHrefs.push(href);
      }
      return {
        changedHrefs,
        deletedHrefs,
        syncToken: multistatus.syncToken,
        ctag,
        fullResync: syncToken === null,
      };
    }

    // Fallback: a Depth 1 etag listing. Every member is reported as changed
    // and `fullResync` tells the caller that anything absent is gone.
    const listing = await propfind(credentials, remoteUrl, "1", [
      "d:getetag",
      "d:resourcetype",
    ]);
    const changedHrefs: string[] = [];
    for (const entry of parseMultistatus(listing.body).responses) {
      const href = resolveHref(entry.href, listing.url);
      if (href.endsWith("/") || findOkProp(entry, "getetag") === null) {
        continue;
      }
      changedHrefs.push(href);
    }
    return {
      changedHrefs,
      deletedHrefs: [],
      syncToken: null,
      ctag,
      fullResync: true,
    };
  }

  function multigetBody(hrefs: readonly string[]): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      "<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
      hrefs.map((href) => `<d:href>${escapeXmlText(href)}</d:href>`).join("") +
      "</c:calendar-multiget>"
    );
  }

  async function multigetEvents(
    calendar: RemoteCalendarRef,
    hrefs: readonly string[],
  ): Promise<readonly CaldavObject[]> {
    const objects: CaldavObject[] = [];
    for (let offset = 0; offset < hrefs.length; offset += multigetChunkSize) {
      const chunk = hrefs.slice(offset, offset + multigetChunkSize);
      const response = await request("REPORT", calendar.remoteUrl, {
        credentials: calendar.credentials,
        depth: "1",
        body: multigetBody(chunk),
      });
      if (response.status >= 400) {
        throw new CaldavTransportError(
          `CalDAV calendar-multiget returned ${response.status}`,
        );
      }
      for (const entry of parseMultistatus(response.body).responses) {
        const data = findOkProp(entry, "calendar-data");
        if (data === null || data.text.length === 0) {
          continue;
        }
        objects.push({
          href: resolveHref(entry.href, response.url),
          etag: findOkPropText(entry, "getetag"),
          ics: data.text,
        });
      }
    }
    return objects;
  }

  async function putEvent(
    calendar: RemoteCalendarRef,
    href: string,
    ics: string,
    etag: string | null,
  ): Promise<CaldavPutResult> {
    const response = await request(
      "PUT",
      resolveHref(href, calendar.remoteUrl),
      {
        credentials: calendar.credentials,
        body: ics,
        contentType: 'text/calendar; charset="utf-8"',
        // `If-None-Match: *` makes a create fail rather than clobber an
        // object that appeared since the last sync; `If-Match` does the same
        // for an update.
        headers:
          etag === null ? { "If-None-Match": "*" } : { "If-Match": etag },
      },
    );
    if (response.status === 412 || response.status === 409) {
      return { outcome: "CONFLICT", etag: null };
    }
    if (response.status >= 400) {
      throw new CaldavTransportError(`CalDAV PUT returned ${response.status}`);
    }
    return {
      outcome: response.status === 201 ? "CREATED" : "UPDATED",
      etag: response.headers.get("etag"),
    };
  }

  async function deleteEvent(
    calendar: RemoteCalendarRef,
    href: string,
    etag: string | null,
  ): Promise<CaldavDeleteResult> {
    const response = await request(
      "DELETE",
      resolveHref(href, calendar.remoteUrl),
      {
        credentials: calendar.credentials,
        ...(etag === null ? {} : { headers: { "If-Match": etag } }),
      },
    );
    if (response.status === 404 || response.status === 410) {
      // Already gone is the outcome the caller wanted.
      return { outcome: "ALREADY_ABSENT" };
    }
    if (response.status === 412) {
      return { outcome: "CONFLICT" };
    }
    if (response.status >= 400) {
      throw new CaldavTransportError(
        `CalDAV DELETE returned ${response.status}`,
      );
    }
    return { outcome: "DELETED" };
  }

  return { discover, listChanges, multigetEvents, putEvent, deleteEvent };
}
