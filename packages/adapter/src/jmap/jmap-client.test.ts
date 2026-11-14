import {
  ExternalMailAuthError,
  ExternalMailTransportError,
} from "@flying-mail/application/ports/external-mail";
import { describe, expect, test } from "vitest";
import { createJmapClient } from "./jmap-client";

const SESSION_URL = "https://api.fastmail.com/jmap/session";
const API_URL = "https://api.fastmail.com/jmap/api/";
const DOWNLOAD_TEMPLATE =
  "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}";
const ACCOUNT_ID = "acc-1";

const CREDENTIALS = {
  sessionUrl: SESSION_URL,
  username: "taco@fastmail.com",
  password: "hunter2",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sessionBody(): unknown {
  return {
    capabilities: {},
    accounts: { [ACCOUNT_ID]: { name: "taco" } },
    primaryAccounts: { "urn:ietf:params:jmap:mail": ACCOUNT_ID },
    username: CREDENTIALS.username,
    apiUrl: API_URL,
    downloadUrl: DOWNLOAD_TEMPLATE,
    uploadUrl: "https://api.fastmail.com/jmap/upload/",
    eventSourceUrl: "https://api.fastmail.com/jmap/event/",
    state: "state-1",
  };
}

function methodResponse(name: string, args: Record<string, unknown>): unknown {
  return { methodResponses: [[name, args, "call"]] };
}

interface FakeFetchConfig {
  readonly sessionStatus?: number;
  readonly sessionBody?: unknown;
  readonly mailboxGet?: () => Response;
  readonly emailQuery?: (args: Record<string, unknown>) => Response;
  readonly emailGet?: (args: Record<string, unknown>) => Response;
  readonly download?: (url: string) => Response;
}

function createFakeFetch(
  config: FakeFetchConfig,
  calls: string[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === SESSION_URL) {
      calls.push("session");
      return jsonResponse(
        config.sessionStatus ?? 200,
        config.sessionBody ?? sessionBody(),
      );
    }
    if (url.startsWith(API_URL)) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed: {
        methodCalls: [string, Record<string, unknown>, string][];
      } = JSON.parse(bodyText);
      const methodName = parsed.methodCalls[0]?.[0];
      const methodArgs = parsed.methodCalls[0]?.[1] ?? {};
      calls.push(methodName ?? "unknown");
      if (methodName === "Mailbox/get" && config.mailboxGet)
        return config.mailboxGet();
      if (methodName === "Email/query" && config.emailQuery)
        return config.emailQuery(methodArgs);
      if (methodName === "Email/get" && config.emailGet)
        return config.emailGet(methodArgs);
      throw new Error(`unhandled JMAP method in test: ${methodName}`);
    }
    if (config.download) {
      calls.push(`download:${url}`);
      return config.download(url);
    }
    throw new Error(`unhandled fetch url in test: ${url}`);
  }) as unknown as typeof fetch;
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const DEFAULT_MAILBOX_GET = (): Response =>
  jsonResponse(
    200,
    methodResponse("Mailbox/get", {
      accountId: ACCOUNT_ID,
      list: [
        { id: "mb-archive", role: "archive" },
        { id: "mb-inbox", role: "inbox" },
      ],
      notFound: [],
    }),
  );

