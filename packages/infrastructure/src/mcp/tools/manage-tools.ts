import { BadUserInputError } from "@flying-mail/application/errors";
import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createMessageId,
  createTagId,
} from "@flying-mail/domain/value-objects/ids";
import { MCP_MAX_IDS } from "../constants";
import { defineTool, type McpToolDefinition } from "../tool-types";

const MESSAGE_IDS = {
  kind: "string_array",
  required: true,
  maxItems: MCP_MAX_IDS,
  itemMaxLength: 128,
  itemFormat: "id",
  description: "Message ids to update.",
} as const;

const TAG_IDS = {
  kind: "string_array",
  required: true,
  maxItems: 20,
  itemMaxLength: 128,
  itemFormat: "id",
  description: "Tag ids to apply or remove.",
} as const;

function requireMessageIds(
  ids: readonly string[],
): readonly ReturnType<typeof createMessageId>[] {
  if (ids.length === 0) {
    throw new BadUserInputError("message_ids must not be empty", "message_ids");
  }
  return ids.map(createMessageId);
}

function updatedOutcome(
  messages: readonly { readonly id: string }[],
  requested: number,
) {
  return {
    summary: `Updated ${messages.length} of ${requested} messages.`,
    structured: { updated_ids: messages.map(({ id }) => id) },
    containsUntrusted: false,
  } as const;
}

const manageTool = [Capability.MailManage] as const;

export const MANAGE_TOOLS: readonly McpToolDefinition[] = [
  defineTool({
    name: "mark_read",
    title: "Mark messages read",
    description: "Mark messages as read.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS },
    async execute({ message_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const messages = await usecases.markRead(viewer, ids, true);
      return updatedOutcome(messages, ids.length);
    },
  }),
  defineTool({
    name: "mark_unread",
    title: "Mark messages unread",
    description: "Mark messages as unread.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS },
    async execute({ message_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const messages = await usecases.markRead(viewer, ids, false);
      return updatedOutcome(messages, ids.length);
    },
  }),
  defineTool({
    name: "tag_messages",
    title: "Tag messages",
    description: "Apply tags to messages.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS, tag_ids: TAG_IDS },
    async execute({ message_ids, tag_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const tags = tag_ids.map(createTagId);
      const messages = await usecases.tagMessages(viewer, ids, tags);
      return updatedOutcome(messages, ids.length);
    },
  }),
  defineTool({
    name: "untag_messages",
    title: "Remove tags from messages",
    description: "Remove tags from messages.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS, tag_ids: TAG_IDS },
    async execute({ message_ids, tag_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const tags = tag_ids.map(createTagId);
      const messages = await usecases.untagMessages(viewer, ids, tags);
      return updatedOutcome(messages, ids.length);
    },
  }),
  defineTool({
    name: "move_to_trash",
    title: "Move messages to Trash",
    description: "Move messages to Trash without permanently deleting them.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS },
    async execute({ message_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const trashedCount = await usecases.trashMessages(viewer, ids);
      return {
        summary: `${trashedCount} of ${ids.length} messages are in Trash.`,
        structured: { trashed_count: trashedCount },
        containsUntrusted: false,
      };
    },
  }),
  defineTool({
    name: "mark_spam",
    title: "Mark messages as spam",
    description: "Mark messages as spam.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS },
    async execute({ message_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const messages = await usecases.markSpam(viewer, ids);
      return updatedOutcome(messages, ids.length);
    },
  }),
  defineTool({
    name: "mark_not_spam",
    title: "Mark messages as not spam",
    description: "Remove the spam mark from messages.",
    visibleWith: manageTool,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: { message_ids: MESSAGE_IDS },
    async execute({ message_ids }, { viewer, usecases }) {
      const ids = requireMessageIds(message_ids);
      const messages = await usecases.markNotSpam(viewer, ids);
      return updatedOutcome(messages, ids.length);
    },
  }),
];
