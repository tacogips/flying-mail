import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  Capability,
  createApiKey,
  createApiKeyScope,
  revokeApiKey,
} from "@mailcal/domain/entities/api-key";
import { createAttachment } from "@mailcal/domain/entities/attachment";
import {
  createAttachmentFileLink,
  consumeFileLink,
  createRawMessageFileLink,
  FileLinkTarget,
  revokeFileLink,
} from "@mailcal/domain/entities/file-link";
import {
  createMailDomain,
  DomainStatus,
  setMailDomainStatus,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createInboundMessage,
  createOutboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { createSession } from "@mailcal/domain/entities/session";
import {
  createUserTag,
  renameTag,
  SystemTagSlug,
  TagKind,
} from "@mailcal/domain/entities/tag";
import {
  createEmailAuthChallenge,
  consumeEmailAuthChallenge,
} from "@mailcal/domain/entities/email-auth-challenge";
import {
  createUser,
  deactivateUser,
  UserRole,
} from "@mailcal/domain/entities/user";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "@mailcal/domain/value-objects/address-pattern";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createAttachmentId,
  createDomainId,
  createEmailAuthChallengeId,
  createFileLinkId,
  createMessageId,
  createSessionId,
  createTagId,
  createThreadId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createApiKeyRepository } from "./api-key-repository";
import {
  createEmailAuthChallengeRepository,
  createSessionRepository,
  createUserRepository,
} from "./auth-repository";
import { createFileLinkRepository } from "./file-link-repository";
import { createMailDomainRepository } from "./mail-domain-repository";
import { createMessageRepository } from "./message-repository";
import { createTagRepository } from "./tag-repository";
import { createMigratedDatabase, SYSTEM_TAG_IDS } from "./test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

