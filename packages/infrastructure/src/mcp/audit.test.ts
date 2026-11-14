import { afterEach, describe, expect, test, vi } from "vitest";
import { auditToolName, consoleAuditSink, type McpAuditLine } from "./audit";

describe("MCP audit", () => {
  afterEach(() => vi.restoreAllMocks());

  test("unknown names cannot inject log lines", () => {
    expect(auditToolName("x\n{evil}", new Set(["search_messages"]))).toBe(
      "<unknown>",
    );
  });

  test("writes exactly one JSON line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const line: McpAuditLine = {
      event: "mcp.tool_call",
      api_key_id: "key-1",
      key_prefix: "ybm_abcd",
      tool: "search_messages",
      outcome: "ok",
      error_code: null,
      duration_ms: 4,
      protocol_version: "2025-11-25",
      client_ip: null,
    };
    consoleAuditSink(line);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe(JSON.stringify(line));
  });
});
