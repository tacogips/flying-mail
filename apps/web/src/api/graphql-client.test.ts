import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  graphqlRequest,
  httpStatusToErrorCode,
  mapGraphQLError,
  publicGraphqlRequest,
  sessionStore,
  uploadAttachment,
} from "./graphql-client";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(
  responder: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return responder(call);
  });
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mapGraphQLError", () => {
  test("extracts the coded extension", () => {
    expect(
      mapGraphQLError({
        message: "nope",
        extensions: { code: "FORBIDDEN" },
        path: ["messages", 0],
      }),
    ).toEqual({ message: "nope", code: "FORBIDDEN", path: ["messages", 0] });
  });

  test("falls back to UNKNOWN for an unrecognized code", () => {
    expect(
      mapGraphQLError({ message: "x", extensions: { code: "WEIRD" } }).code,
    ).toBe("UNKNOWN");
    expect(mapGraphQLError({ message: "x" }).code).toBe("UNKNOWN");
  });

  test("handles a malformed error object", () => {
    expect(mapGraphQLError(null)).toEqual({
      message: "Unknown GraphQL error",
      code: "UNKNOWN",
    });
  });
});

describe("httpStatusToErrorCode", () => {
  test.each([
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [503, "SERVICE_UNAVAILABLE"],
    [500, "UNKNOWN"],
  ])("maps %i to %s", (status, expected) => {
    expect(httpStatusToErrorCode(status)).toBe(expected);
  });
});

describe("graphqlRequest", () => {
  beforeEach(() => {
    sessionStore.markEstablished();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStore.clear();
  });

  test("returns data on success", async () => {
    stubFetch(() => jsonResponse({ data: { viewer: null } }));
    const result = await graphqlRequest<{ viewer: null }>("{ viewer }");
    expect(result).toEqual({ ok: true, data: { viewer: null } });
  });

  test("sends the query and variables as JSON", async () => {
    const calls = stubFetch(() => jsonResponse({ data: { ok: true } }));
    await graphqlRequest("query X { ok }", { id: "1" });
    expect(calls[0]?.url).toBe("/graphql");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "query X { ok }",
      variables: { id: "1" },
    });
  });

  test("omits variables when none are given", async () => {
    const calls = stubFetch(() => jsonResponse({ data: { ok: true } }));
    await graphqlRequest("{ ok }");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: "{ ok }",
    });
  });

  test("maps GraphQL errors", async () => {
    stubFetch(() =>
      jsonResponse({
        errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }],
      }),
    );
    const result = await graphqlRequest("{ ok }");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.code).toBe("FORBIDDEN");
  });

  test("clears the session on UNAUTHENTICATED", async () => {
    stubFetch(() =>
      jsonResponse({
        errors: [
          { message: "expired", extensions: { code: "UNAUTHENTICATED" } },
        ],
      }),
    );
    expect(sessionStore.isEstablished()).toBe(true);
    await graphqlRequest("{ ok }");
    expect(sessionStore.isEstablished()).toBe(false);
  });

  test("does not clear the session on other errors", async () => {
    stubFetch(() =>
      jsonResponse({
        errors: [{ message: "bad", extensions: { code: "BAD_USER_INPUT" } }],
      }),
    );
    await graphqlRequest("{ ok }");
    expect(sessionStore.isEstablished()).toBe(true);
  });

  test("reports a network failure without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const result = await graphqlRequest("{ ok }");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.message).toBe("offline");
  });

  test("reports a non-JSON error response by status", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 401 }));
    const result = await graphqlRequest("{ ok }");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.code).toBe("UNAUTHENTICATED");
    expect(sessionStore.isEstablished()).toBe(false);
  });

  test("treats a missing data field as an error", async () => {
    stubFetch(() => jsonResponse({}));
    const result = await graphqlRequest("{ ok }");
    expect(result.ok).toBe(false);
  });

  test("sends the session cookie by default", async () => {
    const calls = stubFetch(() => jsonResponse({ data: { ok: true } }));
    await graphqlRequest("{ ok }");
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });
});

describe("publicGraphqlRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStore.clear();
  });

  test("omits credentials entirely", async () => {
    const calls = stubFetch(() => jsonResponse({ data: { ok: true } }));
    await publicGraphqlRequest("{ ok }");
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  test("never clears the session on its own unauthenticated error", async () => {
    sessionStore.markEstablished();
    stubFetch(() =>
      jsonResponse({
        errors: [{ message: "x", extensions: { code: "UNAUTHENTICATED" } }],
      }),
    );
    await publicGraphqlRequest("{ ok }");
    expect(sessionStore.isEstablished()).toBe(true);
  });
});

describe("uploadAttachment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStore.clear();
  });

  test("posts multipart form data", async () => {
    const calls = stubFetch(() =>
      jsonResponse({ id: "att-1", fileName: "notes.txt" }, 201),
    );
    const result = await uploadAttachment(
      new File(["data"], "notes.txt", { type: "text/plain" }),
    );
    expect(calls[0]?.url).toBe("/api/attachments");
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect(result).toEqual({
      ok: true,
      data: { id: "att-1", fileName: "notes.txt" },
    });
  });

  test("maps an error status", async () => {
    stubFetch(() => new Response("too big", { status: 413 }));
    const result = await uploadAttachment(new File(["x"], "big.bin"));
    expect(result.ok).toBe(false);
  });
});
