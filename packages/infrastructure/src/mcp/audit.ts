export interface McpAuditLine {
  readonly event: "mcp.tool_call";
  readonly api_key_id: string;
  readonly key_prefix: string;
  readonly tool: string;
  readonly outcome: "ok" | "tool_error" | "rejected";
  readonly error_code: string | null;
  readonly duration_ms: number;
  readonly protocol_version: string;
  readonly client_ip: string | null;
}
export type McpAuditSink = (line: McpAuditLine) => void;

export const consoleAuditSink: McpAuditSink = (line) => {
  console.log(JSON.stringify(line));
};

export function auditToolName(
  name: unknown,
  known: ReadonlySet<string>,
): string {
  return typeof name === "string" && known.has(name) ? name : "<unknown>";
}
