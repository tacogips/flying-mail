import { readFile } from "node:fs/promises";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { UserPermissionEffect } from "@flying-mail/domain/entities/user-mail-permission";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createUserId } from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { MCP_TOOL_REGISTRY } from "../tool-registry";
import { createMcpTestHarness } from "../mcp-test-support";

const USER_ADMIN_TOOL_NAMES = [
  "list_users",
  "set_user_role",
  "set_user_active",
  "add_mail_permission",
  "remove_mail_permission",
] as const;
const NOW = "2026-08-23T00:00:00.000Z";

async function setup() {
  const harness = await createMcpTestHarness();
  const key = await harness.issueKey([
    {
      capability: Capability.UserAdmin,
      domainId: null,
      addressPattern: "*",
    },
  ]);
  const memberId = createUserId("usr-mcp-test-member");
  harness.fake.stores.users.set(
    memberId,
    createUser({
      id: memberId,
      email: createEmailAddress("member@example.com"),
      name: "Test Member",
      role: UserRole.Member,
      createdAt: NOW,
      invitationAcceptedAt: NOW,
    }),
  );
  return { ...harness, viewer: key.viewer, memberId };
}

function toolResult(body: Readonly<Record<string, unknown>> | null) {
  const result = body?.["result"];
  if (typeof result !== "object" || result === null)
    throw new Error("Expected a tool result");
  return result as Record<string, unknown>;
}

function structuredContent(body: Readonly<Record<string, unknown>> | null) {
  const structured = toolResult(body)["structuredContent"];
  if (typeof structured !== "object" || structured === null)
    throw new Error("Expected structured tool content");
  return structured as Record<string, unknown>;
}

function errorCode(body: Readonly<Record<string, unknown>> | null): unknown {
  const error = structuredContent(body)["error"];
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)["code"]
    : undefined;
}

describe("MCP USER_ADMIN tools", () => {
  test("shows the five tools only to USER_ADMIN keys and hides calls from other keys", async () => {
    const { issueKey, listTools, callTool, viewer } = await setup();
    expect(await listTools(viewer)).toEqual(USER_ADMIN_TOOL_NAMES);

    const readKey = await issueKey([
      {
        capability: Capability.MailRead,
        domainId: null,
        addressPattern: "*",
      },
    ]);
    expect(await listTools(readKey.viewer)).not.toEqual(
      expect.arrayContaining([...USER_ADMIN_TOOL_NAMES]),
    );
    const hiddenCall = await callTool(readKey.viewer, "list_users", {});
    expect(hiddenCall.status).toBe(200);
    expect(hiddenCall.body?.["error"]).toMatchObject({ code: -32602 });
  });

  test("lists users with mapped permissions and updates a user's role", async () => {
    const { callTool, viewer, memberId } = await setup();
    const listed = await callTool(viewer, "list_users", {});
    const users = structuredContent(listed.body)["users"] as Array<
      Record<string, unknown>
    >;
    expect(users).toHaveLength(2);
    expect(users.find((user) => user["id"] === memberId)).toMatchObject({
      email: "member@example.com",
      name: "Test Member",
      role: "MEMBER",
      active: true,
      invitation_accepted: true,
      permissions: [],
    });

    const changed = await callTool(viewer, "set_user_role", {
      user_id: memberId,
      role: UserRole.Admin,
    });
    expect(structuredContent(changed.body)["user"]).toMatchObject({
      id: memberId,
      role: "ADMIN",
      active: true,
    });
  });

  test("refuses to demote the last active administrator", async () => {
    const { callTool, viewer, fake } = await setup();
    const admin = [...fake.stores.users.values()].find(
      (user) => user.role === UserRole.Admin,
    );
    expect(admin).toBeDefined();
    const outcome = await callTool(viewer, "set_user_role", {
      user_id: admin?.id,
      role: UserRole.Member,
    });
    expect(toolResult(outcome.body)["isError"]).toBe(true);
    expect(errorCode(outcome.body)).toBe("CONFLICT");
  });

  test("deactivates a member and adds then removes a mail permission", async () => {
    const { callTool, viewer, memberId } = await setup();
    const deactivated = await callTool(viewer, "set_user_active", {
      user_id: memberId,
      active: false,
    });
    expect(structuredContent(deactivated.body)["user"]).toMatchObject({
      id: memberId,
      active: false,
    });

    const added = await callTool(viewer, "add_mail_permission", {
      user_id: memberId,
      effect: UserPermissionEffect.Allow,
      address_pattern: "*",
    });
    const permission = structuredContent(added.body)["permission"] as Record<
      string,
      unknown
    >;
    expect(permission).toMatchObject({
      user_id: memberId,
      effect: "ALLOW",
      domain_id: null,
      address_pattern: "*",
    });
    expect(typeof permission["id"]).toBe("string");

    const removed = await callTool(viewer, "remove_mail_permission", {
      permission_id: permission["id"],
    });
    expect(structuredContent(removed.body)).toEqual({
      removed: true,
      permission_id: permission["id"],
    });
  });

  test.each(["demoted", "deactivated"] as const)(
    "rejects USER_ADMIN calls when the key creator is %s",
    async (change) => {
      const { callTool, viewer, fake } = await setup();
      const creator = [...fake.stores.users.values()].find(
        (user) => user.role === UserRole.Admin,
      );
      expect(creator).toBeDefined();
      if (creator !== undefined) {
        fake.stores.users.set(creator.id, {
          ...creator,
          ...(change === "demoted"
            ? { role: UserRole.Member }
            : { deactivatedAt: NOW }),
        });
      }
      const outcome = await callTool(viewer, "list_users", {});
      expect(toolResult(outcome.body)["isError"]).toBe(true);
      expect(errorCode(outcome.body)).toBe("FORBIDDEN");
    },
  );

  test("keeps user creation, invitation, and login tools out of the registry and source", async () => {
    expect(
      MCP_TOOL_REGISTRY.tools
        .map((tool) => tool.name)
        .some((name) => /create_user|invit|login|resend/i.test(name)),
    ).toBe(false);
    const source = await readFile(
      new URL("./user-admin-tools.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /\bcreateUser\b|\bresendInvitation\b|\brequestEmailAuth\b|\bverifyEmailAuthToken\b/,
    );
  });
});
