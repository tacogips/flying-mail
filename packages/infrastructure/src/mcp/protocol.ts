import {
  MCP_DISCOVER_TTL_MS,
  MCP_INSTRUCTIONS,
  MCP_LATEST_LEGACY_VERSION,
  MCP_LEGACY_VERSIONS,
  MCP_SERVER_INFO,
  MCP_SUPPORTED_VERSIONS,
  MCP_TOOLS_LIST_TTL_MS,
  UNTRUSTED_NOTICE,
} from "./constants";
import { auditToolName, type McpAuditSink } from "./audit";
import { toolErrorResult } from "./errors";
import {
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  UNSUPPORTED_PROTOCOL_VERSION,
  jsonRpcError,
  jsonRpcResult,
  type JsonRpcId,
} from "./jsonrpc";
import type { McpToolContext } from "./tool-types";
import type { McpToolRegistry } from "./tool-registry";
import { MCP_CATALOGUE_ORDER } from "./tool-registry";

export interface McpDispatchInput {
  readonly message: unknown;
  readonly headers: Headers;
  readonly registry: McpToolRegistry;
  readonly context: McpToolContext;
  readonly keyPrefix: string;
  readonly clientIp: string | null;
  readonly audit: McpAuditSink;
  readonly nowMs: () => number;
}
export interface McpDispatchOutput {
  readonly status: 200 | 202 | 400 | 404;
  readonly body: Readonly<Record<string, unknown>> | null;
}

