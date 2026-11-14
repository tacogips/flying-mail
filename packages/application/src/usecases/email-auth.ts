import {
  consumeEmailAuthChallenge,
  createEmailAuthChallenge,
} from "@mailcal/domain/entities/email-auth-challenge";
import {
  type ApiKey,
  Capability,
  createApiKey,
  createApiKeyScope,
} from "@mailcal/domain/entities/api-key";
import { createSession, type Session } from "@mailcal/domain/entities/session";
import { MATCH_ALL_ADDRESSES } from "@mailcal/domain/value-objects/address-pattern";
import {
  createUser,
  isUserActive,
  type User,
  UserRole,
} from "@mailcal/domain/entities/user";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createEmailAuthChallengeId,
  createSessionId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import {
  ConflictError,
  ServiceUnavailableError,
  UnauthenticatedError,
} from "../errors";
import { generateApiKeySecret } from "./api-keys";
import { withAsyncDomainErrorTranslation } from "./translate-domain-error";

const CHALLENGE_TTL_SECONDS = 15 * 60;
/** At most this many login links per address per TTL window. Three covers
 * every honest "the mail has not arrived yet" retry; anything past it is a
 * mail bomb or a script, and each excess request would burn provider send
 * quota against a victim who never asked for it. */
const MAX_CHALLENGES_PER_WINDOW = 3;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_BYTES = 32;

