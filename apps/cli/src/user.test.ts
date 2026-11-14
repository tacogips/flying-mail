import { afterEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "./args";
import type { CliGraphQLClient } from "./client";
import type { CommandContext } from "./commands";
import { operands, USER_ADMIN_HINT, userCommands } from "./commands/user";
import { CliError, ExitCode } from "./exit-codes";
import { runCli } from "./main";

const users = [
  {
    id: "user-1",
    email: "alice@example.com",
    name: "Alice Example",
    role: "MEMBER",
    active: true,
    invitationStatus: "ACCEPTED",
  },
];

interface RequestRecord {
  readonly query: string;
  readonly variables: Record<string, unknown> | undefined;
}

function setup(responses: readonly unknown[] = []): {
  readonly ctx: Omit<CommandContext, "args"> & { args: CommandContext["args"] };
  readonly requests: RequestRecord[];
  readonly log: ReturnType<typeof vi.spyOn>;
} {
  const queue = [...responses];
  const requests: RequestRecord[] = [];
  const client: CliGraphQLClient = {
    async request<T>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      requests.push({ query, variables });
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response as T;
    },
    async uploadAttachment() {
      throw new Error("Unexpected upload");
    },
  };
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    ctx: {
      args: parseArgs([]),
      config: { endpoint: "https://mail.example.com", apiKey: "test" },
      client,
      env: {},
      json: false,
    },
    requests,
    log,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("user command operands and registration", () => {
  test("combines command and positional operands", () => {
    expect(operands(parseArgs(["user", "show", "a@b.c"]), 2)).toEqual([
      "a@b.c",
    ]);
    expect(
      operands(
        parseArgs(["user", "rule", "add", "--effect", "ALLOW", "a@b.c"]),
        3,
      ),
    ).toEqual(["a@b.c"]);
  });

  test("exposes only the planned command groups and reports nested usage", async () => {
    expect([...userCommands.keys()]).toEqual([
      "list",
      "show",
      "set-role",
      "activate",
      "deactivate",
      "rule",
      "template-rule",
    ]);
    const { ctx, requests } = setup();
    ctx.args = parseArgs(["user", "rule", "bad"]);
    await expect(userCommands.get("rule")?.(ctx)).rejects.toMatchObject({
      exitCode: ExitCode.UsageError,
    });
    expect(requests).toHaveLength(0);
    await expect(runCli(["user", "bogus"], {})).rejects.toThrow(
      /Available: list, show, set-role, activate, deactivate, rule, template-rule/,
    );
  });
});

describe("user list and show", () => {
  test("accepts endpoint and api-key global flags", async () => {
    const list = setup([{ users }]);
    list.ctx.args = parseArgs([
      "user",
      "list",
      "--endpoint",
      "https://mail.example.com",
      "--api-key",
      "k",
    ]);
    await expect(userCommands.get("list")?.(list.ctx)).resolves.toBe(
      ExitCode.Success,
    );
    expect(list.requests).toHaveLength(1);

    const invalid = setup();
    invalid.ctx.args = parseArgs(["user", "list", "--bogus", "x"]);
    await expect(userCommands.get("list")?.(invalid.ctx)).rejects.toMatchObject(
      { exitCode: ExitCode.UsageError },
    );
    expect(invalid.requests).toHaveLength(0);
  });

  test("prints the list table headers and JSON array", async () => {
    const table = setup([{ users }]);
    table.ctx.args = parseArgs(["user", "list"]);
    await userCommands.get("list")?.(table.ctx);
    expect(String(table.log.mock.calls[0]?.[0])).toMatch(
      /ID\s+EMAIL\s+NAME\s+ROLE\s+ACTIVE\s+INVITATION/,
    );

    const json = setup([{ users }]);
    json.ctx.args = parseArgs(["user", "list", "--json"]);
    json.log.mockClear();
    await userCommands.get("list")?.({ ...json.ctx, json: true });
    expect(JSON.parse(String(json.log.mock.calls[0]?.[0]))).toEqual(users);
  });

  test("resolves email case-insensitively and requests detail by id", async () => {
    const detail = {
      ...users[0],
      permissions: [
        {
          id: "rule-1",
          effect: "ALLOW",
          addressPattern: "*",
          domain: null,
          createdByUserId: "admin-1",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
      templatePermissions: [],
    };
    const { ctx, requests, log } = setup([{ users }, { user: detail }]);
    ctx.args = parseArgs(["user", "show", "ALICE@EXAMPLE.COM"]);
    await userCommands.get("show")?.(ctx);
    expect(requests[1]?.variables).toEqual({ id: "user-1" });
    expect(String(log.mock.calls[6]?.[0])).toContain("*");
  });

  test("returns not found for an unmatched user reference", async () => {
    const { ctx, requests } = setup([{ users }]);
    ctx.args = parseArgs(["user", "show", "nobody"]);
    await expect(userCommands.get("show")?.(ctx)).rejects.toMatchObject({
      exitCode: ExitCode.NotFoundError,
      message: "User not found: nobody",
    });
    expect(requests).toHaveLength(1);
  });

  test("does not resolve a user by display name", async () => {
    const { ctx, requests } = setup([{ users }]);
    ctx.args = parseArgs(["user", "show", "Alice Example"]);
    await expect(userCommands.get("show")?.(ctx)).rejects.toMatchObject({
      exitCode: ExitCode.NotFoundError,
      message: "User not found: Alice Example",
    });
    expect(requests).toHaveLength(1);
  });
});

describe("user mutations", () => {
  test("validates set-role before requests and passes role as a variable", async () => {
    const invalid = setup();
    invalid.ctx.args = parseArgs([
      "user",
      "set-role",
      "alice@example.com",
      "OWNER",
    ]);
    await expect(
      userCommands.get("set-role")?.(invalid.ctx),
    ).rejects.toMatchObject({
      exitCode: ExitCode.UsageError,
    });
    expect(invalid.requests).toHaveLength(0);

    const valid = setup([
      { users },
      { setUserRole: { email: users[0]?.email, role: "MEMBER" } },
    ]);
    valid.ctx.args = parseArgs([
      "user",
      "set-role",
      "alice@example.com",
      "member",
    ]);
    await userCommands.get("set-role")?.(valid.ctx);
    expect(valid.requests[1]?.variables).toEqual({
      id: "user-1",
      role: "MEMBER",
    });
  });

  test.each([
    ["activate", true],
    ["deactivate", false],
  ])("%s passes active=%s", async (action, active) => {
    const { ctx, requests } = setup([
      { users },
      { setUserActive: { email: "alice@example.com", active } },
    ]);
    ctx.args = parseArgs(["user", action, "alice@example.com"]);
    await userCommands.get(action)?.(ctx);
    expect(requests[1]?.variables).toEqual({ id: "user-1", active });
  });
});

describe("mail and template permission rules", () => {
  test("accepts endpoint and api-key on mail rule add without changing variables", async () => {
    const { ctx, requests } = setup([
      { users },
      {
        addUserMailPermission: {
          id: "rule-1",
          effect: "ALLOW",
          addressPattern: "*",
          domain: null,
          createdByUserId: "admin-1",
          createdAt: "2026-10-08T00:00:00Z",
        },
      },
    ]);
    ctx.args = parseArgs([
      "user",
      "rule",
      "add",
      "alice@example.com",
      "--effect",
      "ALLOW",
      "--pattern",
      "*",
      "--api-key",
      "k",
      "--endpoint",
      "https://mail.example.com",
    ]);
    await expect(userCommands.get("rule")?.(ctx)).resolves.toBe(
      ExitCode.Success,
    );
    expect(requests[1]?.variables).toEqual({
      userId: "user-1",
      input: { effect: "ALLOW", domainId: null, addressPattern: "*" },
    });
  });

  test("adds mail rule with resolved domain and GraphQL input variables", async () => {
    const { ctx, requests } = setup([
      { users },
      { domains: [{ id: "domain-1", name: "example.com" }] },
      { addUserMailPermission: { id: "rule-1" } },
    ]);
    ctx.args = parseArgs([
      "user",
      "rule",
      "add",
      "alice@example.com",
      "--effect",
      "deny",
      "--domain",
      "example.com",
      "--pattern",
      "support@example.com",
    ]);
    await userCommands.get("rule")?.(ctx);
    expect(requests[2]?.variables).toEqual({
      userId: "user-1",
      input: {
        effect: "DENY",
        domainId: "domain-1",
        addressPattern: "support@example.com",
      },
    });
  });

  test("rejects missing rule pattern before any request and defaults domain to null", async () => {
    const invalid = setup();
    invalid.ctx.args = parseArgs([
      "user",
      "rule",
      "add",
      "alice@example.com",
      "--effect",
      "ALLOW",
    ]);
    await expect(userCommands.get("rule")?.(invalid.ctx)).rejects.toMatchObject(
      {
        exitCode: ExitCode.UsageError,
      },
    );
    expect(invalid.requests).toHaveLength(0);

    const valid = setup([
      { users },
      { addUserMailPermission: { id: "rule-1" } },
    ]);
    valid.ctx.args = parseArgs([
      "user",
      "rule",
      "add",
      "--effect",
      "ALLOW",
      "--pattern",
      "*",
      "alice@example.com",
    ]);
    await userCommands.get("rule")?.(valid.ctx);
    expect(valid.requests[1]?.variables).toMatchObject({
      input: { effect: "ALLOW", domainId: null, addressPattern: "*" },
    });
  });

  test("checks mail rule ownership before remove mutation", async () => {
    const { ctx, requests } = setup([
      { users },
      { user: { permissions: [{ id: "other" }] } },
    ]);
    ctx.args = parseArgs([
      "user",
      "rule",
      "remove",
      "alice@example.com",
      "rule-x",
    ]);
    await expect(userCommands.get("rule")?.(ctx)).rejects.toMatchObject({
      exitCode: ExitCode.NotFoundError,
      message: "Rule rule-x does not belong to alice@example.com",
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.some((request) =>
        request.query.includes("removeUserMailPermission"),
      ),
    ).toBe(false);
  });

  test("adds template rule after validating and normalizing inputs", async () => {
    const invalid = setup();
    invalid.ctx.args = parseArgs([
      "user",
      "template-rule",
      "add",
      "alice@example.com",
      "--capability",
      "BOGUS",
      "--effect",
      "ALLOW",
    ]);
    await expect(
      userCommands.get("template-rule")?.(invalid.ctx),
    ).rejects.toMatchObject({
      exitCode: ExitCode.UsageError,
    });
    expect(invalid.requests).toHaveLength(0);

    const valid = setup([
      { users },
      { addUserTemplatePermission: { id: "template-rule-1" } },
    ]);
    valid.ctx.args = parseArgs([
      "user",
      "template-rule",
      "add",
      "alice@example.com",
      "--capability",
      "template_read",
      "--effect",
      "allow",
    ]);
    await userCommands.get("template-rule")?.(valid.ctx);
    expect(valid.requests[1]?.variables).toEqual({
      userId: "user-1",
      input: { capability: "TEMPLATE_READ", effect: "ALLOW" },
    });
  });
});

describe("user command errors", () => {
  test("adds the USER_ADMIN hint to FORBIDDEN and preserves other errors", async () => {
    const forbidden = setup([
      new CliError("Forbidden", ExitCode.ForbiddenError),
    ]);
    forbidden.ctx.args = parseArgs(["user", "list"]);
    await expect(
      userCommands.get("list")?.(forbidden.ctx),
    ).rejects.toMatchObject({
      exitCode: ExitCode.ForbiddenError,
      message: `Forbidden\n${USER_ADMIN_HINT}`,
    });

    const conflict = setup([
      new CliError("Cannot demote last admin", ExitCode.GeneralError),
    ]);
    conflict.ctx.args = parseArgs(["user", "list"]);
    await expect(
      userCommands.get("list")?.(conflict.ctx),
    ).rejects.toMatchObject({
      exitCode: ExitCode.GeneralError,
      message: "Cannot demote last admin",
    });
  });
});
