import {
  EmailAuthChallengePurpose,
  createEmailAuthChallenge,
} from "@flying-mail/domain/entities/email-auth-challenge";
import type { User } from "@flying-mail/domain/entities/user";
import {
  createEmailAuthChallengeId,
  type UserId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError, RateLimitedError } from "../errors";
import type { Viewer } from "../policies/viewer";
import {
  loadUserWithPermissions,
  requireAdminUser,
  type UserWithPermissions,
} from "./auth-guards";
import {
  requireMailConfigured,
  toBase64Url,
  type MailConfiguration,
} from "./email-auth";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

const TOKEN_BYTES = 32;
const INVITATION_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_INVITATIONS_PER_WINDOW = 3;

function expiryWording(ttlSeconds: number): string {
  if (ttlSeconds % 86400 === 0) {
    const days = ttlSeconds / 86400;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  const hours = Math.ceil(ttlSeconds / 3600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export async function issueInvitation(
  deps: AppDependencies,
  mail: MailConfiguration,
  user: User,
): Promise<void> {
  const now = deps.clock.now();
  const token = toBase64Url(deps.random.tokenBytes(TOKEN_BYTES));
  const challenge = createEmailAuthChallenge({
    id: createEmailAuthChallengeId(deps.random.uuid()),
    email: user.email,
    purpose: EmailAuthChallengePurpose.Invitation,
    tokenHash: await deps.tokenHasher.hash(token),
    expiresAt: new Date(
      now.getTime() + deps.instanceConfig.inviteTtlSeconds * 1000,
    ).toISOString(),
    createdAt: now.toISOString(),
  });
  await deps.emailAuthChallengeRepository.save(challenge);

  const url = `${mail.origin}/auth/verify?token=${encodeURIComponent(token)}`;
  const expiry = expiryWording(deps.instanceConfig.inviteTtlSeconds);
  await deps.mailSender.send({
    from: mail.from,
    to: [user.email],
    subject: "You have been invited to flying-mail",
    text: `You have been invited to flying-mail. Sign in using this link:\n${url}\n\nThis link expires in ${expiry} and can be used once.`,
    html: `<p>You have been invited to flying-mail.</p><p><a href="${url}">${url}</a></p><p>This link expires in ${expiry} and can be used once.</p>`,
  });
}

export function createResendInvitationUseCase(
  deps: AppDependencies,
): (viewer: Viewer, userId: UserId) => Promise<UserWithPermissions> {
  return async (viewer, userId) =>
    withAsyncDomainErrorTranslation(async () => {
      requireAdminUser(viewer);
      const mail = requireMailConfigured(deps);
      const user = await deps.userRepository.findById(userId);
      if (user === null) {
        throw new NotFoundError("User", userId);
      }
      if (user.deactivatedAt !== null) {
        throw new ConflictError("User is deactivated");
      }
      if (user.invitationAcceptedAt !== null) {
        throw new ConflictError("Invitation already accepted");
      }

      const now = deps.clock.now();
      const windowStart = new Date(
        now.getTime() - INVITATION_WINDOW_SECONDS * 1000,
      ).toISOString();
      const recent = await deps.emailAuthChallengeRepository.countRecentByEmail(
        user.email,
        windowStart,
        EmailAuthChallengePurpose.Invitation,
      );
      if (recent >= MAX_INVITATIONS_PER_WINDOW) {
        throw new RateLimitedError(
          "An invitation was sent to this user too many times recently; try again later",
        );
      }
      await issueInvitation(deps, mail, user);
      return loadUserWithPermissions(deps, user);
    });
}
