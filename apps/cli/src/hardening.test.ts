import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "./args";
import { createCliClient, requireEndpoint } from "./client";
import {
  allowedHostHeaders,
  createClientServeApp,
  type ClientServeOptions,
} from "./commands/client-serve";
import {
  backoffDelayMs,
  isTransientFailure,
  MAX_BACKOFF_MS,
  resolvePollIntervalMs,
  runPollLoop,
} from "./commands/fetch-watch";
import { resolveConfigSetValue } from "./commands/index";
import { websocketUrl } from "./commands/watch";
import { apiKeyArgvWarning } from "./config";
import { CliError, ExitCode } from "./exit-codes";
import { withOperands } from "./main";

const ENDPOINT = "https://mail.example.com";

function serveOptions(
  overrides: Partial<ClientServeOptions> = {},
): ClientServeOptions {
  return {
    port: 5173,
    host: "127.0.0.1",
    distDir: "/definitely/not/built",
    endpoint: ENDPOINT,
    apiKey: "ybm_abc_secret",
    open: false,
    ...overrides,
  };
}

describe("client serve proxy origin checks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubUpstream(): { calls: number; authorization: string | null } {
    const seen = { calls: 0, authorization: null as string | null };
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.calls += 1;
      seen.authorization = new Headers(init.headers).get("authorization");
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });
    return seen;
  }

  const jsonPost = (headers: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

  test("derives allowed Host values from the listen address", () => {
    expect([...allowedHostHeaders({ host: "127.0.0.1", port: 5173 })]).toEqual([
      "127.0.0.1:5173",
      "localhost:5173",
      "[::1]:5173",
    ]);
    expect(
      allowedHostHeaders({ host: "::1", port: 8080 }).has("[::1]:8080"),
    ).toBe(true);
    expect(
      allowedHostHeaders({ host: "LocalHost", port: 1 }).has("localhost:1"),
    ).toBe(true);
  });

  test.each([
    "127.0.0.1:5173",
    "localhost:5173",
    "[::1]:5173",
    "LOCALHOST:5173",
  ])("accepts Host %s and injects the key", async (host) => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request(
      "http://localhost/graphql",
      jsonPost({ host }),
    );
    expect(response.status).toBe(200);
    expect(seen.authorization).toBe("Bearer ybm_abc_secret");
  });

  test.each([
    ["a rebound DNS name", "attacker.example:5173"],
    ["the right host on the wrong port", "127.0.0.1:9999"],
    ["a host with no port", "localhost"],
  ])("rejects %s with 403 and never injects the key", async (_label, host) => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    for (const path of ["/graphql", "/api/attachments", "/files/x"]) {
      const response = await app.request(
        `http://localhost${path}`,
        jsonPost({ host }),
      );
      expect(response.status).toBe(403);
    }
    expect(seen.calls).toBe(0);
  });

  test("rejects a request with no Host header", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request(
      "http://localhost/graphql",
      jsonPost({}),
    );
    expect(response.status).toBe(403);
    expect(seen.calls).toBe(0);
  });

  test("rejects a cross-site Origin even with a valid Host", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    for (const origin of [
      "https://evil.example",
      "null",
      "http://localhost:9999",
      "https://localhost:5173",
    ]) {
      const response = await app.request(
        "http://localhost/graphql",
        jsonPost({ host: "localhost:5173", origin }),
      );
      expect(response.status).toBe(403);
    }
    expect(seen.calls).toBe(0);
  });

  test("accepts the listener's own Origin", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request(
      "http://localhost/graphql",
      jsonPost({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }),
    );
    expect(response.status).toBe(200);
    expect(seen.calls).toBe(1);
  });

  test("answers OPTIONS locally with 403 and no CORS headers", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request("http://localhost/graphql", {
      method: "OPTIONS",
      headers: {
        host: "127.0.0.1:5173",
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(seen.calls).toBe(0);
  });

  test("rejects non-JSON GraphQL bodies with 415", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    for (const type of [
      "application/x-www-form-urlencoded",
      "text/plain",
      "multipart/form-data; boundary=x",
    ]) {
      const response = await app.request("http://localhost/graphql", {
        method: "POST",
        headers: { host: "127.0.0.1:5173", "content-type": type },
        body: "query=%7Bviewer%7D",
      });
      expect(response.status).toBe(415);
    }
    expect(seen.calls).toBe(0);
  });

  test("accepts JSON with a charset parameter", async () => {
    stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request(
      "http://localhost/graphql",
      jsonPost({
        host: "127.0.0.1:5173",
        "content-type": "application/json; charset=utf-8",
      }),
    );
    expect(response.status).toBe(200);
  });

  test("does not require JSON for non-GraphQL proxy paths", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(serveOptions());
    const response = await app.request("http://localhost/api/attachments", {
      method: "POST",
      headers: {
        host: "127.0.0.1:5173",
        "content-type": "multipart/form-data; boundary=x",
      },
      body: "x",
    });
    expect(response.status).toBe(200);
    expect(seen.calls).toBe(1);
  });

  test("in --allow-remote mode (no injected key) other Host values pass", async () => {
    const seen = stubUpstream();
    const app = createClientServeApp(
      serveOptions({ host: "0.0.0.0", apiKey: null }),
    );
    const response = await app.request(
      "http://localhost/graphql",
      jsonPost({ host: "mail-box.lan:5173" }),
    );
    expect(response.status).toBe(200);
    expect(seen.authorization).toBeNull();
  });

  test("static files are not subject to the Host check", async () => {
    const app = createClientServeApp(serveOptions());
    const response = await app.request("http://localhost/", {
      headers: { host: "attacker.example:5173" },
    });
    // Missing build -> 500, not 403: the check is only on proxied paths.
    expect(response.status).toBe(500);
  });
});

