import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  flagBoolean,
  flagList,
  flagNumber,
  flagString,
  parseArgs,
} from "./args";
import { createCliClient } from "./client";
import {
  createClientServeApp,
  DEFAULT_HOST,
  DEFAULT_PORT,
  describeServe,
  isLoopbackHost,
  resolveClientServeOptions,
  resolveStaticPath,
  shouldProxy,
} from "./commands/client-serve";
import { mailCommands, parseDuration, parseScopeSpec } from "./commands";
import {
  configFilePath,
  maskApiKey,
  readConfigFile,
  resolveConfig,
  writeConfigFile,
} from "./config";
import { CliError, ExitCode, exitCodeForGraphQLError } from "./exit-codes";
import { runCli } from "./main";
import { renderTable } from "./output";

const ENDPOINT = "https://mail.example.com";

describe("parseArgs", () => {
  test("collects leading command tokens", () => {
    expect(parseArgs(["client", "serve"]).command).toEqual(["client", "serve"]);
  });

  test("parses --flag=value", () => {
    const args = parseArgs(["mail", "list", "--limit=5"]);
    expect(flagNumber(args, "limit")).toBe(5);
  });

  test("parses --flag value", () => {
    const args = parseArgs(["mail", "list", "--limit", "5"]);
    expect(flagNumber(args, "limit")).toBe(5);
  });

  test("accepts a single-dash flag", () => {
    expect(flagString(parseArgs(["x", "-p", "9"]), "p")).toBe("9");
  });

  test("accumulates a repeated flag", () => {
    const args = parseArgs([
      "key",
      "create",
      "agent",
      "--scope",
      "MAIL_READ",
      "--scope",
      "MAIL_SEND",
    ]);
    expect(flagList(args, "scope")).toEqual(["MAIL_READ", "MAIL_SEND"]);
  });

  test("treats a known boolean flag as a switch, not a value taker", () => {
    // Without the boolean list, `--json` would swallow `list`.
    const args = parseArgs(["mail", "--json", "list"]);
    expect(flagBoolean(args, "json")).toBe(true);
    expect(args.positionals).toEqual(["list"]);
  });

  test("honours an explicit --flag=false", () => {
    expect(flagBoolean(parseArgs(["x", "--open=false"]), "open")).toBe(false);
  });

  test("does not let a value flag swallow the next flag", () => {
    const args = parseArgs(["x", "--subject", "--json"]);
    expect(flagString(args, "subject")).toBe("");
    expect(flagBoolean(args, "json")).toBe(true);
  });

  test("treats everything after -- as a positional", () => {
    const args = parseArgs(["mail", "show", "--", "--not-a-flag"]);
    expect(args.positionals).toEqual(["--not-a-flag"]);
  });

  test("separates command tokens from later positionals", () => {
    const args = parseArgs(["domain", "verify", "--json", "dom-1"]);
    expect(args.command).toEqual(["domain", "verify"]);
    expect(args.positionals).toEqual(["dom-1"]);
  });

  test("flagNumber ignores a non-numeric value", () => {
    expect(
      flagNumber(parseArgs(["x", "--limit", "abc"]), "limit"),
    ).toBeUndefined();
  });
});

describe("exit codes", () => {
  test.each([
    ["UNAUTHENTICATED", ExitCode.AuthError],
    ["FORBIDDEN", ExitCode.ForbiddenError],
    ["NOT_FOUND", ExitCode.NotFoundError],
    ["CONFLICT", ExitCode.GeneralError],
    ["", ExitCode.GeneralError],
  ])("maps %s to %i", (code, expected) => {
    expect(exitCodeForGraphQLError(code)).toBe(expected);
  });
});

