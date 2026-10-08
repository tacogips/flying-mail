import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createSiteverifyTurnstileVerifier,
  TURNSTILE_SITEVERIFY_URL,
} from "./siteverify";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recordingFetch(
  options: {
    readonly status?: number;
    readonly body?: string;
    readonly throwOnFetch?: unknown;
  } = {},
): {
  readonly calls: CapturedRequest[];
  readonly fetch: typeof fetch;
} {
  const calls: CapturedRequest[] = [];
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    if ("throwOnFetch" in options) {
      throw options.throwOnFetch;
    }
    return new Response(
      options.body ??
        JSON.stringify({
          success: true,
          hostname: "mail.example.com",
          action: "login",
        }),
      { status: options.status ?? 200 },
    );
  }) as typeof fetch;
  return { calls, fetch: fakeFetch };
}

function verifier(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createSiteverifyTurnstileVerifier({
    secret: "test-secret",
    expectedHostname: "mail.example.com",
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const validInput = {
  token: "turnstile-token",
  remoteIp: "203.0.113.4",
  action: "login",
} as const;

describe("createSiteverifyTurnstileVerifier", () => {
  afterEach(() => vi.restoreAllMocks());

  test("posts the siteverify form and accepts matching hostname and action", async () => {
    const { calls, fetch } = recordingFetch();
    await expect(verifier(fetch).verify(validInput)).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect([...body.entries()]).toEqual([
      ["secret", "test-secret"],
      ["response", "turnstile-token"],
      ["remoteip", "203.0.113.4"],
    ]);
  });

  test("omits remoteip when the input is null", async () => {
    const { calls, fetch } = recordingFetch();
    await expect(
      verifier(fetch).verify({ ...validInput, remoteIp: null }),
    ).resolves.toBe(true);
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.has("remoteip")).toBe(false);
  });

  test.each([
    ["hostname mismatch", { hostname: "other.example.com" }],
    ["action mismatch", { action: "register" }],
    ["missing action", { action: undefined }],
    ["success false", { success: false }],
  ])("returns false for %s", async (_label, override) => {
    const response = {
      success: true,
      hostname: "mail.example.com",
      action: "login",
      ...override,
    };
    const { fetch } = recordingFetch({ body: JSON.stringify(response) });
    await expect(verifier(fetch).verify(validInput)).resolves.toBe(false);
  });

  test("returns false for non-2xx responses", async () => {
    const { fetch } = recordingFetch({ status: 500 });
    await expect(verifier(fetch).verify(validInput)).resolves.toBe(false);
  });

  test("returns false for a non-JSON body", async () => {
    const { fetch } = recordingFetch({ body: "not-json" });
    await expect(verifier(fetch).verify(validInput)).resolves.toBe(false);
  });

  test("returns false and logs a safe reason when fetch throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("request contained turnstile-token test-secret");
    failure.name = "turnstile-token-test-secret";
    const { fetch } = recordingFetch({ throwOnFetch: failure });
    await expect(verifier(fetch).verify(validInput)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      "Turnstile siteverify failed",
      "RequestError",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("turnstile-token");
    expect(JSON.stringify(log.mock.calls)).not.toContain("test-secret");
  });

  test("returns false for an aborted fetch", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const { fetch } = recordingFetch({ throwOnFetch: abortError });
    await expect(verifier(fetch, 1).verify(validInput)).resolves.toBe(false);
  });

  test.each([
    ["empty", ""],
    ["overlong", "a".repeat(2049)],
  ])("does not fetch for a %s token", async (_label, token) => {
    const { calls, fetch } = recordingFetch();
    await expect(
      verifier(fetch).verify({ ...validInput, token }),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