describe("mailDomainRepository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMailDomainRepository>;

  const domain = () =>
    createMailDomain({
      id: domainId,
      name: createDomainName("example.com"),
      catchAll: true,
      verificationToken: "tok-abc",
      createdAt: NOW,
    });

  beforeEach(async () => {
    db = await createMigratedDatabase();
    repository = createMailDomainRepository(db);
  });

  test("round-trips every field", async () => {
    await repository.save(domain());
    const stored = await repository.findById(domainId);
    expect(stored).toEqual(domain());
  });

  test("finds by name", async () => {
    await repository.save(domain());
    expect(
      (await repository.findByName(createDomainName("example.com")))?.id,
    ).toBe(domainId);
    expect(
      await repository.findByName(createDomainName("unknown.com")),
    ).toBeNull();
  });

  test("save is an upsert that preserves createdAt", async () => {
    await repository.save(domain());
    const verified = verifyMailDomain(domain(), "2026-08-23T01:00:00.000Z");
    await repository.save(
      setMailDomainStatus(
        verified,
        DomainStatus.Disabled,
        "2026-08-23T02:00:00.000Z",
      ),
    );

    const stored = await repository.findById(domainId);
    expect(stored?.status).toBe(DomainStatus.Disabled);
    expect(stored?.verifiedAt).toBe("2026-08-23T01:00:00.000Z");
    expect(stored?.createdAt).toBe(NOW);
  });

  test("round-trips the catchAll boolean", async () => {
    await repository.save({ ...domain(), catchAll: false });
    expect((await repository.findById(domainId))?.catchAll).toBe(false);
  });

  test("lists alphabetically", async () => {
    await repository.save(domain());
    await repository.save({
      ...domain(),
      id: createDomainId("dom-2"),
      name: createDomainName("aaa.com"),
    });
    expect((await repository.list()).map((entry) => entry.name)).toEqual([
      "aaa.com",
      "example.com",
    ]);
  });

  test("counts messages and detects known local parts", async () => {
    await repository.save(verifyMailDomain(domain(), NOW));
    expect(await repository.countMessages(domainId)).toBe(0);
    expect(
      await repository.hasKnownLocalPart(domainId, "support@example.com"),
    ).toBe(false);

    const messages = createMessageRepository(db);
    const message = createInboundMessage({
      id: createMessageId("msg-1"),
      domainId,
      threadId: createThreadId("thr-1"),
      rfcMessageId: "m1@other.com",
      inReplyTo: null,
      references: [],
      subject: "Hi",
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
    await messages.insertWithRelations({
      message,
      recipients: [
        {
          kind: RecipientKind.Envelope,
          address: createEmailAddress("support@example.com"),
          name: null,
          position: 0,
        },
      ],
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });

    expect(await repository.countMessages(domainId)).toBe(1);
    expect(
      await repository.hasKnownLocalPart(domainId, "support@example.com"),
    ).toBe(true);
    expect(
      await repository.hasKnownLocalPart(domainId, "other@example.com"),
    ).toBe(false);
  });

  test("sending from an address establishes it as a known local part", async () => {
    // The non-catch-all bootstrap: with only received-mail as evidence, a
    // fresh non-catch-all domain could never accept its first message.
    await repository.save(verifyMailDomain(domain(), NOW));
    expect(
      await repository.hasKnownLocalPart(domainId, "hello@example.com"),
    ).toBe(false);

    const messages = createMessageRepository(db);
    const outbound = createOutboundMessage({
      id: createMessageId("msg-out"),
      domainId,
      threadId: createThreadId("thr-out"),
      rfcMessageId: "out1@example.com",
      inReplyTo: null,
      references: [],
      subject: "First send",
      fromAddress: createEmailAddress("hello@example.com"),
      fromName: null,
      textBody: "body",
      htmlBody: null,
      rawKey: null,
      rawSize: 0,
      occurredAt: NOW,
      createdAt: NOW,
    });
    await messages.insertWithRelations({
      message: outbound,
      recipients: [
        {
          kind: RecipientKind.To,
          address: createEmailAddress("customer@other.com"),
          name: null,
          position: 0,
        },
      ],
      attachments: [],
      tagIds: [],
      taggedAt: NOW,
    });

    expect(
      await repository.hasKnownLocalPart(domainId, "hello@example.com"),
    ).toBe(true);
  });

  test("delete removes the row", async () => {
    await repository.save(domain());
    await repository.delete(domainId);
    expect(await repository.findById(domainId)).toBeNull();
  });
});

describe("tagRepository", () => {
  let repository: ReturnType<typeof createTagRepository>;

  beforeEach(async () => {
    repository = createTagRepository(await createMigratedDatabase());
  });

  test("reads the migration-seeded system tags by slug", async () => {
    const trash = await repository.findBySystemSlug(SystemTagSlug.Trash);
    expect(trash?.id).toBe(SYSTEM_TAG_IDS.trash);
    expect(trash?.kind).toBe(TagKind.System);
    for (const slug of Object.values(SystemTagSlug)) {
      expect(await repository.findBySystemSlug(slug)).not.toBeNull();
    }
  });

  test("round-trips a user tag", async () => {
    const tag = createUserTag({
      id: createTagId("tag-1"),
      name: "Invoices",
      color: "#aabbcc",
      createdAt: NOW,
    });
    await repository.save(tag);
    expect(await repository.findById(tag.id)).toEqual(tag);
  });

  test("finds by name case-insensitively", async () => {
    await repository.save(
      createUserTag({
        id: createTagId("tag-1"),
        name: "Invoices",
        color: null,
        createdAt: NOW,
      }),
    );
    expect((await repository.findByName("invoices"))?.id).toBe("tag-1");
    expect((await repository.findByName("  INVOICES  "))?.id).toBe("tag-1");
    expect(await repository.findByName("nope")).toBeNull();
  });

  test("findByIds returns only the known ids", async () => {
    expect(
      (
        await repository.findByIds([
          createTagId(SYSTEM_TAG_IDS.trash),
          createTagId("nope"),
        ])
      ).map((tag) => tag.id),
    ).toEqual([SYSTEM_TAG_IDS.trash]);
    expect(await repository.findByIds([])).toEqual([]);
  });

  test("save updates name and colour without touching the slug", async () => {
    const trash = await repository.findBySystemSlug(SystemTagSlug.Trash);
    expect(trash).not.toBeNull();
    if (trash === null) {
      return;
    }
    // Bypasses the domain guard on purpose: this asserts the repository's
    // upsert shape, not the immutability rule (which is tested in the
    // domain layer).
    await repository.save({ ...trash, name: "Junk", updatedAt: NOW });
    const reread = await repository.findBySystemSlug(SystemTagSlug.Trash);
    expect(reread?.name).toBe("Junk");
    expect(reread?.systemSlug).toBe(SystemTagSlug.Trash);
  });

  test("countMessages defaults to zero for every requested id", async () => {
    const counts = await repository.countMessages([
      createTagId(SYSTEM_TAG_IDS.trash),
    ]);
    expect(counts.get(SYSTEM_TAG_IDS.trash)).toBe(0);
    expect(await repository.countMessages([])).toEqual(new Map());
  });

  test("the schema rejects an out-of-range enum value outright", async () => {
    // `assertEnumValue` is the read-side backstop (covered directly in
    // sql-helpers.test.ts); the column CHECK is the write-side one, and it
    // makes the corrupt state unreachable in the first place.
    const db = await createMigratedDatabase();
    await expect(
      db.execute(
        `INSERT INTO tags (id, name, color, kind, system_slug, created_at, updated_at)
         VALUES ('bad', 'Bad', NULL, 'NONSENSE', NULL, ?, ?)`,
        [NOW, NOW],
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("delete removes the row", async () => {
    await repository.delete(createTagId(SYSTEM_TAG_IDS.starred));
    expect(await repository.findBySystemSlug(SystemTagSlug.Starred)).toBeNull();
  });

  test("renameTag output persists", async () => {
    const tag = createUserTag({
      id: createTagId("tag-1"),
      name: "Later",
      color: null,
      createdAt: NOW,
    });
    await repository.save(tag);
    await repository.save(
      renameTag(tag, "Someday", "#112233", "2026-08-23T01:00:00.000Z"),
    );
    const stored = await repository.findById(tag.id);
    expect(stored?.name).toBe("Someday");
    expect(stored?.color).toBe("#112233");
  });
});

describe("apiKeyRepository", () => {
  let repository: ReturnType<typeof createApiKeyRepository>;
  const apiKeyId = createApiKeyId("key-1");

  const key = () =>
    createApiKey({
      id: apiKeyId,
      name: "agent",
      keyHash: "hash-1",
      keyPrefix: "ybm_abc",
      createdByUserId: null,
      expiresAt: null,
      createdAt: NOW,
    });

  beforeEach(async () => {
    const db = await createMigratedDatabase();
    await db.execute(
      `INSERT INTO domains (id, name, status, catch_all, verification_token, created_at, updated_at)
       VALUES (?, 'example.com', 'ACTIVE', 1, 'tok', ?, ?)`,
      [domainId, NOW, NOW],
    );
    repository = createApiKeyRepository(db);
  });

  test("round-trips a key and finds it by hash", async () => {
    await repository.save(key());
    expect(await repository.findByKeyHash("hash-1")).toEqual(key());
    expect(await repository.findByKeyHash("nope")).toBeNull();
  });

  test("returns revoked keys too, leaving the usability check to the caller", async () => {
    await repository.save(revokeApiKey(key(), "2026-08-23T01:00:00.000Z"));
    const stored = await repository.findByKeyHash("hash-1");
    expect(stored?.revokedAt).toBe("2026-08-23T01:00:00.000Z");
  });

  test("round-trips scopes including a null domain and a wildcard", async () => {
    await repository.save(key());
    const scoped = createApiKeyScope({
      id: createApiKeyScopeId("scope-1"),
      apiKeyId,
      capability: Capability.MailRead,
      domainId,
      addressPattern: createAddressPattern("support@example.com"),
    });
    const global = createApiKeyScope({
      id: createApiKeyScopeId("scope-2"),
      apiKeyId,
      capability: Capability.KeyAdmin,
      domainId: null,
      addressPattern: MATCH_ALL_ADDRESSES,
    });
    await repository.saveScope(scoped);
    await repository.saveScope(global);

    const byKey = await repository.listScopes([apiKeyId]);
    expect(byKey.get(apiKeyId)).toHaveLength(2);
    expect(await repository.findScopeById(scoped.id)).toEqual(scoped);
    expect((await repository.findScopeById(global.id))?.addressPattern).toBe(
      "*",
    );
  });

  test("listScopes returns an empty array for a key with none", async () => {
    await repository.save(key());
    expect((await repository.listScopes([apiKeyId])).get(apiKeyId)).toEqual([]);
    expect(await repository.listScopes([])).toEqual(new Map());
  });

  test("deleting a key cascades its scopes", async () => {
    const db = await createMigratedDatabase();
    const repo = createApiKeyRepository(db);
    await repo.save(key());
    await repo.saveScope(
      createApiKeyScope({
        id: createApiKeyScopeId("scope-1"),
        apiKeyId,
        capability: Capability.MailRead,
        domainId: null,
        addressPattern: MATCH_ALL_ADDRESSES,
      }),
    );
    await db.execute("DELETE FROM api_keys WHERE id = ?", [apiKeyId]);
    expect(await repo.findScopeById(createApiKeyScopeId("scope-1"))).toBeNull();
  });

  test("deleteScope removes just that scope", async () => {
    await repository.save(key());
    await repository.saveScope(
      createApiKeyScope({
        id: createApiKeyScopeId("scope-1"),
        apiKeyId,
        capability: Capability.MailRead,
        domainId: null,
        addressPattern: MATCH_ALL_ADDRESSES,
      }),
    );
    await repository.deleteScope(createApiKeyScopeId("scope-1"));
    expect((await repository.listScopes([apiKeyId])).get(apiKeyId)).toEqual([]);
  });
});

describe("auth repositories", () => {
  let db: SqlDatabase;
  const userId = createUserId("usr-1");

  const user = () =>
    createUser({
      id: userId,
      email: createEmailAddress("me@example.com"),
      name: "Taro",
      role: UserRole.Admin,
      createdAt: NOW,
    });

  beforeEach(async () => {
    db = await createMigratedDatabase();
  });

  test("user round-trip, lookup by email, count and deactivation", async () => {
    const users = createUserRepository(db);
    expect(await users.count()).toBe(0);

    await users.save(user());
    expect(await users.findById(userId)).toEqual(user());
    expect(
      (await users.findByEmail(createEmailAddress("me@example.com")))?.id,
    ).toBe(userId);
    expect(
      await users.findByEmail(createEmailAddress("nobody@example.com")),
    ).toBeNull();
    expect(await users.count()).toBe(1);

    await users.save(deactivateUser(user(), "2026-08-23T01:00:00.000Z"));
    expect((await users.findById(userId))?.deactivatedAt).toBe(
      "2026-08-23T01:00:00.000Z",
    );
  });

  test("session round-trip, deletion by hash and expiry sweep", async () => {
    await createUserRepository(db).save(user());
    const sessions = createSessionRepository(db);

    const live = createSession({
      id: createSessionId("ses-live"),
      tokenHash: "hash-live",
      userId,
      expiresAt: "2026-09-23T00:00:00.000Z",
      createdAt: NOW,
    });
    const expired = createSession({
      id: createSessionId("ses-expired"),
      tokenHash: "hash-expired",
      userId,
      expiresAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await sessions.save(live);
    await sessions.save(expired);

    expect(await sessions.findByTokenHash("hash-live")).toEqual(live);
    expect(await sessions.deleteExpired(NOW)).toBe(1);
    expect(await sessions.findByTokenHash("hash-expired")).toBeNull();

    await sessions.deleteByTokenHash("hash-live");
    expect(await sessions.findByTokenHash("hash-live")).toBeNull();
  });

  test("deleting a user cascades their sessions", async () => {
    await createUserRepository(db).save(user());
    const sessions = createSessionRepository(db);
    await sessions.save(
      createSession({
        id: createSessionId("ses-1"),
        tokenHash: "hash-1",
        userId,
        expiresAt: "2026-09-23T00:00:00.000Z",
        createdAt: NOW,
      }),
    );
    await db.execute("DELETE FROM users WHERE id = ?", [userId]);
    expect(await sessions.findByTokenHash("hash-1")).toBeNull();
  });

  test("challenge round-trip, consumption and expiry sweep", async () => {
    const challenges = createEmailAuthChallengeRepository(db);
    const challenge = createEmailAuthChallenge({
      id: createEmailAuthChallengeId("cha-1"),
      email: createEmailAddress("me@example.com"),
      tokenHash: "hash-cha",
      expiresAt: "2026-08-23T00:15:00.000Z",
      createdAt: NOW,
    });
    await challenges.save(challenge);
    expect(await challenges.findByTokenHash("hash-cha")).toEqual(challenge);

    await challenges.save(
      consumeEmailAuthChallenge(challenge, "2026-08-23T00:05:00.000Z"),
    );
    expect((await challenges.findById(challenge.id))?.consumedAt).toBe(
      "2026-08-23T00:05:00.000Z",
    );

    expect(await challenges.deleteExpired("2026-08-23T01:00:00.000Z")).toBe(1);
    expect(await challenges.findByTokenHash("hash-cha")).toBeNull();
  });
});

describe("fileLinkRepository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createFileLinkRepository>;
  const messageId = createMessageId("msg-1");
  const attachmentId = createAttachmentId("att-1");

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await db.execute(
      `INSERT INTO domains (id, name, status, catch_all, verification_token, created_at, updated_at)
       VALUES (?, 'example.com', 'ACTIVE', 1, 'tok', ?, ?)`,
      [domainId, NOW, NOW],
    );
    const messages = createMessageRepository(db);
    await messages.insertWithRelations({
      message: createInboundMessage({
        id: messageId,
        domainId,
        threadId: createThreadId("thr-1"),
        rfcMessageId: "m1@other.com",
        inReplyTo: null,
        references: [],
        subject: "Hi",
        fromAddress: createEmailAddress("sender@other.com"),
        fromName: null,
        textBody: "body",
        htmlBody: null,
        rawKey: `raw/${messageId}.eml`,
        rawSize: 10,
        occurredAt: NOW,
        createdAt: NOW,
        spamScore: null,
      }),
      recipients: [
        {
          kind: RecipientKind.Envelope,
          address: createEmailAddress("support@example.com"),
          name: null,
          position: 0,
        },
      ],
      attachments: [
        createAttachment({
          id: attachmentId,
          messageId,
          fileName: "report.pdf",
          contentType: "application/pdf",
          size: 3,
          blobKey: `att/${attachmentId}/report.pdf`,
          contentId: null,
          inline: false,
          createdAt: NOW,
        }),
      ],
      tagIds: [],
      taggedAt: NOW,
    });
    repository = createFileLinkRepository(db);
  });

  const attachmentLink = () =>
    createAttachmentFileLink({
      id: createFileLinkId("link-att"),
      tokenHash: "hash-att",
      attachmentId,
      expiresAt: "2026-08-23T01:00:00.000Z",
      maxDownloads: 2,
      createdByApiKeyId: null,
      createdByUserId: null,
      createdAt: NOW,
    });

  const rawLink = () =>
    createRawMessageFileLink({
      id: createFileLinkId("link-raw"),
      tokenHash: "hash-raw",
      messageId,
      expiresAt: "2026-08-23T01:00:00.000Z",
      maxDownloads: null,
      createdByApiKeyId: null,
      createdByUserId: null,
      createdAt: NOW,
    });

  test("round-trips both link targets", async () => {
    await repository.save(attachmentLink());
    await repository.save(rawLink());
    expect(await repository.findByTokenHash("hash-att")).toEqual(
      attachmentLink(),
    );
    const raw = await repository.findByTokenHash("hash-raw");
    expect(raw?.target).toBe(FileLinkTarget.RawMessage);
    expect(raw?.maxDownloads).toBeNull();
  });

  test("persists an incremented download count", async () => {
    await repository.save(attachmentLink());
    await repository.save(
      consumeFileLink(attachmentLink(), "2026-08-23T00:30:00.000Z"),
    );
    expect((await repository.findByTokenHash("hash-att"))?.downloadCount).toBe(
      1,
    );
  });

  test("persists revocation", async () => {
    await repository.save(attachmentLink());
    await repository.save(
      revokeFileLink(attachmentLink(), "2026-08-23T00:30:00.000Z"),
    );
    expect((await repository.findByTokenHash("hash-att"))?.revokedAt).toBe(
      "2026-08-23T00:30:00.000Z",
    );
  });

  test("lists links reaching the message directly or via its attachments", async () => {
    await repository.save(attachmentLink());
    await repository.save(rawLink());
    const links = await repository.listByMessage(messageId);
    expect(links.map((link) => link.id).sort()).toEqual([
      "link-att",
      "link-raw",
    ]);
  });

  test("sweeps expired links", async () => {
    await repository.save(attachmentLink());
    expect(await repository.deleteExpired("2026-08-23T02:00:00.000Z")).toBe(1);
    expect(await repository.findByTokenHash("hash-att")).toBeNull();
  });

  test("deleting the message cascades its links", async () => {
    await repository.save(rawLink());
    await createMessageRepository(db).delete([messageId]);
    expect(await repository.findByTokenHash("hash-raw")).toBeNull();
  });

  test("the target/id consistency constraint is enforced", async () => {
    await expect(
      db.execute(
        `INSERT INTO file_links
           (id, token_hash, target, attachment_id, message_id, expires_at,
            download_count, created_at)
         VALUES ('bad', 'hash-bad', 'ATTACHMENT', NULL, NULL, ?, 0, ?)`,
        ["2026-08-23T01:00:00.000Z", NOW],
      ),
    ).rejects.toThrow();
  });
});