describe("config", () => {
  test("maskApiKey keeps only the non-secret prefix", () => {
    expect(maskApiKey("ybm_a1b2c3d4e5f6_supersecretvalue")).toBe(
      "ybm_a1b2c3d4e5f6_***",
    );
    expect(maskApiKey("malformed")).toBe("***");
  });

  test("configFilePath honours the explicit override", () => {
    expect(configFilePath({ MAILCAL_CONFIG: "/tmp/y.json" })).toBe(
      "/tmp/y.json",
    );
  });

  test("configFilePath falls back to XDG_CONFIG_HOME", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/mailcal/config.json",
    );
  });

  test("a missing config file is not an error", async () => {
    expect(await readConfigFile("/definitely/not/here.json")).toEqual({});
  });

  test("a malformed config file is not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mailcal-cli-"));
    const path = join(dir, "config.json");
    await writeFile(path, "not json");
    expect(await readConfigFile(path)).toEqual({});
  });

  test("writes the config 0600 and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mailcal-cli-"));
    const path = join(dir, "nested", "config.json");
    await writeConfigFile(path, { endpoint: ENDPOINT, apiKey: "ybm_a_b" });

    expect(await readConfigFile(path)).toEqual({
      endpoint: ENDPOINT,
      apiKey: "ybm_a_b",
    });
    // The file holds a credential; group/other must not be able to read it.
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await readFile(path, "utf-8")).toContain(ENDPOINT);
  });

  describe("precedence", () => {
    test("a flag beats the environment and the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "mailcal-cli-"));
      const path = join(dir, "config.json");
      await writeConfigFile(path, {
        endpoint: "https://from-file.example.com",
        apiKey: "ybm_file_key",
      });

      const config = await resolveConfig(
        parseArgs(["x", "--endpoint", "https://from-flag.example.com"]),
        {
          MAILCAL_CONFIG: path,
          MAILCAL_ENDPOINT: "https://from-env.example.com",
        },
      );
      expect(config.endpoint).toBe("https://from-flag.example.com");
      // No flag for the key, so the environment is absent and the file wins.
      expect(config.apiKey).toBe("ybm_file_key");
    });

    test("the environment beats the file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "mailcal-cli-"));
      const path = join(dir, "config.json");
      await writeConfigFile(path, {
        endpoint: "https://from-file.example.com",
      });

      const config = await resolveConfig(parseArgs(["x"]), {
        MAILCAL_CONFIG: path,
        MAILCAL_ENDPOINT: "https://from-env.example.com",
      });
      expect(config.endpoint).toBe("https://from-env.example.com");
    });

    test("nothing configured yields nulls", async () => {
      const config = await resolveConfig(parseArgs(["x"]), {
        MAILCAL_CONFIG: "/definitely/not/here.json",
      });
      expect(config).toEqual({ endpoint: null, apiKey: null });
    });
  });
});

describe("parseScopeSpec", () => {
  test.each([
    [
      "MAIL_READ",
      { capability: "MAIL_READ", domainName: null, addressPattern: "*" },
    ],
    [
      "mail_send:example.com",
      {
        capability: "MAIL_SEND",
        domainName: "example.com",
        addressPattern: "*",
      },
    ],
    [
      "MAIL_READ:example.com:support@example.com",
      {
        capability: "MAIL_READ",
        domainName: "example.com",
        addressPattern: "support@example.com",
      },
    ],
    [
      "MAIL_READ::support@example.com",
      {
        capability: "MAIL_READ",
        domainName: null,
        addressPattern: "support@example.com",
      },
    ],
  ])("parses %j", (spec, expected) => {
    expect(parseScopeSpec(spec)).toEqual(expected);
  });

  test("rejects an empty capability", () => {
    expect(() => parseScopeSpec(":example.com")).toThrow(CliError);
  });
});

describe("parseDuration", () => {
  const now = new Date("2026-08-23T00:00:00.000Z");

  test.each([
    ["30s", "2026-08-23T00:00:30.000Z"],
    ["45m", "2026-08-23T00:45:00.000Z"],
    ["12h", "2026-08-23T12:00:00.000Z"],
    ["30d", "2026-09-22T00:00:00.000Z"],
  ])("parses %j", (value, expected) => {
    expect(parseDuration(value, now)).toBe(expected);
  });

  test.each(["", "30", "30x", "d30", "-1d"])("rejects %j", (value) => {
    expect(() => parseDuration(value, now)).toThrow(CliError);
  });
});

describe("renderTable", () => {
  test("aligns columns", () => {
    const output = renderTable(
      ["ID", "NAME"],
      [
        ["a", "alpha"],
        ["bb", "b"],
      ],
    );
    const lines = output.split("\n");
    expect(lines[0]).toBe("ID  NAME");
    expect(lines[2]).toBe("a   alpha");
  });

  test("truncates rather than wrapping", () => {
    const output = renderTable(["S"], [["x".repeat(30)]], 10);
    expect(output.split("\n")[2]).toBe(`${"x".repeat(7)}...`);
  });
});