describe("jmap-client", () => {
  test("testConnection performs the session GET and nothing past it", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch({}, calls);
    const client = createJmapClient({ fetchImpl });

    await client.testConnection(CREDENTIALS);

    expect(calls).toEqual(["session"]);
  });

  test("401 on the session request maps to ExternalMailAuthError", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      { sessionStatus: 401, sessionBody: {} },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    await expect(client.testConnection(CREDENTIALS)).rejects.toBeInstanceOf(
      ExternalMailAuthError,
    );
  });

  test("malformed session JSON maps to ExternalMailTransportError", async () => {
    const calls: string[] = [];
    const fetchImpl = (async () =>
      textResponse(200, "not json")) as unknown as typeof fetch;
    void calls;
    const client = createJmapClient({ fetchImpl });

    await expect(client.testConnection(CREDENTIALS)).rejects.toBeInstanceOf(
      ExternalMailTransportError,
    );
  });

  test("fetchSince returns a full page under max with hasMore false", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      {
        mailboxGet: DEFAULT_MAILBOX_GET,
        emailQuery: () =>
          jsonResponse(
            200,
            methodResponse("Email/query", {
              accountId: ACCOUNT_ID,
              ids: ["e-1"],
              total: 1,
            }),
          ),
        emailGet: () =>
          jsonResponse(
            200,
            methodResponse("Email/get", {
              accountId: ACCOUNT_ID,
              list: [{ id: "e-1", blobId: "blob-1" }],
              notFound: [],
            }),
          ),
        download: () => textResponse(200, "Subject: Hi\r\n\r\nBody\r\n"),
      },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    const result = await client.fetchSince(CREDENTIALS, new Set(), 5);

    expect(result.hasMore).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.remoteId).toBe("e-1");
    expect(new TextDecoder().decode(result.messages[0]?.raw)).toBe(
      "Subject: Hi\r\n\r\nBody\r\n",
    );
  });

  test("a page hitting max reports hasMore: true", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      {
        mailboxGet: DEFAULT_MAILBOX_GET,
        emailQuery: () =>
          jsonResponse(
            200,
            methodResponse("Email/query", {
              accountId: ACCOUNT_ID,
              ids: ["e-1", "e-2"],
              total: 5,
            }),
          ),
        emailGet: () =>
          jsonResponse(
            200,
            methodResponse("Email/get", {
              accountId: ACCOUNT_ID,
              list: [
                { id: "e-1", blobId: "blob-1" },
                { id: "e-2", blobId: "blob-2" },
              ],
              notFound: [],
            }),
          ),
        download: () => textResponse(200, "raw"),
      },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    const result = await client.fetchSince(CREDENTIALS, new Set(), 2);

    expect(result.hasMore).toBe(true);
  });

  test("an id already in knownRemoteIds is skipped before Email/get and download", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      {
        mailboxGet: DEFAULT_MAILBOX_GET,
        emailQuery: () =>
          jsonResponse(
            200,
            methodResponse("Email/query", {
              accountId: ACCOUNT_ID,
              ids: ["e-known"],
              total: 1,
            }),
          ),
        emailGet: () => {
          throw new Error(
            "Email/get must not be called for an already-known id",
          );
        },
        download: () => {
          throw new Error("download must not happen for an already-known id");
        },
      },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    const result = await client.fetchSince(
      CREDENTIALS,
      new Set(["e-known"]),
      5,
    );

    expect(result.messages).toEqual([]);
    expect(calls).toEqual(["session", "Mailbox/get", "Email/query"]);
  });

  test("401 during Email/get maps to ExternalMailAuthError", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      {
        mailboxGet: DEFAULT_MAILBOX_GET,
        emailQuery: () =>
          jsonResponse(
            200,
            methodResponse("Email/query", {
              accountId: ACCOUNT_ID,
              ids: ["e-1"],
              total: 1,
            }),
          ),
        emailGet: () => jsonResponse(401, {}),
      },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    await expect(
      client.fetchSince(CREDENTIALS, new Set(), 5),
    ).rejects.toBeInstanceOf(ExternalMailAuthError);
  });

  test("a JMAP method-level error response maps to ExternalMailTransportError", async () => {
    const calls: string[] = [];
    const fetchImpl = createFakeFetch(
      {
        mailboxGet: () =>
          jsonResponse(200, methodResponse("error", { type: "serverFail" })),
      },
      calls,
    );
    const client = createJmapClient({ fetchImpl });

    await expect(
      client.fetchSince(CREDENTIALS, new Set(), 5),
    ).rejects.toBeInstanceOf(ExternalMailTransportError);
  });

  describe("paging past already-known messages", () => {
    function inbox(count: number): string[] {
      return Array.from({ length: count }, (_, i) => `e-${i}`);
    }

    function pagedQuery(
      all: readonly string[],
      positions: number[],
    ): (args: Record<string, unknown>) => Response {
      return (args) => {
        const position = Number(args["position"]);
        const limit = Number(args["limit"]);
        positions.push(position);
        return jsonResponse(
          200,
          methodResponse("Email/query", {
            accountId: ACCOUNT_ID,
            ids: all.slice(position, position + limit),
            total: all.length,
          }),
        );
      };
    }

    function getAndDownload(): Pick<FakeFetchConfig, "emailGet" | "download"> {
      return {
        emailGet: (args) =>
          jsonResponse(
            200,
            methodResponse("Email/get", {
              accountId: ACCOUNT_ID,
              list: (args["ids"] as string[]).map((id) => ({
                id,
                blobId: `blob-${id}`,
                size: 3,
              })),
              notFound: [],
            }),
          ),
        download: () => textResponse(200, "raw"),
      };
    }

    test("advances the query position until max unknown ids are found", async () => {
      const all = inbox(253);
      const known = new Set(all.slice(0, 250));
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
            ...getAndDownload(),
          },
          [],
        ),
      });

      const result = await client.fetchSince(CREDENTIALS, known, 2);

      // Paging starts 200 before the end of the known prefix.
      expect(positions).toEqual([50, 250]);
      expect(result.messages.map((m) => m.remoteId)).toEqual([
        "e-250",
        "e-251",
      ]);
      // e-252 is still unfetched.
      expect(result.hasMore).toBe(true);
    });

    test("reports hasMore false once the last unknown id is collected", async () => {
      const all = inbox(253);
      const known = new Set(all.slice(0, 250));
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
            ...getAndDownload(),
          },
          [],
        ),
      });

      const result = await client.fetchSince(CREDENTIALS, known, 10);

      expect(result.messages).toHaveLength(3);
      expect(result.hasMore).toBe(false);
    });

    test("stops with hasMore false when every message is known", async () => {
      const all = inbox(450);
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
          },
          [],
        ),
      });

      const result = await client.fetchSince(CREDENTIALS, new Set(all), 5);

      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(positions).toEqual([250]);
    });

    test("reaches one new message behind 5000 known ones in a single call", async () => {
      const all = inbox(5001);
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
            emailGet: (args) =>
              jsonResponse(
                200,
                methodResponse("Email/get", {
                  list: (args["ids"] as string[]).map((id) => ({
                    id,
                    blobId: `blob-${id}`,
                    size: 3,
                  })),
                }),
              ),
            download: () => textResponse(200, "raw"),
          },
          [],
        ),
      });

      const result = await client.fetchSince(
        CREDENTIALS,
        new Set(all.slice(0, 5000)),
        10,
      );

      expect(result.messages.map((m) => m.remoteId)).toEqual(["e-5000"]);
      expect(result.hasMore).toBe(false);
      expect(positions).toEqual([4800, 5000]);
    });

    test("steps back when remotely deleted known ids made the start overshoot", async () => {
      // 1000 messages; the ledger holds e-0..e-499 plus 600 ids that no
      // longer exist, so size - 200 = 900 lands inside the unknown region.
      const all = inbox(1000);
      const known = new Set([
        ...all.slice(0, 500),
        ...Array.from({ length: 600 }, (_, i) => `gone-${i}`),
      ]);
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
            emailGet: (args) =>
              jsonResponse(
                200,
                methodResponse("Email/get", {
                  list: (args["ids"] as string[]).map((id) => ({
                    id,
                    blobId: `blob-${id}`,
                    size: 3,
                  })),
                }),
              ),
            download: () => textResponse(200, "raw"),
          },
          [],
        ),
      });

      const result = await client.fetchSince(CREDENTIALS, known, 200);

      // 900 -> 700 -> 500 are all unknown; 300 is known and anchors the scan.
      expect(positions.slice(0, 4)).toEqual([900, 700, 500, 300]);
      expect(result.messages).toHaveLength(200);
      expect(result.messages[0]?.remoteId).toBe("e-500");
      expect(result.hasMore).toBe(true);
    });

    test("bounds the pages per call and reports hasMore when the budget runs out", async () => {
      // Known ids are all at the far end, so the start position keeps
      // landing on unknown ids and stepping back.
      const all = inbox(10_000);
      const known = new Set(all.slice(5000));
      const positions: number[] = [];
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: pagedQuery(all, positions),
          },
          [],
        ),
      });

      const result = await client.fetchSince(CREDENTIALS, known, 5);

      expect(positions).toHaveLength(20);
      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("session URL validation", () => {
    async function fetchWithSession(
      override: Record<string, unknown>,
      credentials = CREDENTIALS,
    ): Promise<void> {
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            sessionBody: { ...(sessionBody() as object), ...override },
          },
          [],
        ),
      });
      await client.testConnection(credentials);
    }

    test.each([
      ["a plain-http apiUrl", { apiUrl: "http://api.fastmail.com/jmap/api/" }],
      ["an apiUrl on another host", { apiUrl: "https://evil.example/api/" }],
      ["an unparseable apiUrl", { apiUrl: "not a url" }],
      [
        "a plain-http downloadUrl",
        { downloadUrl: "http://api.fastmail.com/jmap/download/{blobId}" },
      ],
      [
        "a downloadUrl on an untrusted host",
        { downloadUrl: "https://evil.example/download/{blobId}" },
      ],
      [
        "a downloadUrl on a lookalike of a trusted host",
        { downloadUrl: "https://evilfastmailusercontent.com/{blobId}" },
      ],
    ])("rejects %s", async (_label, override) => {
      await expect(fetchWithSession(override)).rejects.toBeInstanceOf(
        ExternalMailTransportError,
      );
    });

    test("accepts Fastmail's separate download host", async () => {
      await expect(
        fetchWithSession({
          downloadUrl:
            "https://www.fastmailusercontent.com/jmap/download/{accountId}/{blobId}/{name}",
        }),
      ).resolves.toBeUndefined();
    });

    test("accepts plain http on a loopback host only", async () => {
      const local = {
        ...CREDENTIALS,
        sessionUrl: "http://localhost:8080/jmap/session",
      };
      const fetchImpl = (async () =>
        jsonResponse(200, {
          ...(sessionBody() as object),
          apiUrl: "http://localhost:8080/jmap/api/",
          downloadUrl: "http://localhost:8080/jmap/download/{blobId}",
        })) as unknown as typeof fetch;
      await expect(
        createJmapClient({ fetchImpl }).testConnection(local),
      ).resolves.toBeUndefined();

      const remote = { ...CREDENTIALS, sessionUrl: "http://mail.example/s" };
      await expect(
        createJmapClient({ fetchImpl }).testConnection(remote),
      ).rejects.toBeInstanceOf(ExternalMailTransportError);
    });

    test("never sends the request when the session URL itself is insecure", async () => {
      let called = false;
      const fetchImpl = (async () => {
        called = true;
        return jsonResponse(200, sessionBody());
      }) as unknown as typeof fetch;
      await expect(
        createJmapClient({ fetchImpl }).testConnection({
          ...CREDENTIALS,
          sessionUrl: "http://mail.example/s",
        }),
      ).rejects.toBeInstanceOf(ExternalMailTransportError);
      expect(called).toBe(false);
    });
  });

  describe("redirects", () => {
    test("requests with redirect: manual and treats a session redirect as an error", async () => {
      const seen: (RequestInit["redirect"] | undefined)[] = [];
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        seen.push(init?.redirect);
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/" },
        });
      }) as unknown as typeof fetch;
      await expect(
        createJmapClient({ fetchImpl }).testConnection(CREDENTIALS),
      ).rejects.toBeInstanceOf(ExternalMailTransportError);
      expect(seen).toEqual(["manual"]);
    });

    test("treats a blob download redirect as an error", async () => {
      const client = createJmapClient({
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: () =>
              jsonResponse(
                200,
                methodResponse("Email/query", { ids: ["e-1"], total: 1 }),
              ),
            emailGet: () =>
              jsonResponse(
                200,
                methodResponse("Email/get", {
                  list: [{ id: "e-1", blobId: "b-1" }],
                }),
              ),
            download: () =>
              new Response(null, {
                status: 302,
                headers: { Location: "https://evil.example/" },
              }),
          },
          [],
        ),
      });
      await expect(
        client.fetchSince(CREDENTIALS, new Set(), 5),
      ).rejects.toBeInstanceOf(ExternalMailTransportError);
    });
  });

  describe("message size cap", () => {
    function clientFor(
      list: unknown[],
      download: (url: string) => Response,
      maxMessageBytes: number,
      calls: string[],
    ) {
      return createJmapClient({
        maxMessageBytes,
        fetchImpl: createFakeFetch(
          {
            mailboxGet: DEFAULT_MAILBOX_GET,
            emailQuery: () =>
              jsonResponse(
                200,
                methodResponse("Email/query", {
                  ids: ["e-big", "e-ok"],
                  total: 2,
                }),
              ),
            emailGet: () =>
              jsonResponse(200, methodResponse("Email/get", { list })),
            download,
          },
          calls,
        ),
      });
    }

    test("skips a message whose reported size exceeds the cap without downloading it", async () => {
      const calls: string[] = [];
      const client = clientFor(
        [
          { id: "e-big", blobId: "b-big", size: 100 },
          { id: "e-ok", blobId: "b-ok", size: 3 },
        ],
        () => textResponse(200, "raw"),
        10,
        calls,
      );

      const result = await client.fetchSince(CREDENTIALS, new Set(), 5);

      expect(result.messages.map((m) => m.remoteId)).toEqual(["e-ok"]);
      expect(result.skipped).toEqual([
        { remoteId: "e-big", reason: "TOO_LARGE", size: 100 },
      ]);
      expect(calls.filter((c) => c.startsWith("download:"))).toHaveLength(1);
    });

    test("skips a download whose Content-Length exceeds the cap", async () => {
      const client = clientFor(
        [{ id: "e-big", blobId: "b-big" }],
        () =>
          new Response("x".repeat(50), {
            status: 200,
            headers: { "Content-Length": "50" },
          }),
        10,
        [],
      );

      const result = await client.fetchSince(CREDENTIALS, new Set(), 5);

      expect(result.messages).toEqual([]);
      expect(result.skipped).toEqual([
        { remoteId: "e-big", reason: "TOO_LARGE", size: 50 },
      ]);
    });

    test("aborts a streamed download without Content-Length once the cap is passed", async () => {
      let pulls = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(6));
        },
        cancel() {
          cancelled = true;
        },
      });
      const client = clientFor(
        [{ id: "e-big", blobId: "b-big" }],
        () => new Response(stream, { status: 200 }),
        10,
        [],
      );

      const result = await client.fetchSince(CREDENTIALS, new Set(), 5);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.remoteId).toBe("e-big");
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(10);
    });

    test("downloads a message exactly at the cap", async () => {
      const client = clientFor(
        [{ id: "e-ok", blobId: "b-ok", size: 10 }],
        () => textResponse(200, "0123456789"),
        10,
        [],
      );

      const result = await client.fetchSince(CREDENTIALS, new Set(), 5);

      expect(result.skipped).toEqual([]);
      expect(result.messages[0]?.raw).toHaveLength(10);
    });
  });
});
