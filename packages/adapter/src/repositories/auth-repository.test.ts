import { describe, expect, test } from "vitest";
import {
  EmailAuthChallengePurpose,
  createEmailAuthChallenge,
} from "@flying-mail/domain/entities/email-auth-challenge";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createEmailAuthChallengeId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { createMigratedDatabase } from "./test-support";
import {
  createEmailAuthChallengeRepository,
  createUserRepository,
} from "./auth-repository";

const NOW = "2026-08-23T00:00:00.000Z";

function challenge(
  id: string,
  purpose: EmailAuthChallengePurpose,
  expiresAt = "2026-08-23T00:15:00.000Z",
) {
  return createEmailAuthChallenge({
    id: createEmailAuthChallengeId(id),
    email: createEmailAddress("me@example.com"),
    purpose,
    tokenHash: `hash-${id}`,
    expiresAt,
    createdAt: NOW,
  });
}

function user(id: string, invitationAcceptedAt: string | null) {
  return createUser({
    id: createUserId(id),
    email: createEmailAddress(`${id}@example.com`),
    name: "Test User",
    role: UserRole.Member,
    createdAt: NOW,
    invitationAcceptedAt,
  });
}

describe("auth repositories", () => {
  test("challenge round-trips its purpose and counts only the requested purpose", async () => {
    const db = await createMigratedDatabase();
    const repository = createEmailAuthChallengeRepository(db);
    const login = challenge("cha-login", EmailAuthChallengePurpose.Login);
    const invitation = challenge(
      "cha-invitation",
      EmailAuthChallengePurpose.Invitation,
    );
    await repository.save(login);
    await repository.save(invitation);

    expect(await repository.findById(invitation.id)).toEqual(invitation);
    expect(
      await repository.countRecentByEmail(
        login.email,
        NOW,
        EmailAuthChallengePurpose.Login,
      ),
    ).toBe(1);
    expect(
      await repository.countRecentByEmail(
        login.email,
        NOW,
        EmailAuthChallengePurpose.Invitation,
      ),
    ).toBe(1);
  });

  test("consume is atomic, single-use, and rejects expired challenges", async () => {
    const db = await createMigratedDatabase();
    const repository = createEmailAuthChallengeRepository(db);
    const fresh = challenge("cha-fresh", EmailAuthChallengePurpose.Login);
    await repository.save(fresh);
    expect(await repository.consume(fresh.id, "2026-08-23T00:05:00.000Z")).toBe(
      true,
    );
    expect(await repository.consume(fresh.id, "2026-08-23T00:06:00.000Z")).toBe(
      false,
    );

    const concurrent = challenge(
      "cha-concurrent",
      EmailAuthChallengePurpose.Login,
    );
    await repository.save(concurrent);
    const results = await Promise.all([
      repository.consume(concurrent.id, "2026-08-23T00:05:00.000Z"),
      repository.consume(concurrent.id, "2026-08-23T00:05:00.000Z"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const expired = challenge(
      "cha-expired",
      EmailAuthChallengePurpose.Login,
      NOW,
    );
    await repository.save(expired);
    expect(await repository.consume(expired.id, NOW)).toBe(false);
  });

  test("user upsert and createFirstUser persist invitation acceptance timestamps", async () => {
    const db = await createMigratedDatabase();
    const repository = createUserRepository(db);
    const pending = user("usr-pending", null);
    const accepted = user("usr-accepted", "2026-08-23T00:30:00.000Z");
    await repository.save(pending);
    await repository.save(accepted);
    expect(await repository.findById(pending.id)).toEqual(pending);
    expect(await repository.findById(accepted.id)).toEqual(accepted);

    const emptyRepository = createUserRepository(
      await createMigratedDatabase(),
    );
    const bootstrap = user("usr-bootstrap", "2026-08-23T00:45:00.000Z");
    expect(await emptyRepository.createFirstUser(bootstrap)).toBe(true);
    expect(await emptyRepository.findById(bootstrap.id)).toEqual(bootstrap);
  });
});