describe("client serve options", () => {
  const config = { endpoint: ENDPOINT, apiKey: "ybm_abc_secret" };

  test("defaults to loopback with the key injected", () => {
    const options = resolveClientServeOptions(
      parseArgs(["client", "serve"]),
      config,
    );
    expect(options.host).toBe(DEFAULT_HOST);
    expect(options.port).toBe(DEFAULT_PORT);
    expect(options.apiKey).toBe("ybm_abc_secret");
    expect(options.endpoint).toBe(ENDPOINT);
  });

  test("strips a trailing slash from the endpoint", () => {
    const options = resolveClientServeOptions(parseArgs(["client", "serve"]), {
      ...config,
      endpoint: `${ENDPOINT}/`,
    });
    expect(options.endpoint).toBe(ENDPOINT);
  });

  test("refuses a non-loopback host without --allow-remote", () => {
    expect(() =>
      resolveClientServeOptions(
        parseArgs(["client", "serve", "--host", "0.0.0.0"]),
        config,
      ),
    ).toThrow(CliError);
  });

  test("--allow-remote binds but never injects the key", () => {
    // A key-injecting proxy on a reachable address is an open relay for
    // that key, so binding wide and injecting are mutually exclusive.
    const options = resolveClientServeOptions(
      parseArgs(["client", "serve", "--host", "0.0.0.0", "--allow-remote"]),
      config,
    );
    expect(options.host).toBe("0.0.0.0");
    expect(options.apiKey).toBeNull();
  });

  test("requires an endpoint", () => {
    expect(() =>
      resolveClientServeOptions(parseArgs(["client", "serve"]), {
        endpoint: null,
        apiKey: null,
      }),
    ).toThrow(CliError);
  });

  test.each(["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])(
    "%j is loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  test.each(["0.0.0.0", "192.168.1.10", "example.com", "10.0.0.1"])(
    "%j is not loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  test("describeServe masks the key", () => {
    const description = describeServe(
      resolveClientServeOptions(parseArgs(["client", "serve"]), config),
    );
    expect(description).toContain("ybm_abc_***");
    expect(description).not.toContain("ybm_abc_secret");
  });

  test("describeServe says plainly when no key is injected", () => {
    const description = describeServe(
      resolveClientServeOptions(
        parseArgs(["client", "serve", "--host", "0.0.0.0", "--allow-remote"]),
        config,
      ),
    );
    expect(description).toContain("not injected");
  });
});

describe("shouldProxy", () => {
  test.each(["/graphql", "/api/attachments", "/files/abc"])(
    "proxies %j",
    (pathname) => {
      expect(shouldProxy(pathname)).toBe(true);
    },
  );

  test.each(["/", "/index.html", "/assets/app.js", "/settings/domains"])(
    "serves %j locally",
    (pathname) => {
      expect(shouldProxy(pathname)).toBe(false);
    },
  );
});

