import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import { FetchStatus, markFetched } from "@mailcal/domain/entities/fetch-state";
import {
  createInboundMessage,
  MailStatus,
  type Message,
  MessageDirection,
  type MessageRecipient,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import {
  createSpamMark,
  SpamMarkedBy,
} from "@mailcal/domain/entities/spam-mark";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createApiKeyId,
  createAttachmentId,
  createDomainId,
  createMessageId,
  createTagId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import {
  AttachmentKind,
  createAttachment,
} from "@mailcal/domain/entities/attachment";
import { beforeEach, describe, expect, test } from "vitest";
import { createMessageRepository } from "./message-repository";
import {
  createMigratedDatabase,
  seedApiKey,
  seedDomain,
  SYSTEM_TAG_IDS,
} from "./test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const otherDomainId = createDomainId("dom-2");

function buildMessage(options: {
  readonly id: string;
  readonly occurredAt: string;
  readonly subject?: string;
  readonly threadId?: string;
  readonly domainId?: string;
  readonly from?: string;
  readonly rfcMessageId?: string | null;
  readonly references?: readonly string[];
}): Message {
  return createInboundMessage({
    id: createMessageId(options.id),
    domainId: createDomainId(options.domainId ?? domainId),
    threadId: createThreadId(options.threadId ?? options.id),
    rfcMessageId:
      options.rfcMessageId === undefined
        ? `${options.id}@other.com`
        : options.rfcMessageId,
    inReplyTo: null,
    references: options.references ?? [],
    subject: options.subject ?? `Subject ${options.id}`,
    fromAddress: createEmailAddress(options.from ?? "sender@other.com"),
    fromName: null,
    textBody: "body text",
    htmlBody: null,
    rawKey: `raw/${options.id}.eml`,
    rawSize: 100,
    occurredAt: options.occurredAt,
    createdAt: options.occurredAt,
    spamScore: null,
  });
}

function envelopeTo(address: string): readonly MessageRecipient[] {
  return [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(address),
      name: null,
      position: 0,
    },
  ];
}

const UNRESTRICTED = {
  allowedPatterns: null,
  mailPermissionFilter: null,
} as const;

