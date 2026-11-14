import type { SessionId, UserId } from "../value-objects/ids";

/** An opaque browser session. Only the SHA-256 hash of the token is stored;
 * the raw token lives in the client's `HttpOnly` cookie and nowhere else. */
export interface Session {
  readonly id: SessionId;
  readonly tokenHash: string;
  readonly userId: UserId;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CreateSessionInput {
  readonly id: SessionId;
  readonly tokenHash: string;
  readonly userId: UserId;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export function createSession(input: CreateSessionInput): Session {
  return {
    id: input.id,
    tokenHash: input.tokenHash,
    userId: input.userId,
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  };
}

export function isSessionExpired(session: Session, now: string): boolean {
  return session.expiresAt <= now;
}