describe("resolveStaticPath", () => {
  test("resolves a path inside the root", () => {
    expect(resolveStaticPath("/srv/dist", "/index.html")).toBe(
      "/srv/dist/index.html",
    );
  });

  test.each([
    ["a parent traversal", "/../secrets.txt"],
    ["a nested traversal", "/assets/../../secrets.txt"],
    ["an encoded traversal", "/%2e%2e/secrets.txt"],
    ["a fully encoded traversal", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd"],
    ["a shared-prefix sibling", "/../dist-secret/x"],
  ])("clamps %s inside the root", (_label, pathname) => {
    // The contract is containment, not rejection: `..` is clamped at the
    // root, so the request resolves to a path *inside* dist (which simply
    // will not exist) rather than escaping to a sibling or a parent.
    const resolved = resolveStaticPath("/srv/dist", pathname);
    expect(resolved).not.toBeNull();
    expect(resolved === "/srv/dist" || resolved?.startsWith("/srv/dist/")).toBe(
      true,
    );
  });

  test("returns null for an undecodable path", () => {
    expect(resolveStaticPath("/srv/dist", "/%E0%A4%A")).toBeNull();
  });
});

describe("client serve app", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createDist(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mailcal-dist-"));
    await writeFile(join(dir, "index.html"), "<html>mailcal</html>");
    await writeFile(join(dir, "app.js"), "console.log(1)");
    return dir;
  }

  test("serves the bundle and falls back to index.html for SPA routes", async () => {
    const dist = await createDist();
    const app = createClientServeApp({
      port: 5173,
      host: "127.0.0.1",
      distDir: dist,
      endpoint: ENDPOINT,
      apiKey: null,
      open: false,
    });

    const index = await app.request("http://localhost/");
    expect(await index.text()).toContain("mailcal");
    expect(index.headers.get("content-type")).toContain("text/html");

    const asset = await app.request("http://localhost/app.js");
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    const route = await app.request("http://localhost/settings/domains");
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("mailcal");

    // A missing *asset* is an honest 404, not the SPA shell.
    const missing = await app.request("http://localhost/missing.js");
    expect(missing.status).toBe(404);
  });

  test("a traversal attempt never serves a file outside the bundle", async () => {
    const dist = await createDist();
    const app = createClientServeApp({
      port: 5173,
      host: "127.0.0.1",
      distDir: dist,
      endpoint: ENDPOINT,
      apiKey: null,
      open: false,
    });

    for (const path of [
      "/../../etc/passwd",
      "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    ]) {
      const response = await app.request(`http://localhost${path}`);
      const body = await response.text();
      // Either the SPA shell or a 404 -- never the contents of a file above
      // the bundle root.
      expect(body).not.toContain("root:");
      expect([200, 404]).toContain(response.status);
      if (response.status === 200) {
        expect(body).toContain("mailcal");
      }
    }
  });

  test("proxies API paths and injects the key", async () => {
    const dist = await createDist();
    const seen: { url?: string; headers?: Headers; body?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = new Headers(init.headers);
      seen.body = new TextDecoder().decode(init.body as unknown as ArrayBuffer);
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });
    });

    const app = createClientServeApp({
      port: 5173,
      host: "127.0.0.1",
      distDir: dist,
      endpoint: ENDPOINT,
      apiKey: "ybm_abc_secret",
      open: false,
    });

    const response = await app.request("http://localhost/graphql?x=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { capabilities } }" }),
    });

    expect(response.status).toBe(200);
    expect(seen.url).toBe(`${ENDPOINT}/graphql?x=1`);
    expect(seen.headers?.get("authorization")).toBe("Bearer ybm_abc_secret");
    // The local listener's host must not be forwarded upstream.
    expect(seen.headers?.get("host")).toBeNull();
    expect(seen.body).toContain("viewer");
  });

  test("omits the key when it is not configured for injection", async () => {
    const dist = await createDist();
    let authorization: string | null = "unset";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      authorization = new Headers(init.headers).get("authorization");
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });

    const app = createClientServeApp({
      port: 5173,
      host: "0.0.0.0",
      distDir: dist,
      endpoint: ENDPOINT,
      apiKey: null,
      open: false,
    });
    await app.request("http://localhost/graphql", {
      method: "POST",
      body: "{}",
    });
    expect(authorization).toBeNull();
  });

  test("reports an unreachable upstream as a 502", async () => {
    const dist = await createDist();
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused");
    });
    const app = createClientServeApp({
      port: 5173,
      host: "127.0.0.1",
      distDir: dist,
      endpoint: ENDPOINT,
      apiKey: null,
      open: false,
    });
    const response = await app.request("http://localhost/graphql", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
  });

  test("explains a missing build rather than 404ing silently", async () => {
    const app = createClientServeApp({
      port: 5173,
      host: "127.0.0.1",
      distDir: "/definitely/not/built",
      endpoint: ENDPOINT,
      apiKey: null,
      open: false,
    });
    const response = await app.request("http://localhost/");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain("build-web");
  });
});

describe("createCliClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("maps a GraphQL error onto its exit code", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = createCliClient({ endpoint: ENDPOINT, apiKey: null });
    await expect(client.request("{ viewer }")).rejects.toMatchObject({
      exitCode: ExitCode.ForbiddenError,
    });
  });

  test("maps a network failure to the network exit code", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const client = createCliClient({ endpoint: ENDPOINT, apiKey: null });
    await expect(client.request("{ viewer }")).rejects.toMatchObject({
      exitCode: ExitCode.NetworkError,
    });
  });

  test("sends the bearer key when configured", async () => {
    let authorization: string | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      authorization = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = createCliClient({ endpoint: ENDPOINT, apiKey: "ybm_a_b" });
    await client.request("{ ok }");
    expect(authorization).toBe("Bearer ybm_a_b");
  });
});

