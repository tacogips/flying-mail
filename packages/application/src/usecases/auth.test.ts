import { Capability } from "@mailcal/domain/entities/api-key";
import { createAttachment } from "@mailcal/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createSession } from "@mailcal/domain/entities/session";
import {
  createUser,
  deactivateUser,
  UserRole,
} from "@mailcal/domain/entities/user";
import {
  createUserMailPermission,
  UserPermissionEffect,
} from "@mailcal/domain/entities/user-mail-permission";
import { MATCH_ALL_ADDRESSES } from "@mailcal/domain/value-objects/address-pattern";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createSessionId,
  createAttachmentId,
  createUserId,
  createUserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createUseCases } from "../usecases";
import {
  ConflictError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { createCreateApiKeyUseCase } from "./api-keys";
import {
  createGetViewerUserUseCase,
  createLogoutUseCase,
  createResolveViewerFromTokenUseCase,
} from "./auth";
import {
  createBootstrapAdminUseCase,
  createRequestEmailAuthUseCase,
  createSweepExpiredAuthUseCase,
  createVerifyEmailAuthTokenUseCase,
} from "./email-auth";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const userId = createUserId("usr-1");

function seedUser(fake: FakeDependencies, active = true) {
  const user = createUser({
    id: userId,
    email: createEmailAddress("me@example.com"),
    name: "Taro",
    role: UserRole.Admin,
    createdAt: NOW,
  });
  const stored = active ? user : deactivateUser(user, NOW);
  fake.stores.users.set(stored.id, stored);
  return stored;
}

describe("resolveViewerFromToken", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: domainId,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "tok",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  });

  test("resolves a live session to a USER viewer", async () => {
    const user = seedUser(fake);
    const session = createSession({
      id: createSessionId("ses-1"),
      tokenHash: "hash(session-token)",
      userId: user.id,
      expiresAt: "2026-09-23T00:00:00.000Z",
      createdAt: NOW,
    });
    fake.stores.sessions.set(session.id, session);

    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve("session-token")).toEqual({
      kind: "USER",
      userId: user.id,
      role: UserRole.Admin,
      permissions: [],
      templatePermissions: [],
      calendarPermissions: [],
    });
  });

  test("reloads current user mail permissions for every session request", async () => {
    const user = seedUser(fake);
    const session = createSession({
      id: createSessionId("ses-1"),
      tokenHash: "hash(session-token)",
      userId: user.id,
      expiresAt: "2026-09-23T00:00:00.000Z",
      createdAt: NOW,
    });
    fake.stores.sessions.set(session.id, session);
    const permission = createUserMailPermission({
      id: createUserMailPermissionId("ump-1"),
      userId: user.id,
      effect: UserPermissionEffect.Deny,
      domainId,
      addressPattern: MATCH_ALL_ADDRESSES,
      createdByUserId: user.id,
      createdAt: NOW,
    });
    const resolve = createResolveViewerFromTokenUseCase(fake.deps);

    expect(await resolve("session-token")).toMatchObject({ permissions: [] });
    await fake.deps.userMailPermissionRepository.save(permission);
    expect(await resolve("session-token")).toMatchObject({
      permissions: [permission],
    });
    await fake.deps.userMailPermissionRepository.delete(permission.id);
    expect(await resolve("session-token")).toMatchObject({ permissions: [] });
  });

  test("rejects an expired session", async () => {
    const user = seedUser(fake);
    fake.stores.sessions.set(
      "ses-1",
      createSession({
        id: createSessionId("ses-1"),
        tokenHash: "hash(session-token)",
        userId: user.id,
        expiresAt: "2026-08-22T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve("session-token")).toBeNull();
  });

  test("rejects a session whose user is deactivated", async () => {
    const user = seedUser(fake, false);
    fake.stores.sessions.set(
      "ses-1",
      createSession({
        id: createSessionId("ses-1"),
        tokenHash: "hash(session-token)",
        userId: user.id,
        expiresAt: "2026-09-23T00:00:00.000Z",
        createdAt: NOW,
      }),
    );
    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve("session-token")).toBeNull();
  });

  test("resolves a usable api key with its scopes", async () => {
    seedUser(fake);
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "agent",
      scopes: [
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "support@example.com",
        },
      ],
      expiresAt: null,
    });

    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    const viewer = await resolve(issued.secret);
    expect(viewer?.kind).toBe("API_KEY");
    if (viewer?.kind !== "API_KEY") {
      return;
    }
    expect(viewer.apiKeyId).toBe(issued.apiKey.id);
    expect(viewer.scopes).toHaveLength(1);
    expect(viewer).not.toHaveProperty("permissions");
  });

  test("records last-used without blocking resolution", async () => {
    seedUser(fake);
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "agent",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
      ],
      expiresAt: null,
    });

    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    await resolve(issued.secret);
    // The write is fire-and-forget; let the microtask queue drain.
    await Promise.resolve();
    expect(fake.stores.apiKeys.get(issued.apiKey.id)?.lastUsedAt).toBe(NOW);
  });

  test("rejects a revoked key", async () => {
    seedUser(fake);
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "agent",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
      ],
      expiresAt: null,
    });
    fake.stores.apiKeys.set(issued.apiKey.id, {
      ...issued.apiKey,
      revokedAt: NOW,
    });

    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve(issued.secret)).toBeNull();
  });

  test("rejects an expired key", async () => {
    seedUser(fake);
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "agent",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
      ],
      expiresAt: "2026-08-22T00:00:00.000Z",
    });

    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve(issued.secret)).toBeNull();
  });

  test.each([
    ["an unknown token", "nope"],
    ["an empty token", ""],
  ])("returns null for %s", async (_label, token) => {
    const resolve = createResolveViewerFromTokenUseCase(fake.deps);
    expect(await resolve(token)).toBeNull();
  });
});