interface RpcMessage {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(): McpDispatchOutput {
  return {
    status: 400,
    body: jsonRpcError(null, INVALID_REQUEST, "Invalid Request"),
  };
}

function parseMessage(value: unknown): RpcMessage | null | "notification" {
  if (!record(value) || "result" in value || "error" in value) return null;
  if (value["jsonrpc"] !== "2.0" || typeof value["method"] !== "string")
    return null;
  if (
    Object.hasOwn(value, "id") &&
    !(
      typeof value["id"] === "string" ||
      (typeof value["id"] === "number" && Number.isInteger(value["id"]))
    )
  )
    return null;
  if (!Object.hasOwn(value, "id")) return "notification";
  const paramsValue = value["params"];
  return {
    id: value["id"] as JsonRpcId,
    method: value["method"],
    params: record(paramsValue) ? paramsValue : {},
  };
}

function metaVersion(params: Record<string, unknown>): {
  readonly present: boolean;
  readonly value: unknown;
} {
  const meta = params["_meta"];
  if (!record(meta)) return { present: false, value: undefined };
  const key = "io.modelcontextprotocol/protocolVersion";
  return Object.hasOwn(meta, key)
    ? { present: true, value: meta[key] }
    : { present: false, value: undefined };
}

function mismatch(message: RpcMessage, header: string): McpDispatchOutput {
  return {
    status: 400,
    body: jsonRpcError(
      message.id,
      HEADER_MISMATCH,
      `Header mismatch: ${header}`,
    ),
  };
}

function decodeMcpName(value: string): string {
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  if (match === null) return value;
  const encoded = match[1];
  if (encoded === undefined) throw new Error("Invalid Mcp-Name encoding");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function versionError(id: JsonRpcId, requested: unknown): McpDispatchOutput {
  return {
    status: 400,
    body: jsonRpcError(
      id,
      UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      {
        supported: MCP_SUPPORTED_VERSIONS,
        requested,
      },
    ),
  };
}

function resultBody(
  id: JsonRpcId,
  result: Record<string, unknown>,
  modern: boolean,
): Readonly<Record<string, unknown>> {
  if (modern) {
    return jsonRpcResult(id, {
      ...result,
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO },
    });
  }
  return jsonRpcResult(id, result);
}

function auditLine(
  input: McpDispatchInput,
  tool: string,
  outcome: "ok" | "tool_error" | "rejected",
  errorCode: string | null,
  start: number,
  version: string,
): void {
  input.audit({
    event: "mcp.tool_call",
    api_key_id: String(input.context.viewer.apiKeyId),
    key_prefix: input.keyPrefix,
    tool,
    outcome,
    error_code: errorCode,
    duration_ms: Math.max(0, input.nowMs() - start),
    protocol_version: version,
    client_ip: input.clientIp,
  });
}

async function callTool(
  input: McpDispatchInput,
  message: RpcMessage,
  version: string,
  modern: boolean,
): Promise<McpDispatchOutput> {
  const started = input.nowMs();
  const params = message.params;
  const name = params["name"];
  const auditName = auditToolName(name, new Set<string>(MCP_CATALOGUE_ORDER));
  if (typeof name !== "string") {
    auditLine(
      input,
      "<unknown>",
      "rejected",
      String(INVALID_PARAMS),
      started,
      version,
    );
    return {
      status: 200,
      body: jsonRpcError(
        message.id,
        INVALID_PARAMS,
        "Tool name must be a string",
      ),
    };
  }
  const tool = input.registry.find(name);
  if (
    tool === undefined ||
    !input.registry.visibleTo(input.context.viewer).includes(tool)
  ) {
    auditLine(
      input,
      auditName,
      "rejected",
      String(INVALID_PARAMS),
      started,
      version,
    );
    return {
      status: 200,
      body: jsonRpcError(message.id, INVALID_PARAMS, "Unknown tool"),
    };
  }
  try {
    const outcome = await tool.run(params["arguments"], input.context);
    const content = [
      {
        type: "text",
        text:
          outcome.summary +
          (outcome.containsUntrusted ? `\n${UNTRUSTED_NOTICE}` : ""),
      },
      { type: "text", text: JSON.stringify(outcome.structured) },
    ];
    auditLine(input, tool.name, "ok", null, started, version);
    return {
      status: 200,
      body: resultBody(
        message.id,
        {
          content,
          structuredContent: outcome.structured,
          isError: false,
        },
        modern,
      ),
    };
  } catch (error) {
    const mapped = toolErrorResult(error);
    const code = mapped.structuredContent.error.code;
    auditLine(input, tool.name, "tool_error", code, started, version);
    return { status: 200, body: resultBody(message.id, { ...mapped }, modern) };
  }
}

export async function dispatchMcpMessage(
  input: McpDispatchInput,
): Promise<McpDispatchOutput> {
  const parsed = parseMessage(input.message);
  if (parsed === null) return invalidRequest();
  if (parsed === "notification") return { status: 202, body: null };
  const message = parsed;

  if (message.method === "initialize") {
    const requested = message.params["protocolVersion"];
    const version =
      typeof requested === "string" &&
      (MCP_LEGACY_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_LATEST_LEGACY_VERSION;
    return {
      status: 200,
      body: jsonRpcResult(message.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      }),
    };
  }

  const meta = metaVersion(message.params);
  let version: string;
  if (meta.present) {
    if (
      typeof meta.value !== "string" ||
      !(MCP_SUPPORTED_VERSIONS as readonly string[]).includes(meta.value)
    ) {
      return versionError(message.id, meta.value);
    }
    version = meta.value;
    if (input.headers.get("MCP-Protocol-Version") !== version)
      return mismatch(message, "MCP-Protocol-Version");
    if (input.headers.get("Mcp-Method") !== message.method)
      return mismatch(message, "Mcp-Method");
    if (message.method === "tools/call") {
      const name = message.params["name"];
      const headerName = input.headers.get("Mcp-Name");
      let decoded: string | null = null;
      try {
        decoded = headerName === null ? null : decodeMcpName(headerName);
      } catch {
        decoded = null;
      }
      if (typeof name !== "string" || decoded !== name)
        return mismatch(message, "Mcp-Name");
    }
  } else {
    const headerVersion = input.headers.get("MCP-Protocol-Version");
    if (headerVersion === null) version = "2025-03-26";
    else if ((MCP_LEGACY_VERSIONS as readonly string[]).includes(headerVersion))
      version = headerVersion;
    else if (headerVersion === "2026-07-28")
      return mismatch(message, "MCP-Protocol-Version");
    else return versionError(message.id, headerVersion);
  }

  const modern = version === "2026-07-28";
  if (modern && message.method === "server/discover") {
    return {
      status: 200,
      body: jsonRpcResult(message.id, {
        resultType: "complete",
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: MCP_INSTRUCTIONS,
        _meta: { "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO },
        ttlMs: MCP_DISCOVER_TTL_MS,
        cacheScope: "private",
      }),
    };
  }
  if (message.method === "ping" && !modern)
    return { status: 200, body: jsonRpcResult(message.id, {}) };
  if (message.method === "tools/list") {
    const tools = input.registry
      .visibleTo(input.context.viewer)
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      }));
    return {
      status: 200,
      body: resultBody(
        message.id,
        {
          tools,
          ...(modern
            ? { ttlMs: MCP_TOOLS_LIST_TTL_MS, cacheScope: "private" }
            : {}),
        },
        modern,
      ),
    };
  }
  if (message.method === "tools/call")
    return callTool(input, message, version, modern);
  return {
    status: modern ? 404 : 200,
    body: jsonRpcError(
      message.id,
      METHOD_NOT_FOUND,
      `Method not found: ${message.method}`,
    ),
  };
}
