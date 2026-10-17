import { viewerHoldsCapability } from "@flying-mail/application/policies";
import type { McpViewer, McpToolDefinition } from "./tool-types";
import { ATTACHMENT_TOOLS } from "./tools/attachment-tools";
import { COMPOSE_TOOLS } from "./tools/compose-tools";
import { MANAGE_TOOLS } from "./tools/manage-tools";
import { READ_TOOLS } from "./tools/read-tools";
import { USER_ADMIN_TOOLS } from "./tools/user-admin-tools";

export const MCP_CATALOGUE_ORDER = [
  "search_messages",
  "get_message",
  "get_thread",
  "list_mailboxes",
  "send_message",
  "reply_message",
  "forward_message",
  "list_drafts",
  "save_draft",
  "update_draft",
  "send_draft",
  "delete_draft",
  "upload_attachment",
  "get_attachment",
  "mark_read",
  "mark_unread",
  "list_tags",
  "tag_messages",
  "untag_messages",
  "move_to_trash",
  "mark_spam",
  "mark_not_spam",
  "list_users",
  "set_user_role",
  "set_user_active",
  "add_mail_permission",
  "remove_mail_permission",
] as const;

export interface McpToolRegistry {
  readonly tools: readonly McpToolDefinition[];
  find(name: string): McpToolDefinition | undefined;
  visibleTo(viewer: McpViewer): readonly McpToolDefinition[];
}

export function buildToolRegistry(
  groups: readonly (readonly McpToolDefinition[])[],
): McpToolRegistry {
  const names = new Set<string>();
  const tools = groups.flatMap((group) => [...group]);
  for (const tool of tools) {
    if (
      !MCP_CATALOGUE_ORDER.includes(
        tool.name as (typeof MCP_CATALOGUE_ORDER)[number],
      )
    ) {
      throw new Error(`Tool is not in the MCP catalogue: ${tool.name}`);
    }
    if (names.has(tool.name))
      throw new Error(`Duplicate MCP tool: ${tool.name}`);
    names.add(tool.name);
  }
  const order = new Map<string, number>(
    MCP_CATALOGUE_ORDER.map((name, index) => [name, index]),
  );
  tools.sort(
    (left, right) => (order.get(left.name) ?? 0) - (order.get(right.name) ?? 0),
  );
  return {
    tools,
    find: (name) => tools.find((tool) => tool.name === name),
    visibleTo: (viewer) =>
      tools.filter((tool) =>
        tool.visibleWith.some((capability) =>
          viewerHoldsCapability(viewer, capability),
        ),
      ),
  };
}

export const MCP_TOOL_REGISTRY = buildToolRegistry([
  READ_TOOLS,
  COMPOSE_TOOLS,
  ATTACHMENT_TOOLS,
  MANAGE_TOOLS,
  USER_ADMIN_TOOLS,
]);
