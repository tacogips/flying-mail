import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "./args";
import type { CliGraphQLClient } from "./client";
import { adminCommands } from "./commands/admin-bootstrap";
import type { CommandContext } from "./commands";
import { ExitCode } from "./exit-codes";
import { main } from "./main";

const TOKEN = "a-bootstrap-token-that-is-never-printed";
const SECRET = "ybm_secret_full_value";
const ENDPOINT = "https://mail.example.com";

let temporaryDirectory: string;
let printedOutput: string[];

function context(
  flags: readonly string[],
  env: Record<string, string | undefined> = {
    FLYING_MAIL_BOOTSTRAP_TOKEN: TOKEN,
  },
  json = false,
): CommandContext {
  return {
    args: parseArgs(["admin", "bootstrap", ...flags]),
    config: { endpoint: ENDPOINT, apiKey: "configured-api-key" },
    client: {} as CliGraphQLClient,
    env,
    json,
  };
}

function handler() {
  const command = adminCommands.get("bootstrap");
  if (command === undefined) {
    throw new Error("admin bootstrap command is not registered");
  }
  return command;
}

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        bootstrapAdmin: {
          secret: SECRET,
          apiKey: { keyPrefix: "ybm_live_…" },
          user: {
            id: "user-1",
            email: "admin@example.com",
            name: "Admin",
            role: "ADMIN",
          },
        },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "flying-mail-bootstrap-"));
  printedOutput = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    printedOutput.push(values.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("admin bootstrap command", () => {
  test("missing email or token fails before a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handler()(
        context([
          "--name",
          "Admin",
          "--secret-file",
          join(temporaryDirectory, "key"),
        ]),
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
    await expect(
      handler()(
        context(
          [
            "--email",
            "admin@example.com",
            "--name",
            "Admin",
            "--secret-file",
            join(temporaryDirectory, "key"),
          ],
          {},
        ),
      ),
    ).rejects.toMatchObject({
      exitCode: ExitCode.UsageError,
      message: "FLYING_MAIL_BOOTSTRAP_TOKEN is not set (run under kinko exec)",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      main(
        [
          "admin",
          "bootstrap",
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
        ],
        {},
      ),
    ).resolves.toBe(ExitCode.UsageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects an existing secret file before a network call", async () => {
    const secretFile = join(temporaryDirectory, "key");
    await writeFile(secretFile, "previous-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handler()(
        context([
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
          "--secret-file",
          secretFile,
        ]),
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.GeneralError });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends the token as a variable without API-key auth and stores the secret privately", async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requestInit = init;
      return successfulResponse();
    });
    const secretFile = join(temporaryDirectory, "nested", "key");

    await expect(
      handler()(
        context([
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
          "--secret-file",
          secretFile,
        ]),
      ),
    ).resolves.toBe(ExitCode.Success);

    expect(requestInit).toBeDefined();
    const headers = new Headers(requestInit?.headers);
    const body = JSON.parse(String(requestInit?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.variables["token"]).toBe(TOKEN);
    expect(body.query).not.toContain(TOKEN);
    expect(headers.has("authorization")).toBe(false);
    expect(await readFile(secretFile, "utf8")).toBe(`${SECRET}\n`);
    expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
    const printed = printedOutput.join("\n");
    expect(printed).toContain("ybm_live_…");
    expect(printed).toContain("admin@example.com");
    expect(printed).not.toContain(SECRET);
  });

  test("JSON output excludes the secret", async () => {
    vi.stubGlobal("fetch", async () => successfulResponse());
    await handler()(
      context(
        [
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
          "--secret-file",
          join(temporaryDirectory, "key"),
        ],
        { FLYING_MAIL_BOOTSTRAP_TOKEN: TOKEN },
        true,
      ),
    );

    const result = JSON.parse(printedOutput[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(result).not.toHaveProperty("secret");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test.each([
    ["FORBIDDEN", ExitCode.ForbiddenError],
    ["CONFLICT", ExitCode.GeneralError],
  ])("maps %s and writes no secret file", async (code, exitCode) => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: "bootstrap rejected", extensions: { code } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const secretFile = join(temporaryDirectory, "key");

    await expect(
      handler()(
        context([
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
          "--secret-file",
          secretFile,
        ]),
      ),
    ).rejects.toMatchObject({ exitCode });
    await expect(stat(secretFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not accept a token flag", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      handler()(
        context([
          "--email",
          "admin@example.com",
          "--name",
          "Admin",
          "--token",
          TOKEN,
          "--secret-file",
          join(temporaryDirectory, "key"),
        ]),
      ),
    ).rejects.toMatchObject({ exitCode: ExitCode.UsageError });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
