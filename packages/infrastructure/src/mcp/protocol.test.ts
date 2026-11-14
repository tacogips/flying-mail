import { Capability } from "@flying-mail/domain/entities/api-key";
import { ForbiddenError } from "@flying-mail/application/errors";
import { apiKeyViewer } from "@flying-mail/application/test-support/viewer-fixtures";
import { describe, expect, test } from "vitest";
import { MCP_SUPPORTED_VERSIONS, UNTRUSTED_NOTICE } from "./constants";
import { dispatchMcpMessage } from "./protocol";
import { createMcpTestHarness } from "./mcp-test-support";
import { buildToolRegistry, MCP_CATALOGUE_ORDER } from "./tool-registry";
import { defineTool, type McpToolContext } from "./tool-types";
import type { McpAuditLine } from "./audit";
import type { FieldSpecMap } from "./tool-schema";

const emptyInput = {} as const satisfies FieldSpecMap;
const readTool = defineTool({
  name: "search_messages",
  title: "Search messages",
  description: "Search mail",
  visibleWith: [Capability.MailRead],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: emptyInput,
  execute: async () => ({
    summary: "Found messages",
    structured: { count: 1 },
    containsUntrusted: true,
  }),
});
const adminTool = defineTool({
  name: "list_users",
  title: "List users",
  description: "List users",
  visibleWith: [Capability.UserAdmin],
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: emptyInput,
  execute: async () => ({
    summary: "Users",
    structured: { count: 0 },
    containsUntrusted: false,
  }),
});
const registry = buildToolRegistry([[adminTool, readTool]]);
const viewer = apiKeyViewer([{ capability: Capability.MailRead }]);
if (viewer.kind !== "API_KEY") throw new Error("Expected test API-key viewer");
const context = { viewer, usecases: {}, deps: {} } as unknown as McpToolContext;

async function dispatch(message: unknown, headers = new Headers()) {
  const audit: McpAuditLine[] = [];
  let time = 10;
  const output = await dispatchMcpMessage({
    message,
    headers,
    registry,
    context,
    keyPrefix: "ybm_prefix",
    clientIp: null,
    audit: (line) => audit.push(line),
    nowMs: () => time++,
  });
  return { output, audit };
}
function response(output: {
  readonly body: Readonly<Record<string, unknown>> | null;
}): Record<string, unknown> {
  return output.body ?? {};
}
function errorCode(output: {
  readonly body: Readonly<Record<string, unknown>> | null;
}): unknown {
  const error = response(output)["error"];
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)["code"]
    : undefined;
}
function modernHeaders(method: string, name?: string): Headers {
  const headers = new Headers({
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  });
  if (name !== undefined) headers.set("Mcp-Name", name);
  return headers;
}
function modern(
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    },
  };
}

