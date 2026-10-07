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
  readonly emailQuery?: () => Response;
  readonly emailGet?: () => Response;
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
      const parsed: { methodCalls: [string, unknown, string][] } =
        JSON.parse(bodyText);
      const methodName = parsed.methodCalls[0]?.[0];
      calls.push(methodName ?? "unknown");
      if (methodName === "Mailbox/get" && config.mailboxGet)
        return config.mailboxGet();
      if (methodName === "Email/query" && config.emailQuery)
        return config.emailQuery();
      if (methodName === "Email/get" && config.emailGet)
        return config.emailGet();
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
});
