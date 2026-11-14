import { Capability } from "@mailcal/domain/entities/api-key";
import { createAttachment } from "@mailcal/domain/entities/attachment";
import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createFileLinkId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { BadUserInputError, ForbiddenError, NotFoundError } from "../errors";
import {
  CALENDAR_ID,
  type CalendarFixture,
  calendarKeyViewer,
  mailOnlyKeyViewer,
  NOW as CALENDAR_NOW,
  seedCalendarFixture,
} from "../test-support/calendar-fixtures";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  mailboxAgentViewer,
} from "../test-support/viewer-fixtures";
import {
  createCreateAttachmentLinkUseCase,
  createCreateRawMessageLinkUseCase,
  createListFileLinksUseCase,
  createResolveFileLinkUseCase,
  createRevokeFileLinkUseCase,
  MIN_FILE_LINK_TTL_SECONDS,
} from "./file-links";
import { createUseCases, type UseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const messageId = createMessageId("msg-1");
const attachmentId = createAttachmentId("att-1");

async function seed(fake: FakeDependencies): Promise<void> {
  const message = createInboundMessage({
    id: messageId,
    domainId,
    threadId: createThreadId("thr-1"),
    rfcMessageId: "m1@other.com",
    inReplyTo: null,
    references: [],
    subject: "With attachment",
    fromAddress: createEmailAddress("sender@other.com"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: `raw/${messageId}.eml`,
    rawSize: 100,
    occurredAt: NOW,
    createdAt: NOW,
    spamScore: null,
  });
  const attachment = createAttachment({
    id: attachmentId,
    messageId,
    fileName: "report.pdf",
    contentType: "application/pdf",
    size: 3,
    blobKey: `att/${attachmentId}/report.pdf`,
    contentId: null,
    inline: false,
    createdAt: NOW,
  });
  fake.messageStores.messages.set(message.id, message);
  fake.messageStores.recipients.set(message.id, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("support@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.attachments.set(attachment.id, attachment);
  fake.messageStores.messageTags.set(message.id, new Set());
  await fake.deps.blobs.put(attachment.blobKey, new Uint8Array([1, 2, 3]), {
    contentType: "application/pdf",
  });
  await fake.deps.blobs.put(
    `raw/${messageId}.eml`,
    new TextEncoder().encode("raw source"),
  );
}

describe("createAttachmentLink", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seed(fake);
  });

  test("mints an absolute url and stores only the token hash", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, 3);

    expect(created.url).toBe(`https://mail.example.com/files/${created.token}`);
    expect(created.link.maxDownloads).toBe(3);
    expect(created.link.expiresAt).toBe("2026-08-23T00:15:00.000Z");

    const stored = fake.stores.fileLinks.get(created.link.id);
    expect(stored?.tokenHash).toBe(`hash(${created.token})`);
    const nonHashValues = Object.entries(stored ?? {})
      .filter(([key]) => key !== "tokenHash")
      .map(([, value]) => value);
    expect(nonHashValues).not.toContain(created.token);
  });

  test("returns a relative url when no public origin is configured", async () => {
    const local = createFakeDependencies({
      now: NOW,
      instanceConfig: { publicOrigin: null },
    });
    await seed(local);
    const mint = createCreateAttachmentLinkUseCase(local.deps);
    const created = await mint(adminViewer(), attachmentId);
    expect(created.url).toBe(`/files/${created.token}`);
  });

  test("clamps the ttl to the configured bounds", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const tooShort = await mint(adminViewer(), attachmentId, 1);
    expect(tooShort.link.expiresAt).toBe(
      new Date(
        new Date(NOW).getTime() + MIN_FILE_LINK_TTL_SECONDS * 1000,
      ).toISOString(),
    );

    const tooLong = await mint(adminViewer(), attachmentId, 99999999);
    expect(tooLong.link.expiresAt).toBe(
      new Date(
        new Date(NOW).getTime() +
          fake.deps.instanceConfig.fileLinkMaxTtlSeconds * 1000,
      ).toISOString(),
    );
  });

  test.each([0, -1, 1.5])("rejects maxDownloads=%s", async (maxDownloads) => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    await expect(
      mint(adminViewer(), attachmentId, 900, maxDownloads),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects an unknown attachment", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    await expect(
      mint(adminViewer(), createAttachmentId("nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("requires read access to the owning message", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const viewer = mailboxAgentViewer(domainId, "billing@example.com");
    await expect(mint(viewer, attachmentId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("requires the FILE_LINK capability, not merely read access", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const readOnly = apiKeyViewer([
      {
        capability: Capability.MailRead,
        domainId,
        addressPattern: "support@example.com",
      },
    ]);
    await expect(mint(readOnly, attachmentId)).rejects.toThrow();
  });

  test("a properly scoped agent may mint", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    await expect(mint(viewer, attachmentId)).resolves.toMatchObject({
      link: { attachmentId },
    });
  });
});

describe("resolveFileLink", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seed(fake);
  });

  test("serves the attachment body without any credential", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, null);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    const download = await resolve(created.token);
    expect(download?.fileName).toBe("report.pdf");
    expect(download?.contentType).toBe("application/pdf");
    expect(await new Response(download?.blob.body).text()).toHaveLength(3);
  });

  test("serves the raw message source", async () => {
    const mint = createCreateRawMessageLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), messageId, 900, null);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    const download = await resolve(created.token);
    expect(download?.fileName).toBe(`${messageId}.eml`);
    expect(download?.contentType).toBe("message/rfc822");
  });

  test("counts the download before streaming", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, 2);
    const resolve = createResolveFileLinkUseCase(fake.deps);

    await resolve(created.token);
    expect(fake.stores.fileLinks.get(created.link.id)?.downloadCount).toBe(1);
    await resolve(created.token);
    expect(fake.stores.fileLinks.get(created.link.id)?.downloadCount).toBe(2);
  });

  test.each([
    ["an unknown token", "unknown-token"],
    ["an empty token", ""],
  ])("returns null for %s", async (_label, token) => {
    const resolve = createResolveFileLinkUseCase(fake.deps);
    await expect(resolve(token)).resolves.toBeNull();
  });

  test("returns null once exhausted", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, 1);
    const resolve = createResolveFileLinkUseCase(fake.deps);
    await expect(resolve(created.token)).resolves.not.toBeNull();
    await expect(resolve(created.token)).resolves.toBeNull();
  });

  test("returns null once expired", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 60, null);
    fake.clock.advanceSeconds(61);
    const resolve = createResolveFileLinkUseCase(fake.deps);
    await expect(resolve(created.token)).resolves.toBeNull();
  });

  test("returns null once revoked", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, null);
    const revoke = createRevokeFileLinkUseCase(fake.deps);
    await revoke(adminViewer(), created.link.id);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    await expect(resolve(created.token)).resolves.toBeNull();
  });

  test("returns null when the blob is missing", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, null);
    await fake.deps.blobs.delete(`att/${attachmentId}/report.pdf`);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    await expect(resolve(created.token)).resolves.toBeNull();
  });

  test("concurrent downloads cannot exceed maxDownloads", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seed(fake);
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(adminViewer(), attachmentId, 900, 1);
    const resolve = createResolveFileLinkUseCase(fake.deps);
    // Both requests race the same one-download link; the atomic consume
    // must admit exactly one of them.
    const results = await Promise.all([
      resolve(created.token),
      resolve(created.token),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  test("returns null rather than throwing on a repository failure", async () => {
    const broken = createFakeDependencies({ now: NOW });
    const resolve = createResolveFileLinkUseCase({
      ...broken.deps,
      fileLinkRepository: {
        ...broken.deps.fileLinkRepository,
        consumeByTokenHash: async () => {
          throw new Error("storage down");
        },
      },
    });
    await expect(resolve("any-token")).resolves.toBeNull();
  });
});

describe("revokeFileLink and listFileLinks", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seed(fake);
  });

  test("lists the links minted for a message", async () => {
    const mint = createCreateRawMessageLinkUseCase(fake.deps);
    await mint(adminViewer(), messageId, 900, null);
    const list = createListFileLinksUseCase(fake.deps);
    expect(await list(adminViewer(), messageId)).toHaveLength(1);
  });

  test("lists nothing for a message the viewer cannot read", async () => {
    const mint = createCreateRawMessageLinkUseCase(fake.deps);
    await mint(adminViewer(), messageId, 900, null);
    const list = createListFileLinksUseCase(fake.deps);
    const viewer = mailboxAgentViewer(domainId, "billing@example.com");
    expect(await list(viewer, messageId)).toEqual([]);
  });

  test("revoking an unknown link is not found", async () => {
    const revoke = createRevokeFileLinkUseCase(fake.deps);
    await expect(
      revoke(adminViewer(), createFileLinkId("nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/** File links on an event attachment. An event attachment carries no
 * `messageId` -- it is a staged upload an event claimed -- so it authorizes
 * through the claiming event rather than through a message, mirroring the
 * event branch of `GET /api/attachments/:id`. */
describe("file links on an event attachment", () => {
  const eventAttachmentId = createAttachmentId("att-event-1");
  const orphanAttachmentId = createAttachmentId("att-orphan-1");

  let fake: FakeDependencies;
  let usecases: UseCases;
  let fixture: CalendarFixture;

  async function stageUpload(id: typeof eventAttachmentId): Promise<void> {
    const attachment = createAttachment({
      id,
      messageId: null,
      fileName: "agenda.pdf",
      contentType: "application/pdf",
      size: 3,
      blobKey: `att/${id}/agenda.pdf`,
      contentId: null,
      inline: false,
      createdAt: CALENDAR_NOW,
    });
    fake.messageStores.attachments.set(attachment.id, attachment);
    await fake.deps.blobs.put(attachment.blobKey, new Uint8Array([1, 2, 3]), {
      contentType: "application/pdf",
    });
  }

  beforeEach(async () => {
    fake = createFakeDependencies({ now: CALENDAR_NOW });
    usecases = createUseCases(fake.deps);
    fixture = await seedCalendarFixture(fake);
    const event = await usecases.createCalendarEvent(fixture.ownerViewer, {
      calendarId: CALENDAR_ID,
      title: "Planning",
      time: {
        allDay: false,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-09-01T01:00:00.000Z",
        timeZone: "UTC",
      },
    });
    await stageUpload(eventAttachmentId);
    await stageUpload(orphanAttachmentId);
    await usecases.attachFileToEvent(
      fixture.ownerViewer,
      event.id,
      eventAttachmentId,
    );
  });

  test("the event owner may mint, and the token serves the bytes", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(fixture.ownerViewer, eventAttachmentId, 900, 1);
    expect(created.link.attachmentId).toBe(eventAttachmentId);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    const download = await resolve(created.token);
    expect(download?.fileName).toBe("agenda.pdf");
    expect(await new Response(download?.blob.body).text()).toHaveLength(3);
  });

  test("a viewer that cannot read the claiming event is told it is absent", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    await expect(
      mint(fixture.otherViewer, eventAttachmentId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a mail-only key cannot reach an event attachment", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    await expect(
      mint(mailOnlyKeyViewer(), eventAttachmentId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("reading the event is not enough without FILE_LINK", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const readOnly = calendarKeyViewer([Capability.CalendarRead]);
    await expect(mint(readOnly, eventAttachmentId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("a calendar key holding FILE_LINK may mint", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const viewer = calendarKeyViewer([
      Capability.CalendarRead,
      Capability.FileLink,
    ]);
    await expect(mint(viewer, eventAttachmentId)).resolves.toMatchObject({
      link: { attachmentId: eventAttachmentId },
    });
  });

  test("an unclaimed staged upload is still not linkable", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    await expect(
      mint(fixture.adminViewer, orphanAttachmentId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("the link can be revoked through the same event authorization", async () => {
    const mint = createCreateAttachmentLinkUseCase(fake.deps);
    const created = await mint(fixture.ownerViewer, eventAttachmentId, 900, 1);

    const revoke = createRevokeFileLinkUseCase(fake.deps);
    await expect(
      revoke(fixture.otherViewer, created.link.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await revoke(fixture.ownerViewer, created.link.id)).toBe(true);

    const resolve = createResolveFileLinkUseCase(fake.deps);
    expect(await resolve(created.token)).toBeNull();
  });
});