describe("messageRepository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMessageRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: domainId, name: "example.com" });
    await seedDomain(db, { id: otherDomainId, name: "other-domain.com" });
    repository = createMessageRepository(db);
  });

  describe("insertWithRelations", () => {
    test("writes the message, recipients, attachments and tags atomically", async () => {
      const message = buildMessage({ id: "msg-1", occurredAt: NOW });
      const attachment = createAttachment({
        id: createAttachmentId("att-1"),
        messageId: message.id,
        fileName: "report.pdf",
        contentType: "application/pdf",
        size: 42,
        blobKey: "att/att-1/report.pdf",
        contentId: null,
        inline: false,
        createdAt: NOW,
      });

      await repository.insertWithRelations({
        message,
        recipients: envelopeTo("support@example.com"),
        attachments: [attachment],
        tagIds: [createTagId(SYSTEM_TAG_IDS.trash)],
        taggedAt: NOW,
      });

      const stored = await repository.findById(message.id);
      expect(stored?.subject).toBe("Subject msg-1");
      expect(
        (await repository.listRecipients([message.id])).get(message.id),
      ).toHaveLength(1);
      expect(
        (await repository.listAttachments([message.id])).get(message.id),
      ).toHaveLength(1);
      expect(
        (await repository.listTagIds([message.id])).get(message.id),
      ).toEqual([SYSTEM_TAG_IDS.trash]);
    });

    test("rolls the whole batch back when any statement fails", async () => {
      const message = buildMessage({ id: "msg-bad", occurredAt: NOW });
      await expect(
        repository.insertWithRelations({
          message,
          recipients: envelopeTo("support@example.com"),
          attachments: [],
          // A tag id that does not exist violates the foreign key.
          tagIds: [createTagId("tag-does-not-exist")],
          taggedAt: NOW,
        }),
      ).rejects.toThrow();
      expect(await repository.findById(message.id)).toBeNull();
    });

    test("round-trips the references array", async () => {
      const message = buildMessage({
        id: "msg-refs",
        occurredAt: NOW,
        references: ["a@x.com", "b@x.com"],
      });
      await repository.insertWithRelations({
        message,
        recipients: envelopeTo("support@example.com"),
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });
      expect((await repository.findById(message.id))?.references).toEqual([
        "a@x.com",
        "b@x.com",
      ]);
    });
  });

  describe("listing", () => {
    beforeEach(async () => {
      const rows: readonly (readonly [string, string, string])[] = [
        ["msg-1", "2026-08-23T01:00:00.000Z", "support@example.com"],
        ["msg-2", "2026-08-23T02:00:00.000Z", "billing@example.com"],
        ["msg-3", "2026-08-23T03:00:00.000Z", "support@example.com"],
        ["msg-4", "2026-08-23T04:00:00.000Z", "support-eu@example.com"],
      ];
      for (const [id, occurredAt, to] of rows) {
        await repository.insertWithRelations({
          message: buildMessage({ id, occurredAt }),
          recipients: envelopeTo(to),
          attachments: [],
          tagIds: [],
          taggedAt: occurredAt,
        });
      }
    });

    test("orders newest first and reports the total", async () => {
      const page = await repository.list(UNRESTRICTED, 10, null);
      expect(page.nodes.map((message) => message.id)).toEqual([
        "msg-4",
        "msg-3",
        "msg-2",
        "msg-1",
      ]);
      expect(page.totalCount).toBe(4);
      expect(page.nextCursor).toBeNull();
    });

    test("paginates across a page boundary without gaps or repeats", async () => {
      const first = await repository.list(UNRESTRICTED, 2, null);
      expect(first.nodes.map((message) => message.id)).toEqual([
        "msg-4",
        "msg-3",
      ]);
      expect(first.nextCursor).not.toBeNull();

      const second = await repository.list(UNRESTRICTED, 2, first.nextCursor);
      expect(second.nodes.map((message) => message.id)).toEqual([
        "msg-2",
        "msg-1",
      ]);
      expect(second.nextCursor).toBeNull();
    });

    test("treats a malformed cursor as the beginning", async () => {
      const page = await repository.list(UNRESTRICTED, 2, "!!!not-a-cursor!!!");
      expect(page.nodes.map((message) => message.id)).toEqual([
        "msg-4",
        "msg-3",
      ]);
    });

    test("filters by an exact address pattern", async () => {
      const page = await repository.list(
        {
          allowedPatterns: [createAddressPattern("support@example.com")],
          mailPermissionFilter: null,
        },
        10,
        null,
      );
      expect(page.nodes.map((message) => message.id)).toEqual([
        "msg-3",
        "msg-1",
      ]);
    });

    test("filters by a prefix wildcard pattern", async () => {
      const page = await repository.list(
        {
          allowedPatterns: [createAddressPattern("support-*@example.com")],
          mailPermissionFilter: null,
        },
        10,
        null,
      );
      expect(page.nodes.map((message) => message.id)).toEqual(["msg-4"]);
    });

    test("filters by a domain wildcard pattern", async () => {
      const page = await repository.list(
        {
          allowedPatterns: [createAddressPattern("*@example.com")],
          mailPermissionFilter: null,
        },
        10,
        null,
      );
      expect(page.totalCount).toBe(4);
    });

    test("an empty allowlist matches nothing", async () => {
      const page = await repository.list(
        { allowedPatterns: [], mailPermissionFilter: null },
        10,
        null,
      );
      expect(page.nodes).toEqual([]);
      expect(page.totalCount).toBe(0);
    });

    test("a match-all pattern imposes no restriction", async () => {
      const page = await repository.list(
        {
          allowedPatterns: [MATCH_ALL_ADDRESSES],
          mailPermissionFilter: null,
        },
        10,
        null,
      );
      expect(page.totalCount).toBe(4);
    });

    test("filters by domain, direction and toAddress", async () => {
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, domainIds: [otherDomainId] },
            10,
            null,
          )
        ).totalCount,
      ).toBe(0);
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, direction: MessageDirection.Outbound },
            10,
            null,
          )
        ).totalCount,
      ).toBe(0);
      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              toAddress: createEmailAddress("billing@example.com"),
            },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-2"]);
    });

    test("includes and excludes by tag", async () => {
      await repository.addTags(
        [createMessageId("msg-2")],
        [createTagId(SYSTEM_TAG_IDS.trash)],
        NOW,
      );
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, tagIds: [createTagId(SYSTEM_TAG_IDS.trash)] },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-2"]);
      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              excludeTagIds: [createTagId(SYSTEM_TAG_IDS.trash)],
            },
            10,
            null,
          )
        ).totalCount,
      ).toBe(3);
    });

    test("escapes LIKE metacharacters in a search term", async () => {
      await repository.insertWithRelations({
        message: buildMessage({
          id: "msg-pct",
          occurredAt: "2026-08-23T05:00:00.000Z",
          subject: "50% off",
        }),
        recipients: envelopeTo("support@example.com"),
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });

      // A literal `%` must match only the message containing it, not
      // everything the way an unescaped wildcard would.
      const page = await repository.list(
        { ...UNRESTRICTED, search: "50%" },
        10,
        null,
      );
      expect(page.nodes.map((message) => message.id)).toEqual(["msg-pct"]);
    });

    test("searches the text body, not only subject and snippet", async () => {
      await repository.insertWithRelations({
        message: {
          ...buildMessage({
            id: "msg-body",
            occurredAt: "2026-08-23T06:00:00.000Z",
            subject: "Boring subject",
          }),
          textBody: "the secret keyword xyzzy lives deep in the body",
        },
        recipients: envelopeTo("support@example.com"),
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });
      const page = await repository.list(
        { ...UNRESTRICTED, search: "xyzzy" },
        10,
        null,
      );
      expect(page.nodes.map((message) => message.id)).toEqual(["msg-body"]);
    });

    test("recipientAddress matches cc, toAddress does not", async () => {
      await repository.insertWithRelations({
        message: buildMessage({
          id: "msg-cc",
          occurredAt: "2026-08-23T07:00:00.000Z",
        }),
        recipients: [
          {
            kind: RecipientKind.Envelope,
            address: createEmailAddress("primary@example.com"),
            name: null,
            position: 0,
          },
          {
            kind: RecipientKind.Cc,
            address: createEmailAddress("copied@example.com"),
            name: null,
            position: 0,
          },
        ],
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });

      const copied = createEmailAddress("copied@example.com");
      // The with-cc filter finds it...
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, recipientAddress: copied },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-cc"]);
      // ...the without-cc filter does not.
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, toAddress: copied },
            10,
            null,
          )
        ).totalCount,
      ).toBe(0);
    });

    test("filters by attachment presence and kind", async () => {
      const withPdf = buildMessage({
        id: "msg-pdf",
        occurredAt: "2026-08-23T08:00:00.000Z",
      });
      await repository.insertWithRelations({
        message: withPdf,
        recipients: envelopeTo("support@example.com"),
        attachments: [
          createAttachment({
            id: createAttachmentId("att-pdf"),
            messageId: withPdf.id,
            fileName: "invoice.pdf",
            contentType: "application/pdf",
            size: 10,
            blobKey: "att/att-pdf/invoice.pdf",
            contentId: null,
            inline: false,
            createdAt: NOW,
          }),
        ],
        tagIds: [],
        taggedAt: NOW,
      });

      const withAttachment = await repository.list(
        { ...UNRESTRICTED, hasAttachment: true },
        10,
        null,
      );
      expect(withAttachment.nodes.map((message) => message.id)).toEqual([
        "msg-pdf",
      ]);

      const withoutAttachment = await repository.list(
        { ...UNRESTRICTED, hasAttachment: false },
        10,
        null,
      );
      expect(
        withoutAttachment.nodes.map((message) => message.id),
      ).not.toContain("msg-pdf");

      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, attachmentKinds: [AttachmentKind.Pdf] },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-pdf"]);
      expect(
        (
          await repository.list(
            { ...UNRESTRICTED, attachmentKinds: [AttachmentKind.Image] },
            10,
            null,
          )
        ).totalCount,
      ).toBe(0);
    });

    test("the stored kind round-trips through the repository", async () => {
      const message = buildMessage({
        id: "msg-kind",
        occurredAt: "2026-08-23T09:00:00.000Z",
      });
      await repository.insertWithRelations({
        message,
        recipients: envelopeTo("support@example.com"),
        attachments: [
          createAttachment({
            id: createAttachmentId("att-sheet"),
            messageId: message.id,
            fileName: "data.csv",
            contentType: "application/octet-stream",
            size: 5,
            blobKey: "att/att-sheet/data.csv",
            contentId: null,
            inline: false,
            createdAt: NOW,
          }),
        ],
        tagIds: [],
        taggedAt: NOW,
      });
      const stored = await repository.findAttachmentById(
        createAttachmentId("att-sheet"),
      );
      // Classified at receive time from the extension, despite the generic
      // content type, and persisted as such.
      expect(stored?.kind).toBe(AttachmentKind.Spreadsheet);
    });

    test("filters unread only", async () => {
      await repository.setRead([createMessageId("msg-1")], NOW, NOW);
      const page = await repository.list(
        { ...UNRESTRICTED, unreadOnly: true },
        10,
        null,
      );
      expect(page.nodes.map((message) => message.id)).not.toContain("msg-1");
    });
  });

  // mailPermissionFilter (user mailbox rules) listing tests live in
  // message-repository-permissions.test.ts, split out to keep this file
  // under the repository's line-count target.

  describe("fetch state", () => {
    const apiKeyId = createApiKeyId("key-a");
    const otherKeyId = createApiKeyId("key-b");

    beforeEach(async () => {
      await seedApiKey(db, { id: apiKeyId, keyHash: "hash-a" });
      await seedApiKey(db, { id: otherKeyId, keyHash: "hash-b" });
      for (const [id, occurredAt] of [
        ["msg-1", "2026-08-23T01:00:00.000Z"],
        ["msg-2", "2026-08-23T02:00:00.000Z"],
      ] as const) {
        await repository.insertWithRelations({
          message: buildMessage({ id, occurredAt }),
          recipients: envelopeTo("support@example.com"),
          attachments: [],
          tagIds: [],
          taggedAt: occurredAt,
        });
      }
    });

    test("NOT_FETCHED matches messages with no state row at all", async () => {
      const page = await repository.list(
        {
          ...UNRESTRICTED,
          fetchStatus: { apiKeyId, status: FetchStatus.NotFetched },
        },
        10,
        null,
      );
      expect(page.totalCount).toBe(2);
    });

    test("acknowledging moves a message between the two queues", async () => {
      await repository.saveFetchStates([
        markFetched(null, createMessageId("msg-2"), apiKeyId, NOW),
      ]);

      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              fetchStatus: { apiKeyId, status: FetchStatus.NotFetched },
            },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-1"]);

      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              fetchStatus: { apiKeyId, status: FetchStatus.Fetched },
            },
            10,
            null,
          )
        ).nodes.map((message) => message.id),
      ).toEqual(["msg-2"]);
    });

    test("two keys keep independent queues", async () => {
      await repository.saveFetchStates([
        markFetched(null, createMessageId("msg-2"), apiKeyId, NOW),
      ]);
      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              fetchStatus: {
                apiKeyId: otherKeyId,
                status: FetchStatus.NotFetched,
              },
            },
            10,
            null,
          )
        ).totalCount,
      ).toBe(2);
    });

    test("an explicit NOT_FETCHED row is treated as unfetched", async () => {
      await repository.saveFetchStates([
        {
          messageId: createMessageId("msg-2"),
          apiKeyId,
          status: FetchStatus.NotFetched,
          fetchedAt: null,
          updatedAt: NOW,
        },
      ]);
      expect(
        (
          await repository.list(
            {
              ...UNRESTRICTED,
              fetchStatus: { apiKeyId, status: FetchStatus.NotFetched },
            },
            10,
            null,
          )
        ).totalCount,
      ).toBe(2);
    });

    test("findFetchStates returns only this key's rows", async () => {
      await repository.saveFetchStates([
        markFetched(null, createMessageId("msg-1"), apiKeyId, NOW),
      ]);
      const mine = await repository.findFetchStates(apiKeyId, [
        createMessageId("msg-1"),
        createMessageId("msg-2"),
      ]);
      expect(mine.size).toBe(1);
      expect(mine.get("msg-1")?.status).toBe(FetchStatus.Fetched);

      const theirs = await repository.findFetchStates(otherKeyId, [
        createMessageId("msg-1"),
      ]);
      expect(theirs.size).toBe(0);
    });
  });

  describe("threading and deletion", () => {
    test("resolves a thread from the newest matching reference", async () => {
      await repository.insertWithRelations({
        message: buildMessage({
          id: "msg-old",
          occurredAt: "2026-08-23T01:00:00.000Z",
          threadId: "thr-old",
        }),
        recipients: envelopeTo("support@example.com"),
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });
      await repository.insertWithRelations({
        message: buildMessage({
          id: "msg-new",
          occurredAt: "2026-08-23T02:00:00.000Z",
          threadId: "thr-new",
        }),
        recipients: envelopeTo("support@example.com"),
        attachments: [],
        tagIds: [],
        taggedAt: NOW,
      });

      expect(
        await repository.findThreadIdByReferences([
          "msg-old@other.com",
          "msg-new@other.com",
        ]),
      ).toBe("thr-new");
      expect(await repository.findThreadIdByReferences([])).toBeNull();
      expect(
        await repository.findThreadIdByReferences(["unknown@x.com"]),
      ).toBeNull();
    });

    test("deleting a message cascades its relations", async () => {
      const message = buildMessage({ id: "msg-1", occurredAt: NOW });
      await repository.insertWithRelations({
        message,
        recipients: envelopeTo("support@example.com"),
        attachments: [
          createAttachment({
            id: createAttachmentId("att-1"),
            messageId: message.id,
            fileName: "f.pdf",
            contentType: "application/pdf",
            size: 1,
            blobKey: "att/att-1/f.pdf",
            contentId: null,
            inline: false,
            createdAt: NOW,
          }),
        ],
        tagIds: [createTagId(SYSTEM_TAG_IDS.trash)],
        taggedAt: NOW,
      });

      expect(await repository.delete([message.id])).toBe(1);
      expect(await repository.findById(message.id)).toBeNull();
      expect(
        await repository.findAttachmentById(createAttachmentId("att-1")),
      ).toBeNull();
      const recipients = await db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM message_recipients",
      );
      expect(recipients[0]?.count).toBe(0);
    });

    test("findByIds preserves the requested order and drops unknown ids", async () => {
      for (const [id, occurredAt] of [
        ["msg-1", "2026-08-23T01:00:00.000Z"],
        ["msg-2", "2026-08-23T02:00:00.000Z"],
      ] as const) {
        await repository.insertWithRelations({
          message: buildMessage({ id, occurredAt }),
          recipients: envelopeTo("support@example.com"),
          attachments: [],
          tagIds: [],
          taggedAt: occurredAt,
        });
      }
      const found = await repository.findByIds([
        createMessageId("msg-2"),
        createMessageId("nope"),
        createMessageId("msg-1"),
      ]);
      expect(found.map((message) => message.id)).toEqual(["msg-2", "msg-1"]);
    });
  });
});

