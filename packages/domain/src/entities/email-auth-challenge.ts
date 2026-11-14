import { InvalidStateTransitionError } from "../errors";
import type { EmailAddress } from "../value-objects/email-address";
import type { EmailAuthChallengeId } from "../value-objects/ids";

/** A single-use, short-lived passwordless login token. Only the token's
 * SHA-256 hash is stored, so the database never holds a usable credential. */
export interface EmailAuthChallenge {
  readonly id: EmailAuthChallengeId;
  readonly email: EmailAddress;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface CreateEmailAuthChallengeInput {
  readonly id: EmailAuthChallengeId;
  readonly email: EmailAddress;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export function createEmailAuthChallenge(
  input: CreateEmailAuthChallengeInput,
): EmailAuthChallenge {
  return {
    id: input.id,
    email: input.email,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    consumedAt: null,
    createdAt: input.createdAt,
  };
}

export function isChallengeUsable(
  challenge: EmailAuthChallenge,
  now: string,
): boolean {
  return challenge.consumedAt === null && challenge.expiresAt > now;
}

/** Marks the challenge used. Throws for an expired or already-consumed
 * challenge rather than returning a flag, so a replayed login link cannot
 * pass unnoticed through a caller that forgot to check. */
export function consumeEmailAuthChallenge(
  challenge: EmailAuthChallenge,
  now: string,
): EmailAuthChallenge {
  if (challenge.consumedAt !== null) {
    throw new InvalidStateTransitionError(
      "Login link has already been used",
      "CONSUMED",
      "CONSUMED",
    );
  }
  if (challenge.expiresAt <= now) {
    throw new InvalidStateTransitionError(
      "Login link has expired",
      "EXPIRED",
      "CONSUMED",
    );
  }
  return { ...challenge, consumedAt: now };
}
