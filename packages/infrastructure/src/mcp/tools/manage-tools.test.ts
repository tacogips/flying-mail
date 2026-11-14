import { Capability } from "@flying-mail/domain/entities/api-key";
import { SpamMarkedBy } from "@flying-mail/domain/entities/spam-mark";
import { SystemTagSlug } from "@flying-mail/domain/entities/tag";
import { createTagId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { MCP_MAX_IDS } from "../constants";
import { createMcpTestHarness, type McpTestHarness } from "../mcp-test-support";
import { MANAGE_TOOLS } from "./manage-tools";

const TOOL_NAMES = [
  "mark_read",
  "mark_unread",
  "tag_messages",
  "untag_messages",
  "move_to_trash",
  "mark_spam",
  "mark_not_spam",
] as const;

describe("MANAGE_TOOLS", () => {
  let harness: McpTestHarness;
  let manageViewer: Awaited<ReturnType<McpTestHarness["issueKey"]>>["viewer"];

  beforeEach(async () => {
    harness = await createMcpTestHarness();
    const key = await harness.issueKey([
      {
        capability: Capability.MailManage,
        domainId: harness.domainId,
        addressPattern: "support@example.com",
      },
    ]);
    manageViewer = key.viewer;
    await harness.usecases.ensureSystemTags();
  });

  test("exports exactly the ordered MAIL_MANAGE tools and annotations", () => {
    expect(MANAGE_TOOLS.map(({ name }) => name)).toEqual(TOOL_NAMES);
    expect(
      MANAGE_TOOLS.every((tool) =>
        tool.visibleWith.includes(Capability.MailManage),
      ),
    ).toBe(true);
    expect(
      MANAGE_TOOLS.filter(({ annotations }) => annotations.destructiveHint).map(
        ({ name }) => name,
      ),
    ).toEqual(["move_to_trash"]);
  });

  test("marks messages read and unread and returns authorized ids", async () => {
    const message = await harness.seedMessage({
      id: "manage-read-1",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["support@example.com"],
      subject: "Read state",
    });

    const read = await harness.callTool(manageViewer, "mark_read", {
      message_ids: [message.id],
    });
    expect(read.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(
      harness.fake.messageStores.messages.get(message.id)?.readAt,
    ).not.toBe(null);

    const unread = await harness.callTool(manageViewer, "mark_unread", {
      message_ids: [message.id],
    });
    expect(unread.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(harness.fake.messageStores.messages.get(message.id)?.readAt).toBe(
      null,
    );
  });

  test("applies and removes tags and reports unknown tags as NOT_FOUND", async () => {
    const message = await harness.seedMessage({
      id: "manage-tag-1",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["support@example.com"],
      subject: "Tags",
    });
    const starred = await harness.deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Starred,
    );
    expect(starred).not.toBeNull();
    const tagId = starred?.id ?? createTagId("tag-starred");

    const tagged = await harness.callTool(manageViewer, "tag_messages", {
      message_ids: [message.id],
      tag_ids: [tagId],
    });
    expect(tagged.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(
      harness.fake.messageStores.messageTags.get(message.id)?.has(tagId),
    ).toBe(true);

    const untagged = await harness.callTool(manageViewer, "untag_messages", {
      message_ids: [message.id],
      tag_ids: [tagId],
    });
    expect(untagged.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(
      harness.fake.messageStores.messageTags.get(message.id)?.has(tagId),
    ).toBe(false);

    const missing = await harness.callTool(manageViewer, "tag_messages", {
      message_ids: [message.id],
      tag_ids: ["tag-does-not-exist"],
    });
    expect(missing.body?.["result"]).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "NOT_FOUND" } },
    });
  });

  test("moves messages to Trash repeatedly without purging them", async () => {
    const message = await harness.seedMessage({
      id: "manage-trash-1",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["support@example.com"],
      subject: "Trash",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await harness.callTool(manageViewer, "move_to_trash", {
        message_ids: [message.id],
      });
      expect(result.body?.["result"]).toMatchObject({
        structuredContent: { trashed_count: 1 },
        isError: false,
      });
      expect(
        await harness.deps.messageRepository.findById(message.id),
      ).not.toBeNull();
    }
    const trash = await harness.deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    expect(trash).not.toBeNull();
    expect(
      harness.fake.messageStores.messageTags
        .get(message.id)
        ?.has(trash?.id ?? ""),
    ).toBe(true);
  });

  test("silently skips messages outside the key address scope", async () => {
    const message = await harness.seedMessage({
      id: "manage-trash-out-of-scope",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["other@example.com"],
      subject: "Out of scope",
    });
    const result = await harness.callTool(manageViewer, "move_to_trash", {
      message_ids: [message.id],
    });

    expect(result.body?.["result"]).toMatchObject({
      structuredContent: { trashed_count: 0 },
      isError: false,
    });
    expect(harness.fake.messageStores.messageTags.get(message.id)?.size).toBe(
      0,
    );
  });

  test("marks spam and then clears the spam mark", async () => {
    const message = await harness.seedMessage({
      id: "manage-spam-1",
      direction: "INBOUND",
      from: "sender@example.net",
      to: ["support@example.com"],
      subject: "Spam state",
    });

    const spam = await harness.callTool(manageViewer, "mark_spam", {
      message_ids: [message.id],
    });
    expect(spam.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(harness.fake.messageStores.spamMarks.get(message.id)?.markedBy).toBe(
      SpamMarkedBy.User,
    );

    const notSpam = await harness.callTool(manageViewer, "mark_not_spam", {
      message_ids: [message.id],
    });
    expect(notSpam.body?.["result"]).toMatchObject({
      structuredContent: { updated_ids: [message.id] },
      isError: false,
    });
    expect(harness.fake.messageStores.spamMarks.has(message.id)).toBe(false);
  });

  test("rejects empty and oversized message id arrays", async () => {
    const empty = await harness.callTool(manageViewer, "mark_read", {
      message_ids: [],
    });
    expect(empty.body?.["result"]).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "BAD_USER_INPUT", field: "message_ids" },
      },
    });

    const oversized = await harness.callTool(manageViewer, "mark_read", {
      message_ids: Array.from(
        { length: MCP_MAX_IDS + 1 },
        (_, index) => `message-${index}`,
      ),
    });
    expect(oversized.body?.["result"]).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "BAD_USER_INPUT" } },
    });
  });

  test("hides tools from MAIL_READ-only keys and rejects their calls", async () => {
    const { viewer } = await harness.issueKey([
      {
        capability: Capability.MailRead,
        domainId: harness.domainId,
        addressPattern: "*",
      },
    ]);

    const visible = await harness.listTools(viewer);
    expect(visible).not.toEqual(expect.arrayContaining([...TOOL_NAMES]));
    for (const name of TOOL_NAMES) expect(visible).not.toContain(name);

    const hiddenCall = await harness.callTool(viewer, "mark_read", {
      message_ids: ["manage-hidden-1"],
    });
    expect(hiddenCall.body?.["error"]).toMatchObject({ code: -32602 });
  });
});
