import { describe, expect, test } from "vitest";
import { InvalidStateTransitionError, ValidationError } from "../errors";
import { createEmailAddress } from "../value-objects/email-address";
import {
  createEmailAuthChallengeId,
  createSessionId,
  createUserId,
} from "../value-objects/ids";
import {
  consumeEmailAuthChallenge,
  createEmailAuthChallenge,
  isChallengeUsable,
} from "./email-auth-challenge";
import { createSession, isSessionExpired } from "./session";
import {
  createUser,
  deactivateUser,
  isAdmin,
  isUserActive,
  reactivateUser,
  setUserRole,
  UserRole,
} from "./user";

const now = "2026-08-23T00:00:00.000Z";

const user = (role: UserRole = UserRole.Member) =>
  createUser({
    id: createUserId("usr-1"),
    email: createEmailAddress("me@example.com"),
    name: "  Taro  ",
    role,
    createdAt: now,
  });

describe("createUser", () => {
  test("trims the name and starts active", () => {
    const created = user();
    expect(created.name).toBe("Taro");
    expect(isUserActive(created)).toBe(true);
    expect(created.deactivatedAt).toBeNull();
  });

  test("rejects a blank name", () => {
    expect(() =>
      createUser({
        id: createUserId("usr-2"),
        email: createEmailAddress("me@example.com"),
        name: "  ",
        role: UserRole.Member,
        createdAt: now,
      }),
    ).toThrow(ValidationError);
  });

  test("supports a read-only viewer role", () => {
    expect(user(UserRole.Viewer).role).toBe(UserRole.Viewer);
  });
});

describe("user lifecycle", () => {
  test("deactivation is idempotent and clears admin status", () => {
    const admin = user(UserRole.Admin);
    expect(isAdmin(admin)).toBe(true);
    const deactivated = deactivateUser(admin, "2026-08-23T01:00:00.000Z");
    expect(isUserActive(deactivated)).toBe(false);
    expect(isAdmin(deactivated)).toBe(false);
    const again = deactivateUser(deactivated, "2026-08-24T01:00:00.000Z");
    expect(again.deactivatedAt).toBe("2026-08-23T01:00:00.000Z");
  });

  test("reactivation restores access", () => {
    const deactivated = deactivateUser(
      user(UserRole.Admin),
      "2026-08-23T01:00:00.000Z",
    );
    const reactivated = reactivateUser(deactivated, "2026-08-23T02:00:00.000Z");
    expect(isAdmin(reactivated)).toBe(true);
  });

  test("role changes are recorded", () => {
    const promoted = setUserRole(
      user(),
      UserRole.Admin,
      "2026-08-23T01:00:00.000Z",
    );
    expect(promoted.role).toBe(UserRole.Admin);
    expect(promoted.updatedAt).toBe("2026-08-23T01:00:00.000Z");
  });
});

describe("Session", () => {
  const session = createSession({
    id: createSessionId("ses-1"),
    tokenHash: "hash",
    userId: createUserId("usr-1"),
    expiresAt: "2026-08-24T00:00:00.000Z",
    createdAt: now,
  });

  test("is live before expiry", () => {
    expect(isSessionExpired(session, "2026-08-23T12:00:00.000Z")).toBe(false);
  });

  test("is expired at and after expiry", () => {
    expect(isSessionExpired(session, "2026-08-24T00:00:00.000Z")).toBe(true);
    expect(isSessionExpired(session, "2026-08-25T00:00:00.000Z")).toBe(true);
  });
});

describe("EmailAuthChallenge", () => {
  const challenge = () =>
    createEmailAuthChallenge({
      id: createEmailAuthChallengeId("cha-1"),
      email: createEmailAddress("me@example.com"),
      tokenHash: "hash",
      expiresAt: "2026-08-23T00:15:00.000Z",
      createdAt: now,
    });

  test("is usable while fresh and unconsumed", () => {
    expect(isChallengeUsable(challenge(), "2026-08-23T00:05:00.000Z")).toBe(
      true,
    );
  });

  test("consuming marks it used", () => {
    const consumed = consumeEmailAuthChallenge(
      challenge(),
      "2026-08-23T00:05:00.000Z",
    );
    expect(consumed.consumedAt).toBe("2026-08-23T00:05:00.000Z");
    expect(isChallengeUsable(consumed, "2026-08-23T00:06:00.000Z")).toBe(false);
  });

  test("a replayed link is rejected", () => {
    const consumed = consumeEmailAuthChallenge(
      challenge(),
      "2026-08-23T00:05:00.000Z",
    );
    expect(() =>
      consumeEmailAuthChallenge(consumed, "2026-08-23T00:06:00.000Z"),
    ).toThrow(InvalidStateTransitionError);
  });

  test("an expired link is rejected", () => {
    expect(() =>
      consumeEmailAuthChallenge(challenge(), "2026-08-23T00:15:00.000Z"),
    ).toThrow(InvalidStateTransitionError);
  });
});
