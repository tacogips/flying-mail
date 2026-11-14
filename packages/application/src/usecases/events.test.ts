import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { MessageEventKind } from "@mailcal/domain/entities/message-event";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { NotFoundError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  mailboxAgentViewer,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import {
  createCreateMessageEventUseCase,
  createDeleteMessageEventUseCase,
  createListMessageEventsUseCase,
  createUpdateMessageEventUseCase,
} from "./events";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const messageId = createMessageId("msg-1");

function seedMessage(fake: FakeDependencies, to: string): void {
  const message = createInboundMessage({
    id: messageId,
    domainId,
    threadId: createThreadId("thr-1"),
    rfcMessageId: "m1@other.com",
    inReplyTo: null,
    references: [],
    subject: "Please reply by 10/1",
    fromAddress: createEmailAddress("sender@other.com"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
  });
  fake.messageStores.messages.set(message.id, message);
  fake.messageStores.recipients.set(message.id, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(to),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(message.id, new Set());
}

describe("message events", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
    seedMessage(fake, "support@example.com");
  });

  test('registers "limit, 10/1 reply" as a deadline on the mail', async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    const event = await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.Deadline,
      dueAt: "2026-10-01T00:00:00.000Z",
      title: "reply",
    });
    expect(event.messageId).toBe(messageId);
    expect(fake.eventStores.events.get(event.id)?.title).toBe("reply");
  });

  test("a message can carry multiple events", async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.Deadline,
      dueAt: "2026-10-01T00:00:00.000Z",
      title: "reply",
    });
    await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.FollowUp,
      title: "check invoice",
    });
    expect(fake.eventStores.events.size).toBe(2);
  });

  test("update completes and reopens; delete removes", async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    const update = createUpdateMessageEventUseCase(fake.deps);
    const remove = createDeleteMessageEventUseCase(fake.deps);
    const event = await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.Reminder,
      dueAt: "2026-09-01T00:00:00.000Z",
      title: "ping",
    });
    const done = await update(adminViewer(), event.id, { completed: true });
    expect(done.completedAt).not.toBeNull();
    expect(await remove(adminViewer(), event.id)).toBe(true);
    expect(fake.eventStores.events.size).toBe(0);
  });

  test("agenda listing orders by due date and hides completed by default", async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    const update = createUpdateMessageEventUseCase(fake.deps);
    const listEvents = createListMessageEventsUseCase(fake.deps);
    const late = await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.Deadline,
      dueAt: "2026-12-01T00:00:00.000Z",
      title: "late",
    });
    const soon = await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.Deadline,
      dueAt: "2026-09-01T00:00:00.000Z",
      title: "soon",
    });
    const finished = await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.FollowUp,
      dueAt: "2026-08-30T00:00:00.000Z",
      title: "done already",
    });
    await update(adminViewer(), finished.id, { completed: true });

    const open = await listEvents(adminViewer(), {});
    expect(open.map((event) => event.id)).toEqual([soon.id, late.id]);

    const bounded = await listEvents(adminViewer(), {
      dueBefore: "2026-10-01T00:00:00.000Z",
    });
    expect(bounded.map((event) => event.id)).toEqual([soon.id]);

    const all = await listEvents(adminViewer(), { includeCompleted: true });
    expect(all).toHaveLength(3);
  });

  test("a key scoped to another mailbox can neither write nor list the event", async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    const outOfScope = mailboxAgentViewer(domainId, "other@example.com");
    await expect(
      create(outOfScope, {
        messageId,
        kind: MessageEventKind.FollowUp,
        title: "sneaky",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.FollowUp,
      title: "internal",
    });
    const listEvents = createListMessageEventsUseCase(fake.deps);
    expect(await listEvents(outOfScope, {})).toEqual([]);
    expect(
      await listEvents(mailboxAgentViewer(domainId, "support@example.com"), {}),
    ).toHaveLength(1);
  });

  test("a MEMBER user with no matching ALLOW rule can neither write nor list the event", async () => {
    const create = createCreateMessageEventUseCase(fake.deps);
    await expect(
      create(memberViewer(), {
        messageId,
        kind: MessageEventKind.FollowUp,
        title: "sneaky",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.FollowUp,
      title: "internal",
    });
    const listEvents = createListMessageEventsUseCase(fake.deps);
    expect(await listEvents(memberViewer(), {})).toEqual([]);
  });

  test("a VIEWER user can never write an event, even with a matching ALLOW rule", async () => {
    const userId = createUserId("usr-viewer-1");
    const permissions = buildMailPermissions(userId, [
      {
        effect: "ALLOW",
        domainId,
        addressPattern: "support@example.com",
      },
    ]);
    const viewer = viewerViewer("usr-viewer-1", permissions);
    const create = createCreateMessageEventUseCase(fake.deps);
    await expect(
      create(viewer, {
        messageId,
        kind: MessageEventKind.FollowUp,
        title: "sneaky",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A VIEWER can still read and list the mail's existing events, though.
    await create(adminViewer(), {
      messageId,
      kind: MessageEventKind.FollowUp,
      title: "internal",
    });
    const listEvents = createListMessageEventsUseCase(fake.deps);
    expect(await listEvents(viewer, {})).toHaveLength(1);
  });
});