describe("MCP protocol core", () => {
  test("supports legacy initialize negotiation, notifications and ping", async () => {
    const init = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(response(init.output)["result"]).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "flying-mail" },
    });
    expect(JSON.stringify(init.output.body)).not.toContain("Mcp-Session-Id");
    const fallback = await dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(response(fallback.output)["result"]).toMatchObject({
      protocolVersion: "2025-11-25",
    });
    expect(
      (await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .output,
    ).toEqual({ status: 202, body: null });
    expect(
      response(
        (await dispatch({ jsonrpc: "2.0", id: 3, method: "ping" })).output,
      )["result"],
    ).toEqual({});
  });

  test("classifies modern discovery and rejects unsupported versions or missing headers", async () => {
    const discovery = await dispatch(
      modern("server/discover"),
      modernHeaders("server/discover"),
    );
    expect(response(discovery.output)["result"]).toMatchObject({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      resultType: "complete",
    });
    const unknownVersion = await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
      },
    });
    expect(unknownVersion.output.status).toBe(400);
    expect(errorCode(unknownVersion.output)).toBe(-32022);
    expect(response(unknownVersion.output)["error"]).toMatchObject({
      data: {
        supported: MCP_SUPPORTED_VERSIONS,
        requested: "1900-01-01",
      },
    });
    const invalidHeader = await dispatch(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      new Headers({ "MCP-Protocol-Version": "1999-01-01" }),
    );
    expect(errorCode(invalidHeader.output)).toBe(-32022);
    const missingModernMeta = await dispatch(
      { jsonrpc: "2.0", id: 6, method: "tools/list" },
      new Headers({ "MCP-Protocol-Version": "2026-07-28" }),
    );
    expect(errorCode(missingModernMeta.output)).toBe(-32020);
    const missingMethodHeader = await dispatch(
      modern("tools/list"),
      new Headers({ "MCP-Protocol-Version": "2026-07-28" }),
    );
    expect(errorCode(missingMethodHeader.output)).toBe(-32020);
  });

  test("validates modern MCP-Name and accepts base64 sentinel", async () => {
    const request = modern("tools/call", {
      name: "search_messages",
      arguments: {},
    });
    const mismatch = await dispatch(
      request,
      modernHeaders("tools/call", "other"),
    );
    expect(errorCode(mismatch.output)).toBe(-32020);
    const encoded = btoa("search_messages");
    const accepted = await dispatch(
      request,
      modernHeaders("tools/call", `=?base64?${encoded}?=`),
    );
    expect(accepted.output.status).toBe(200);
    expect(accepted.audit[0]?.outcome).toBe("ok");
  });

  test("frames invalid requests and preserves era-specific method errors", async () => {
    expect((await dispatch([])).output.status).toBe(400);
    expect(
      errorCode(
        (await dispatch({ jsonrpc: "2.0", id: 1, method: "x", result: {} }))
          .output,
      ),
    ).toBe(-32600);
    const legacyUnknown = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "unknown",
    });
    expect(legacyUnknown.output.status).toBe(200);
    expect(errorCode(legacyUnknown.output)).toBe(-32601);
    const modernUnknown = await dispatch(modern("ping"), modernHeaders("ping"));
    expect(modernUnknown.output.status).toBe(404);
    expect(errorCode(modernUnknown.output)).toBe(-32601);
  });

  test("filters tools and treats hidden tools as unknown while auditing calls", async () => {
    const listed = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const listedResult = response(listed.output)["result"] as Record<
      string,
      unknown
    >;
    expect(listedResult["tools"]).toMatchObject([{ name: "search_messages" }]);
    expect(listedResult).not.toHaveProperty("ttlMs");
    expect(listedResult).not.toHaveProperty("cacheScope");
    const hidden = await dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_users" },
    });
    const absent = await dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "made_up" },
    });
    expect(hidden.output.body).toEqual({ ...absent.output.body, id: 2 });
    expect(hidden.audit).toHaveLength(1);
    expect(hidden.audit[0]).toMatchObject({
      outcome: "rejected",
      tool: "list_users",
    });
    const nonString = await dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: 42 },
    });
    expect(nonString.audit[0]).toMatchObject({
      outcome: "rejected",
      tool: "<unknown>",
    });
    const success = await dispatch({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "search_messages" },
    });
    expect(success.audit[0]?.outcome).toBe("ok");
    const result = response(success.output)["result"] as Record<
      string,
      unknown
    >;
    const contents = result["content"] as readonly { readonly text: string }[];
    const structuredText = contents[1]?.text;
    expect(structuredText).toBeTypeOf("string");
    expect(JSON.parse(structuredText ?? "null")).toEqual(
      result["structuredContent"],
    );
    expect(
      (result["content"] as { text: string }[])[0]?.text.endsWith(
        UNTRUSTED_NOTICE,
      ),
    ).toBe(true);
    expect(MCP_CATALOGUE_ORDER[0]).toBe("search_messages");
  });

  test("registry rejects duplicates and names outside the fixed catalogue", () => {
    expect(() => buildToolRegistry([[readTool], [readTool]])).toThrow(
      /Duplicate/,
    );
    const rogue = defineTool({
      name: "rogue_tool",
      title: "Rogue",
      description: "Not catalogued",
      visibleWith: [Capability.MailRead],
      annotations: readTool.annotations,
      input: emptyInput,
      execute: async () => ({
        summary: "",
        structured: {},
        containsUntrusted: false,
      }),
    });
    expect(() => buildToolRegistry([[rogue]])).toThrow(/catalogue/);
  });

  test("maps tool failures and smoke-tests the shared test harness", async () => {
    const failing = defineTool({
      name: "get_message",
      title: "Get message",
      description: "Read message",
      visibleWith: [Capability.MailRead],
      annotations: readTool.annotations,
      input: emptyInput,
      execute: async () => {
        throw new ForbiddenError("denied");
      },
    });
    const failingRegistry = buildToolRegistry([[failing]]);
    const failedAudit: McpAuditLine[] = [];
    const failed = await dispatchMcpMessage({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_message" },
      },
      headers: new Headers(),
      registry: failingRegistry,
      context,
      keyPrefix: "ybm_prefix",
      clientIp: null,
      audit: (line) => failedAudit.push(line),
      nowMs: () => 1,
    });
    const failureResult = response(failed)["result"] as Record<string, unknown>;
    expect(failureResult["isError"]).toBe(true);
    expect(failureResult["structuredContent"]).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(failedAudit[0]).toMatchObject({
      outcome: "tool_error",
      error_code: "FORBIDDEN",
    });

    const harness = await createMcpTestHarness();
    const { viewer } = await harness.issueKey([
      {
        capability: Capability.MailRead,
        domainId: harness.domainId,
        addressPattern: "*",
      },
    ]);
    expect(viewer.scopes).toHaveLength(1);
    const seeded = await harness.seedMessage({
      id: "mcp-harness-1",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["support@example.com"],
      subject: "Harness message",
      textBody: "body",
    });
    expect(await harness.usecases.getMessage(viewer, seeded.id)).toMatchObject({
      id: seeded.id,
    });
    const unknown = await harness.callTool(viewer, "missing_tool", {});
    expect(unknown.status).toBe(200);
    expect(unknown.body?.["error"]).toMatchObject({ code: -32602 });
  });
});