describe("spam marks and new filters", () => {
  let db2: SqlDatabase;
  let repo: ReturnType<typeof createMessageRepository>;

  beforeEach(async () => {
    db2 = await createMigratedDatabase();
    await seedDomain(db2, { id: domainId, name: "example.com" });
    repo = createMessageRepository(db2);
  });

  async function insertPlain(id: string, occurredAt: string): Promise<void> {
    await repo.insertWithRelations({
      message: buildMessage({ id, occurredAt }),
      recipients: envelopeTo("support@example.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
  }

  test("a spam mark written in the insert batch round-trips and filters", async () => {
    const message = buildMessage({ id: "msg-spam", occurredAt: NOW });
    await repo.insertWithRelations({
      message,
      recipients: envelopeTo("support@example.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
      spam: createSpamMark({
        messageId: message.id,
        score: 0.9,
        markedBy: SpamMarkedBy.System,
        markedAt: NOW,
      }),
    });
    await insertPlain("msg-clean", "2026-08-23T01:00:00.000Z");

    const marks = await repo.listSpamMarks([
      createMessageId("msg-spam"),
      createMessageId("msg-clean"),
    ]);
    expect(marks.get("msg-spam")?.score).toBe(0.9);
    expect(marks.has("msg-clean")).toBe(false);

    const onlySpam = await repo.list({ ...UNRESTRICTED, spam: true }, 10, null);
    expect(onlySpam.nodes.map((m) => m.id)).toEqual(["msg-spam"]);
    const noSpam = await repo.list({ ...UNRESTRICTED, spam: false }, 10, null);
    expect(noSpam.nodes.map((m) => m.id)).toEqual(["msg-clean"]);
  });

  test("marking and clearing by hand", async () => {
    await insertPlain("msg-1", NOW);
    await repo.setSpamMarks([
      createSpamMark({
        messageId: createMessageId("msg-1"),
        score: null,
        markedBy: SpamMarkedBy.User,
        markedAt: NOW,
      }),
    ]);
    expect(
      (await repo.listSpamMarks([createMessageId("msg-1")])).get("msg-1")
        ?.markedBy,
    ).toBe(SpamMarkedBy.User);
    await repo.clearSpamMarks([createMessageId("msg-1")]);
    expect((await repo.listSpamMarks([createMessageId("msg-1")])).size).toBe(0);
  });

  test("status, mailing-list and list-id filters hit the new columns", async () => {
    const draft = {
      ...buildMessage({ id: "msg-draft", occurredAt: NOW }),
      status: MailStatus.Draft,
    };
    await repo.insertWithRelations({
      message: draft,
      recipients: [],
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });
    const listMail = {
      ...buildMessage({
        id: "msg-list",
        occurredAt: "2026-08-23T01:00:00.000Z",
      }),
      listId: "dev.lists.other.com",
      isMailingList: true,
    };
    await repo.insertWithRelations({
      message: listMail,
      recipients: envelopeTo("support@example.com"),
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });

    expect(
      (
        await repo.list(
          { ...UNRESTRICTED, statuses: [MailStatus.Draft] },
          10,
          null,
        )
      ).nodes.map((m) => m.id),
    ).toEqual(["msg-draft"]);
    expect(
      (
        await repo.list({ ...UNRESTRICTED, mailingList: true }, 10, null)
      ).nodes.map((m) => m.id),
    ).toEqual(["msg-list"]);
    expect(
      (
        await repo.list(
          { ...UNRESTRICTED, listId: "dev.lists.other.com" },
          10,
          null,
        )
      ).nodes.map((m) => m.id),
    ).toEqual(["msg-list"]);
    // Round-trip of the stored fields.
    const stored = await repo.findById(createMessageId("msg-list"));
    expect(stored?.listId).toBe("dev.lists.other.com");
    expect(stored?.isMailingList).toBe(true);
    expect(stored?.status).toBe(MailStatus.Received);
  });
});
