import { EmailAuthChallengePurpose } from "@flying-mail/domain/entities/email-auth-challenge";
import {
  createUser,
  deactivateUser,
  UserRole,
} from "@flying-mail/domain/entities/user";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import { createUserId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createCreateUserUseCase } from "./users";
import { createResendInvitationUseCase } from "./invitations";

const NOW = "2026-08-23T00:00:00.000Z";
const ADMIN_ID = createUserId("invitation-admin");
const INVITED_ID = createUserId("invited-user");

async function seedAdmin(fake: FakeDependencies): Promise<void> {
  await fake.deps.userRepository.save(
    createUser({
      id: ADMIN_ID,
      email: createEmailAddress("admin@example.com"),
      name: "Admin",
      role: UserRole.Admin,
      invitationAcceptedAt: NOW,
      createdAt: NOW,
    }),
  );
}

function createPendingUser(fake: FakeDependencies, id = INVITED_ID) {
  const user = createUser({
    id,
    email: createEmailAddress("invited@example.com"),
    name: "Invited",
    role: UserRole.Member,
    invitationAcceptedAt: null,
    createdAt: NOW,
  });
  fake.stores.users.set(id, user);
  return user;
}

describe("createUser invitations", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
  });

  test("creates a pending user and sends exactly one invitation with an extractable URL", async () => {
    const result = await createCreateUserUseCase(fake.deps)(
      adminViewer(ADMIN_ID),
      {
        email: "new.member@example.com",
        name: "New Member",
        role: UserRole.Member,
      },
    );
    expect(result.user.invitationAcceptedAt).toBeNull();
    expect(fake.mailSender.sent).toHaveLength(1);
    expect(fake.mailSender.sent[0]?.to).toEqual(["new.member@example.com"]);
    expect(fake.mailSender.sent[0]?.subject).toBe(
      "You have been invited to flying-mail",
    );
    expect(fake.mailSender.sent[0]?.text).toMatch(
      /^https:\/\/mail\.example\.com\/auth\/verify\?token=\S+$/m,
    );
    const url = fake.mailSender.sent[0]?.text.match(/^https:\/\/\S+$/m)?.[0];
    expect(url).toBeDefined();
    expect(fake.mailSender.sent[0]?.html).toContain(
      `<a href="${url}">${url}</a>`,
    );
    const challenge = [...fake.stores.challenges.values()][0];
    expect(challenge?.purpose).toBe(EmailAuthChallengePurpose.Invitation);
    expect(challenge?.expiresAt).toBe("2026-08-30T00:00:00.000Z");
  });

  test.each([
    [86400, "This link expires in 1 day and can be used once."],
    [90000, "This link expires in 25 hours and can be used once."],
  ])("formats expiry wording for TTL %i", async (inviteTtlSeconds, wording) => {
    const configured = createFakeDependencies({
      now: NOW,
      instanceConfig: { inviteTtlSeconds },
    });
    await seedAdmin(configured);
    await createCreateUserUseCase(configured.deps)(adminViewer(ADMIN_ID), {
      email: "new.member@example.com",
      name: "New Member",
      role: UserRole.Member,
    });
    expect(configured.mailSender.sent[0]?.text).toContain(wording);
  });

  test("checks mail configuration before user lookup or writes", async () => {
    const unconfigured = createFakeDependencies({
      now: NOW,
      instanceConfig: { mailFrom: null },
    });
    await seedAdmin(unconfigured);
    const findByEmail = vi.spyOn(
      unconfigured.deps.userRepository,
      "findByEmail",
    );
    await expect(
      createCreateUserUseCase(unconfigured.deps)(adminViewer(ADMIN_ID), {
        email: "new.member@example.com",
        name: "New Member",
        role: UserRole.Member,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(findByEmail).not.toHaveBeenCalled();
    expect(unconfigured.stores.users.size).toBe(1);
    expect(unconfigured.stores.challenges.size).toBe(0);
  });

  test("a mail send failure leaves the user pending and resendable", async () => {
    fake.mailSender.failNext(new Error("provider failed"));
    await expect(
      createCreateUserUseCase(fake.deps)(adminViewer(ADMIN_ID), {
        email: "new.member@example.com",
        name: "New Member",
        role: UserRole.Member,
      }),
    ).rejects.toThrow("provider failed");
    const user = await fake.deps.userRepository.findByEmail(
      createEmailAddress("new.member@example.com"),
    );
    expect(user?.invitationAcceptedAt).toBeNull();
    expect(fake.stores.challenges.size).toBe(1);
    await expect(
      createResendInvitationUseCase(fake.deps)(
        adminViewer(ADMIN_ID),
        user?.id ?? INVITED_ID,
      ),
    ).resolves.toMatchObject({ user: { invitationAcceptedAt: null } });
    expect(fake.mailSender.sent).toHaveLength(1);
  });
});

describe("resendInvitation", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await seedAdmin(fake);
  });

  test("resends to a pending user", async () => {
    const user = createPendingUser(fake);
    const resend = createResendInvitationUseCase(fake.deps);
    await expect(resend(adminViewer(ADMIN_ID), user.id)).resolves.toMatchObject(
      { user },
    );
    expect(fake.mailSender.sent).toHaveLength(1);
    expect([...fake.stores.challenges.values()][0]?.purpose).toBe(
      EmailAuthChallengePurpose.Invitation,
    );
  });

  test("rejects accepted, deactivated and unknown users", async () => {
    const accepted = createPendingUser(fake, createUserId("accepted-user"));
    await fake.deps.userRepository.save({
      ...accepted,
      invitationAcceptedAt: NOW,
    });
    const inactive = deactivateUser(
      createPendingUser(fake, createUserId("inactive-user")),
      NOW,
    );
    await fake.deps.userRepository.save(inactive);
    const resend = createResendInvitationUseCase(fake.deps);
    await expect(
      resend(adminViewer(ADMIN_ID), accepted.id),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      resend(adminViewer(ADMIN_ID), inactive.id),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      resend(adminViewer(ADMIN_ID), createUserId("missing-user")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("limits the fourth invitation in 24 hours and permits another after the window", async () => {
    const user = createPendingUser(fake);
    const resend = createResendInvitationUseCase(fake.deps);
    for (let index = 0; index < 3; index += 1) {
      await resend(adminViewer(ADMIN_ID), user.id);
    }
    await expect(resend(adminViewer(ADMIN_ID), user.id)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    fake.clock.advanceSeconds(24 * 60 * 60 + 1);
    await expect(resend(adminViewer(ADMIN_ID), user.id)).resolves.toMatchObject(
      { user: { id: user.id } },
    );
  });

  test("requires an admin USER viewer, never an API key", async () => {
    const user = createPendingUser(fake);
    const resend = createResendInvitationUseCase(fake.deps);
    await expect(resend(memberViewer(), user.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(resend(apiKeyViewer([]), user.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