describe("logout", () => {
  test("deletes the session and reports success even when absent", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const user = seedUser(fake);
    fake.stores.sessions.set(
      "ses-1",
      createSession({
        id: createSessionId("ses-1"),
        tokenHash: "hash(session-token)",
        userId: user.id,
        expiresAt: "2026-09-23T00:00:00.000Z",
        createdAt: NOW,
      }),
    );
    const logout = createLogoutUseCase(fake.deps);
    expect(await logout("session-token")).toBe(true);
    expect(fake.stores.sessions.size).toBe(0);
    expect(await logout("already-gone")).toBe(true);
  });
});

describe("getViewerUser", () => {
  test("returns null for an api key viewer", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const get = createGetViewerUserUseCase(fake.deps);
    expect(
      await get({ kind: "API_KEY", apiKeyId: "k" as never, scopes: [] }),
    ).toBeNull();
  });

  test("returns the user for a session viewer", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const user = seedUser(fake);
    const get = createGetViewerUserUseCase(fake.deps);
    expect(
      (
        await get({
          kind: "USER",
          userId: user.id,
          role: user.role,
          permissions: [],
          templatePermissions: [],
          calendarPermissions: [],
        })
      )?.id,
    ).toBe(user.id);
  });
});

describe("passwordless email auth", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("does not reveal whether an address is known", async () => {
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    expect(await request("me@example.com")).toBe(true);
    expect(await request("stranger@example.com")).toBe(true);
    // Only the known address actually produced a challenge and a mail.
    expect(fake.stores.challenges.size).toBe(1);
    expect(fake.mailSender.sent).toHaveLength(1);
  });

  test("mails a link from the configured sender", async () => {
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request("me@example.com");
    const mail = fake.mailSender.sent[0];
    expect(mail?.from).toBe("postmaster@example.com");
    expect(mail?.to).toEqual(["me@example.com"]);
    expect(mail?.text).toContain("https://mail.example.com/auth/verify?token=");
  });

  test.each([
    ["no public origin", { publicOrigin: null }],
    ["no sender address", { mailFrom: null }],
  ])("is unavailable with %s", async (_label, instanceConfig) => {
    const unconfigured = createFakeDependencies({ now: NOW, instanceConfig });
    seedUser(unconfigured);
    const request = createRequestEmailAuthUseCase(unconfigured.deps);
    await expect(request("me@example.com")).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  test("exchanges a fresh token for a session", async () => {
    const user = seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request("me@example.com");
    const url = fake.mailSender.sent[0]?.text ?? "";
    const token = decodeURIComponent(
      url.split("token=")[1]?.split(/\s/)[0] ?? "",
    );

    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    const result = await verify(token);
    expect(result.user.id).toBe(user.id);
    expect(result.session.userId).toBe(user.id);
    expect(fake.stores.sessions.size).toBe(1);
  });

  test("rejects a replayed token", async () => {
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request("me@example.com");
    const url = fake.mailSender.sent[0]?.text ?? "";
    const token = decodeURIComponent(
      url.split("token=")[1]?.split(/\s/)[0] ?? "",
    );

    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    await verify(token);
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test("rejects an expired token", async () => {
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    await request("me@example.com");
    const url = fake.mailSender.sent[0]?.text ?? "";
    const token = decodeURIComponent(
      url.split("token=")[1]?.split(/\s/)[0] ?? "",
    );
    fake.clock.advanceSeconds(16 * 60);

    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test.each([
    ["an unknown token", "nope"],
    ["an empty token", ""],
  ])("rejects %s", async (_label, token) => {
    const verify = createVerifyEmailAuthTokenUseCase(fake.deps);
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("login link throttle", () => {
  test("stops issuing after three challenges in the window, still answering true", async () => {
    const fake = createFakeDependencies({ now: NOW });
    seedUser(fake);
    const request = createRequestEmailAuthUseCase(fake.deps);
    for (let i = 0; i < 5; i += 1) {
      // Uniformly true: a distinguishable throttle answer would be a
      // user-enumeration oracle.
      expect(await request("me@example.com")).toBe(true);
    }
    expect(fake.stores.challenges.size).toBe(3);
    expect(fake.mailSender.sent).toHaveLength(3);
  });

  test("throttling one address does not affect another", async () => {
    const fake = createFakeDependencies({ now: NOW });
    seedUser(fake);
    const other = createUser({
      id: createUserId("user-other"),
      email: createEmailAddress("other@example.com"),
      name: "Hanako",
      role: UserRole.Member,
      createdAt: NOW,
    });
    fake.stores.users.set(other.id, other);
    const request = createRequestEmailAuthUseCase(fake.deps);
    for (let i = 0; i < 4; i += 1) {
      await request("me@example.com");
    }
    await request("other@example.com");
    const toOther = fake.mailSender.sent.filter((mail) =>
      mail.to.includes("other@example.com"),
    );
    expect(toOther).toHaveLength(1);
  });
});

describe("bootstrapAdmin", () => {
  test("creates the first admin with a root key, then refuses", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const bootstrap = createBootstrapAdminUseCase(fake.deps);
    const result = await bootstrap("first@example.com", "First");
    expect(result.user.role).toBe(UserRole.Admin);
    // A fresh deployment has no shell and no verified sending domain, so
    // bootstrap must hand back a usable credential or the instance is
    // unreachable.
    expect(result.secret.startsWith(result.apiKey.keyPrefix)).toBe(true);
    const scopes = await fake.deps.apiKeyRepository.listScopes([
      result.apiKey.id,
    ]);
    // One scope per capability, so a fresh deployment's root key can reach
    // mail, templates and calendars alike.
    expect(scopes.get(result.apiKey.id)?.length).toBe(
      Object.values(Capability).length,
    );
    await expect(
      bootstrap("second@example.com", "Second"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("two concurrent bootstraps produce exactly one admin", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const bootstrap = createBootstrapAdminUseCase(fake.deps);
    // Neither call awaits the other, so both pass any read-then-write
    // emptiness check; only the atomic first-user insert keeps this at one.
    const results = await Promise.allSettled([
      bootstrap("first@example.com", "First"),
      bootstrap("second@example.com", "Second"),
    ]);
    expect(
      results.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    expect(fake.stores.users.size).toBe(1);
  });
});

describe("sweepExpiredAuth", () => {
  test("reclaims expired links and stale staged uploads, blobs included", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const sweep = createSweepExpiredAuthUseCase(fake.deps);

    // A staged upload abandoned two days ago, with its blob.
    const staleId = createAttachmentId("att-stale");
    const stale = createAttachment({
      id: staleId,
      messageId: null,
      fileName: "old.bin",
      contentType: "application/octet-stream",
      size: 1,
      blobKey: "staged/att-stale/old.bin",
      contentId: null,
      inline: false,
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    fake.messageStores.attachments.set(staleId, stale);
    await fake.deps.blobs.put(stale.blobKey, new Uint8Array([1]));

    // A staged upload from just now must survive.
    const freshId = createAttachmentId("att-fresh");
    fake.messageStores.attachments.set(
      freshId,
      createAttachment({
        id: freshId,
        messageId: null,
        fileName: "new.bin",
        contentType: "application/octet-stream",
        size: 1,
        blobKey: "staged/att-fresh/new.bin",
        contentId: null,
        inline: false,
        createdAt: NOW,
      }),
    );

    await sweep();

    expect(fake.messageStores.attachments.has(staleId)).toBe(false);
    expect(fake.messageStores.attachments.has(freshId)).toBe(true);
    expect(await fake.deps.blobs.get(stale.blobKey)).toBeNull();
  });
});

describe("createUseCases", () => {
  test("binds every declared member to a function", () => {
    const fake = createFakeDependencies({ now: NOW });
    const usecases = createUseCases(fake.deps);
    for (const [name, value] of Object.entries(usecases)) {
      expect(typeof value, `usecases.${name}`).toBe("function");
    }
    // Guards against a member being dropped from the facade unnoticed.
    expect(Object.keys(usecases).length).toBeGreaterThanOrEqual(40);
  });
});