describe("endpoint scheme enforcement", () => {
  test.each([
    "https://mail.example.com",
    "https://mail.example.com/base/",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("accepts %s", (endpoint) => {
    expect(() => requireEndpoint({ endpoint, apiKey: null })).not.toThrow();
  });

  test.each([
    "http://mail.example.com",
    "ftp://mail.example.com",
    "ws://mail.example.com",
    "mail.example.com",
    "not a url",
  ])("rejects %s as a usage error", (endpoint) => {
    expect(() => requireEndpoint({ endpoint, apiKey: null })).toThrow(CliError);
    try {
      requireEndpoint({ endpoint, apiKey: null });
    } catch (error) {
      expect(error).toMatchObject({ exitCode: ExitCode.UsageError });
    }
  });

  test("strips trailing slashes from an accepted endpoint", () => {
    expect(
      requireEndpoint({ endpoint: "https://a.example//", apiKey: null }),
    ).toBe("https://a.example");
  });

  test("createCliClient refuses a plaintext remote endpoint before sending", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(() =>
      createCliClient({ endpoint: "http://mail.example.com", apiKey: "k" }),
    ).toThrow(CliError);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("websocketUrl maps https to wss and loopback http to ws", () => {
    expect(websocketUrl("https://mail.example.com/base?x=1#h")).toBe(
      "wss://mail.example.com/graphql",
    );
    expect(websocketUrl("http://localhost:8787")).toBe(
      "ws://localhost:8787/graphql",
    );
  });

  test.each(["http://mail.example.com", "ws://mail.example.com", "nope"])(
    "websocketUrl rejects %s",
    (endpoint) => {
      expect(() => websocketUrl(endpoint)).toThrow(
        expect.objectContaining({ exitCode: ExitCode.UsageError }),
      );
    },
  );
});

describe("mail fetch --interval", () => {
  test("defaults to 30 seconds", () => {
    expect(resolvePollIntervalMs(undefined)).toBe(30_000);
  });

  test("converts seconds to milliseconds and clamps to one second", () => {
    expect(resolvePollIntervalMs("5")).toBe(5000);
    expect(resolvePollIntervalMs("0.2")).toBe(1000);
    expect(resolvePollIntervalMs("1")).toBe(1000);
  });

  test("caps absurd values at the timer limit", () => {
    expect(resolvePollIntervalMs("99999999999")).toBe(2_147_483_647);
  });

  test.each(["0", "-5", "abc", "", "NaN", "Infinity"])(
    "rejects %j as a usage error",
    (raw) => {
      expect(() => resolvePollIntervalMs(raw)).toThrow(
        expect.objectContaining({ exitCode: ExitCode.UsageError }),
      );
    },
  );
});

describe("poll backoff", () => {
  test("doubles per failure and caps at 60 seconds", () => {
    expect(backoffDelayMs(5000, 0)).toBe(5000);
    expect(backoffDelayMs(5000, 1)).toBe(10_000);
    expect(backoffDelayMs(5000, 2)).toBe(20_000);
    expect(backoffDelayMs(5000, 3)).toBe(40_000);
    expect(backoffDelayMs(5000, 4)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelayMs(5000, 500)).toBe(MAX_BACKOFF_MS);
  });

  test("never shortens an interval that already exceeds the cap", () => {
    expect(backoffDelayMs(120_000, 3)).toBe(120_000);
  });

  test("classifies transient failures", () => {
    expect(isTransientFailure(new CliError("x", ExitCode.NetworkError))).toBe(
      true,
    );
    expect(
      isTransientFailure(
        new CliError("x", ExitCode.GeneralError, "RATE_LIMITED"),
      ),
    ).toBe(true);
    expect(
      isTransientFailure(
        new CliError("x", ExitCode.GeneralError, "SERVICE_UNAVAILABLE"),
      ),
    ).toBe(true);
    expect(isTransientFailure(new CliError("x", ExitCode.AuthError))).toBe(
      false,
    );
    expect(isTransientFailure(new Error("boom"))).toBe(false);
  });

  test("keeps polling through transient errors, then recovers", async () => {
    const outcomes: Array<"ok" | CliError> = [
      "ok",
      new CliError("slow down", ExitCode.GeneralError, "RATE_LIMITED"),
      new CliError("down", ExitCode.NetworkError),
      new CliError("down", ExitCode.NetworkError),
      "ok",
      "ok",
    ];
    const sleeps: number[] = [];
    const warnings: string[] = [];
    let index = 0;
    await runPollLoop(
      async () => {
        const outcome = outcomes[index];
        index += 1;
        if (outcome instanceof CliError) throw outcome;
      },
      5000,
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        warn: (message) => warnings.push(message),
        shouldContinue: () => index < outcomes.length,
      },
    );
    expect(sleeps).toEqual([5000, 10_000, 20_000, 40_000, 5000]);
    expect(warnings).toHaveLength(3);
  });

  test("a transient failure on the first poll does not terminate", async () => {
    let calls = 0;
    await runPollLoop(
      async () => {
        calls += 1;
        if (calls === 1) throw new CliError("x", ExitCode.NetworkError);
      },
      1000,
      {
        sleep: async () => {},
        warn: () => {},
        shouldContinue: () => calls < 2,
      },
    );
    expect(calls).toBe(2);
  });

  test("non-transient errors still end the loop", async () => {
    await expect(
      runPollLoop(
        async () => {
          throw new CliError("bad key", ExitCode.AuthError);
        },
        1000,
        { sleep: async () => {}, warn: () => {} },
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.AuthError });
  });
});

describe("transient error codes from the client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a GraphQL error code is preserved on the CliError", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "slow", extensions: { code: "RATE_LIMITED" } }],
          }),
        ),
    );
    const client = createCliClient({ endpoint: ENDPOINT, apiKey: null });
    const error = await client.request("{ x }").catch((e: unknown) => e);
    expect(isTransientFailure(error)).toBe(true);
  });

  test("HTTP 429 and 503 without a JSON body are transient", async () => {
    for (const status of [429, 503]) {
      vi.stubGlobal("fetch", async () => new Response("busy", { status }));
      const client = createCliClient({ endpoint: ENDPOINT, apiKey: null });
      const error = await client.request("{ x }").catch((e: unknown) => e);
      expect(isTransientFailure(error)).toBe(true);
    }
  });
});