export interface EmailAuthSession {
  readonly session: Session;
  /** Returned once so the caller can set the cookie; only its hash is stored. */
  readonly token: string;
  readonly user: User;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

interface MailConfiguration {
  readonly origin: string;
  readonly from: string;
}

/** Passwordless login needs both a public origin (so the emailed link
 * resolves) and a verified sender (so the mail is accepted). Missing either
 * is an operator problem, and saying so plainly beats mailing a link that
 * cannot work or letting the provider reject the send opaquely. */
function requireMailConfigured(deps: AppDependencies): MailConfiguration {
  const origin = deps.instanceConfig.publicOrigin;
  const from = deps.instanceConfig.mailFrom;
  if (origin === null || from === null) {
    throw new ServiceUnavailableError(
      "Passwordless login is not configured on this server",
    );
  }
  return { origin, from };
}

/** Requests a login link.
 *
 * **Always returns `true`**, whether or not the address belongs to a user.
 * That is deliberate: a truthful answer would turn this endpoint into a
 * user-enumeration oracle for anyone who can reach it. */
export function createRequestEmailAuthUseCase(
  deps: AppDependencies,
): (email: string) => Promise<boolean> {
  return async (rawEmail) =>
    withAsyncDomainErrorTranslation(async () => {
      const mail = requireMailConfigured(deps);
      const email = createEmailAddress(rawEmail, "email");
      const user = await deps.userRepository.findByEmail(email);
      if (user === null || !isUserActive(user)) {
        return true;
      }

      const now = deps.clock.now();
      // Throttle: silently stop issuing once the window is saturated. The
      // response stays `true` -- a distinguishable throttle answer would
      // reintroduce the user-enumeration oracle this endpoint's uniform
      // response exists to close, and the victim of a mail bomb is better
      // served by silence than by N more messages.
      const windowStart = new Date(
        now.getTime() - CHALLENGE_TTL_SECONDS * 1000,
      ).toISOString();
      const recent = await deps.emailAuthChallengeRepository.countRecentByEmail(
        email,
        windowStart,
      );
      if (recent >= MAX_CHALLENGES_PER_WINDOW) {
        return true;
      }

      const token = toBase64Url(deps.random.tokenBytes(TOKEN_BYTES));
      const challenge = createEmailAuthChallenge({
        id: createEmailAuthChallengeId(deps.random.uuid()),
        email,
        tokenHash: await deps.tokenHasher.hash(token),
        expiresAt: new Date(
          now.getTime() + CHALLENGE_TTL_SECONDS * 1000,
        ).toISOString(),
        createdAt: now.toISOString(),
      });
      await deps.emailAuthChallengeRepository.save(challenge);

      const url = `${mail.origin}/auth/verify?token=${encodeURIComponent(token)}`;
      await deps.mailSender.send({
        from: mail.from,
        to: [email],
        subject: "Your mailcal sign-in link",
        text: `Sign in to mailcal:\n\n${url}\n\nThis link expires in 15 minutes and can be used once.`,
        html: `<p>Sign in to mailcal:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
      });
      return true;
    });
}

/** Exchanges a login token for a session. A replayed or expired token is
 * rejected as `UNAUTHENTICATED` rather than with a distinguishing message,
 * so a token cannot be probed for validity separately from freshness. */
export function createVerifyEmailAuthTokenUseCase(
  deps: AppDependencies,
): (token: string) => Promise<EmailAuthSession> {
  return async (token) =>
    withAsyncDomainErrorTranslation(async () => {
      const invalid = (): never => {
        throw new UnauthenticatedError("This sign-in link is not valid");
      };
      if (token.length === 0) {
        return invalid();
      }
      const tokenHash = await deps.tokenHasher.hash(token);
      const challenge =
        await deps.emailAuthChallengeRepository.findByTokenHash(tokenHash);
      if (challenge === null) {
        return invalid();
      }

      const now = deps.clock.now();
      const nowIso = now.toISOString();
      let consumed: ReturnType<typeof consumeEmailAuthChallenge>;
      try {
        consumed = consumeEmailAuthChallenge(challenge, nowIso);
      } catch {
        return invalid();
      }
      await deps.emailAuthChallengeRepository.save(consumed);

      const user = await deps.userRepository.findByEmail(challenge.email);
      if (user === null || !isUserActive(user)) {
        return invalid();
      }

      const sessionToken = toBase64Url(deps.random.tokenBytes(TOKEN_BYTES));
      const session = createSession({
        id: createSessionId(deps.random.uuid()),
        tokenHash: await deps.tokenHasher.hash(sessionToken),
        userId: user.id,
        expiresAt: new Date(
          now.getTime() + SESSION_TTL_SECONDS * 1000,
        ).toISOString(),
        createdAt: nowIso,
      });
      await deps.sessionRepository.save(session);
      return { session, token: sessionToken, user };
    });
}

export interface BootstrapResult {
  readonly user: User;
  readonly apiKey: ApiKey;
  /** Returned exactly once. */
  readonly secret: string;
}

/** Creates the very first `ADMIN` user **and** a full-capability API key for
 * them. Succeeds only while the instance has no users at all.
 *
 * The key is not a convenience: a freshly deployed Worker has no shell, and
 * passwordless login needs a verified sending domain -- which itself needs
 * an authenticated admin to add. Handing back a credential is what makes the
 * instance operable at all, and it closes the same one-shot door. */
export function createBootstrapAdminUseCase(
  deps: AppDependencies,
): (email: string, name: string) => Promise<BootstrapResult> {
  return async (rawEmail, name) =>
    withAsyncDomainErrorTranslation(async () => {
      const now = deps.clock.now().toISOString();
      const user = createUser({
        id: createUserId(deps.random.uuid()),
        email: createEmailAddress(rawEmail, "email"),
        name,
        role: UserRole.Admin,
        createdAt: now,
      });
      // The emptiness check lives inside the insert statement itself, so
      // two concurrent bootstrap calls cannot both become the first admin
      // -- exactly one of them wins the race, the other gets this conflict.
      const won = await deps.userRepository.createFirstUser(user);
      if (!won) {
        throw new ConflictError(
          "This instance already has users; bootstrap is only available on an empty instance",
        );
      }

      const generated = await generateApiKeySecret(deps);
      const apiKeyId = createApiKeyId(deps.random.uuid());
      const apiKey = createApiKey({
        id: apiKeyId,
        name: "bootstrap admin key",
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        createdByUserId: user.id,
        expiresAt: null,
        createdAt: now,
      });
      await deps.apiKeyRepository.save(apiKey);

      // Every capability, unrestricted: this is the operator's root
      // credential, and narrowing it here would just block the setup it
      // exists to perform. It can be revoked once scoped keys are issued.
      for (const capability of Object.values(Capability)) {
        await deps.apiKeyRepository.saveScope(
          createApiKeyScope({
            id: createApiKeyScopeId(deps.random.uuid()),
            apiKeyId,
            capability,
            domainId: null,
            addressPattern: MATCH_ALL_ADDRESSES,
          }),
        );
      }

      return { user, apiKey, secret: generated.secret };
    });
}

/** How long a staged upload may sit unbound before the sweep reclaims it.
 * Long enough for any honest compose flow, short enough that abandoned
 * uploads cannot accumulate storage indefinitely. */
const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Best-effort cleanup of everything that expires: sessions, login
 * challenges, file links past their TTL, and staged attachment uploads
 * that were never bound to a send (their blobs included -- otherwise R2
 * fills with orphans no row points at). Every branch swallows its own
 * failure; cleanup must never affect the request that triggered it. */
export function createSweepExpiredAuthUseCase(
  deps: AppDependencies,
): () => Promise<void> {
  return async () => {
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    const stagedCutoff = new Date(
      now.getTime() - STAGED_ATTACHMENT_TTL_MS,
    ).toISOString();

    const sweepStaged = async (): Promise<void> => {
      const stale =
        await deps.messageRepository.listStaleStagedAttachments(stagedCutoff);
      if (stale.length === 0) {
        return;
      }
      // Blobs first: if a blob delete fails, the surviving row keeps the
      // orphan discoverable for the next sweep. The reverse order would
      // strand unreferenced blobs forever.
      await Promise.all(
        stale.map((attachment) =>
          deps.blobs.delete(attachment.blobKey).catch(() => undefined),
        ),
      );
      await deps.messageRepository.deleteAttachments(
        stale.map((attachment) => attachment.id),
      );
    };

    await Promise.all([
      deps.sessionRepository.deleteExpired(nowIso).catch(() => 0),
      deps.emailAuthChallengeRepository.deleteExpired(nowIso).catch(() => 0),
      deps.fileLinkRepository.deleteExpired(nowIso).catch(() => 0),
      sweepStaged().catch(() => undefined),
    ]);
  };
}
