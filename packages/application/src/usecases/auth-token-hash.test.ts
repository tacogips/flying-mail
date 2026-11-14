import { Capability } from "@flying-mail/domain/entities/api-key";
import { createSession } from "@flying-mail/domain/entities/session";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createSessionId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { describe, expect, test, vi } from "vitest";
import { createFakeDependencies } from "../test-support/fakes";
import { adminViewer } from "../test-support/viewer-fixtures";
import { createCreateApiKeyUseCase } from "./api-keys";
import {
  createResolveViewerFromTokenHashUseCase,
  createResolveViewerFromTokenUseCase,
} from "./auth";

const NOW = "2026-08-23T00:00:00.000Z";

describe("resolveViewerFromTokenHash", () => {
  test("resolves a session hash to the same viewer as token resolution", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const user = createUser({
      id: createUserId("usr-hash-session"),
      email: createEmailAddress("session@example.com"),
      name: "Session User",
      role: UserRole.Admin,
      createdAt: NOW,
    });
    fake.stores.users.set(user.id, user);
    fake.stores.sessions.set(
      "ses-hash-session",
      createSession({
        id: createSessionId("ses-hash-session"),
        tokenHash: "hash(session-token)",
        userId: user.id,
        expiresAt: "2026-09-23T00:00:00.000Z",
        createdAt: NOW,
      }),
    );

    const tokenResolver = createResolveViewerFromTokenUseCase(fake.deps);
    const hashResolver = createResolveViewerFromTokenHashUseCase(fake.deps);
    const hash = await fake.deps.tokenHasher.hash("session-token");
    expect(await hashResolver(hash, { recordUsage: false })).toEqual(
      await tokenResolver("session-token"),
    );
  });

  test("resolves API keys like HTTP without recording usage when disabled", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const issued = await createCreateApiKeyUseCase(fake.deps)(adminViewer(), {
      name: "hash key",
      scopes: [
        {
          capability: Capability.MailSend,
          domainId: null,
          addressPattern: "*",
        },
      ],
      expiresAt: null,
    });
    const tokenResolver = createResolveViewerFromTokenUseCase(fake.deps);
    const hashResolver = createResolveViewerFromTokenHashUseCase(fake.deps);
    const hash = await fake.deps.tokenHasher.hash(issued.secret);
    const tokenViewer = await tokenResolver(issued.secret);
    await Promise.resolve();
    const save = vi.spyOn(fake.deps.apiKeyRepository, "save");

    expect(await hashResolver(hash, { recordUsage: false })).toEqual(
      tokenViewer,
    );
    expect(save).not.toHaveBeenCalled();
  });

  test("returns null for an unknown hash", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const resolve = createResolveViewerFromTokenHashUseCase(fake.deps);
    expect(await resolve("missing-hash", { recordUsage: false })).toBeNull();
  });
});