describe("runCli", () => {
  test("--version prints and succeeds", async () => {
    expect(await runCli(["--version"], {})).toBe(ExitCode.Success);
  });

  test("--help succeeds", async () => {
    expect(await runCli(["--help"], {})).toBe(ExitCode.Success);
  });

  test("no command prints help and reports a usage error", async () => {
    expect(await runCli([], {})).toBe(ExitCode.UsageError);
  });

  test.each([
    [["nonsense"]],
    [["client", "nonsense"]],
    [["domain", "nonsense"]],
  ])("rejects %o as a usage error", async (argv) => {
    await expect(runCli(argv, {})).rejects.toMatchObject({
      exitCode: ExitCode.UsageError,
    });
  });

  test("a command with no endpoint is a usage error", async () => {
    await expect(
      runCli(["domain", "list"], { MAILCAL_CONFIG: "/nope.json" }),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
  });
});

describe("mail list filters", () => {
  interface RecordedRequest {
    readonly query: string;
    readonly variables: Record<string, unknown> | undefined;
  }

  function recordingContext(argv: readonly string[]): {
    readonly ctx: Parameters<
      NonNullable<ReturnType<(typeof mailCommands)["get"]>>
    >[0];
    readonly requests: RecordedRequest[];
  } {
    const requests: RecordedRequest[] = [];
    const client = {
      async request<T>(
        query: string,
        variables?: Record<string, unknown>,
      ): Promise<T> {
        requests.push({ query, variables });
        if (query.includes("tags {")) {
          return {
            tags: [{ id: "t1", name: "Invoices" }],
          } as unknown as T;
        }
        return { messages: { nodes: [] } } as unknown as T;
      },
      async uploadAttachment() {
        throw new Error("not used");
      },
    };
    return {
      requests,
      ctx: {
        args: parseArgs(argv),
        config: { endpoint: ENDPOINT, apiKey: null },
        client: client as never,
        env: {},
        json: true,
      },
    };
  }

  async function listedFilter(
    argv: readonly string[],
  ): Promise<Record<string, unknown> | undefined> {
    const { ctx, requests } = recordingContext(argv);
    const handler = mailCommands.get("list");
    if (handler === undefined) {
      throw new Error("mail list handler missing");
    }
    await handler(ctx);
    const listRequest = requests.find((request) =>
      request.query.includes("messages("),
    );
    return listRequest?.variables?.["filter"] as
      | Record<string, unknown>
      | undefined;
  }

  test("a bare listing sends no filter", async () => {
    expect(await listedFilter(["mail", "list"])).toBeUndefined();
  });

  test("--to excludes cc, --recipient includes it", async () => {
    expect(await listedFilter(["mail", "list", "--to", "a@x.com"])).toEqual({
      toAddress: "a@x.com",
    });
    expect(
      await listedFilter(["mail", "list", "--recipient", "a@x.com"]),
    ).toEqual({ recipientAddress: "a@x.com" });
  });

  test("sender, search, unread and spam flags map through", async () => {
    expect(
      await listedFilter([
        "mail",
        "list",
        "--from",
        "b@x.com",
        "--search",
        "refund",
        "--unread",
        "--include-spam",
      ]),
    ).toEqual({
      fromAddress: "b@x.com",
      search: "refund",
      unreadOnly: true,
      includeSpam: true,
    });
  });

  test("attachment flags map through, kinds normalized to upper case", async () => {
    expect(await listedFilter(["mail", "list", "--has-attachment"])).toEqual({
      hasAttachment: true,
    });
    expect(await listedFilter(["mail", "list", "--no-attachment"])).toEqual({
      hasAttachment: false,
    });
    expect(
      await listedFilter([
        "mail",
        "list",
        "--attachment-kind",
        "pdf,image",
        "--attachment-kind",
        "archive",
      ]),
    ).toEqual({ attachmentKinds: ["PDF", "IMAGE", "ARCHIVE"] });
  });

  test("an unknown attachment kind is a usage error", async () => {
    await expect(
      listedFilter(["mail", "list", "--attachment-kind", "hologram"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
  });

  test("tag names resolve to ids case-insensitively", async () => {
    expect(await listedFilter(["mail", "list", "--tag", "invoices"])).toEqual({
      tagIds: ["t1"],
    });
  });

  test("an unknown tag name is a not-found error, not a silent no-op", async () => {
    await expect(
      listedFilter(["mail", "list", "--tag", "nonexistent"]),
    ).rejects.toMatchObject({ exitCode: ExitCode.NotFoundError });
  });
});