describe("api key on argv", () => {
  test("warns only for --api-key from an interactive terminal", () => {
    const withKey = parseArgs(["mail", "list", "--api-key", "ybm_a_b"]);
    expect(apiKeyArgvWarning(withKey, true)).toContain("FLYING_MAIL_API_KEY");
    expect(apiKeyArgvWarning(withKey, false)).toBeNull();
    expect(apiKeyArgvWarning(parseArgs(["mail", "list"]), true)).toBeNull();
  });

  test("the warning never contains the key", () => {
    const warning = apiKeyArgvWarning(
      parseArgs(["mail", "list", "--api-key", "ybm_a_supersecret"]),
      true,
    );
    expect(warning).not.toContain("supersecret");
  });

  test("config set apiKey - reads and trims stdin", async () => {
    await expect(
      resolveConfigSetValue("apiKey", "-", async () => "ybm_a_b\n"),
    ).resolves.toBe("ybm_a_b");
  });

  test("config set apiKey - rejects empty stdin", async () => {
    await expect(
      resolveConfigSetValue("apiKey", "-", async () => "  \n"),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
  });

  test("a literal value is used as-is and stdin is not read", async () => {
    const read = vi.fn(async () => "other");
    await expect(
      resolveConfigSetValue("apiKey", "ybm_a_b", read),
    ).resolves.toBe("ybm_a_b");
    expect(read).not.toHaveBeenCalled();
  });

  test("config set endpoint validates the scheme", async () => {
    await expect(
      resolveConfigSetValue("endpoint", "http://mail.example.com"),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
    await expect(
      resolveConfigSetValue("endpoint", "https://mail.example.com"),
    ).resolves.toBe("https://mail.example.com");
  });

  test("a bare - after the subcommand parses as an operand", () => {
    const args = withOperands(parseArgs(["config", "set", "apiKey", "-"]));
    expect(args.command).toEqual(["config", "set"]);
    expect(args.positionals).toEqual(["apiKey", "-"]);
  });

  test("withOperands keeps operands that follow a flag", () => {
    const args = withOperands(
      parseArgs(["domain", "add", "a.example", "--json", "b"]),
    );
    expect(args.positionals).toEqual(["a.example", "b"]);
  });
});
