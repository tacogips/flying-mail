import type { EmailAuthChallenge } from "@flying-mail/domain/entities/email-auth-challenge";
import type { Session } from "@flying-mail/domain/entities/session";
import type { User } from "@flying-mail/domain/entities/user";
import type { EmailAddress } from "@flying-mail/domain/value-objects/email-address";
import type {
  EmailAuthChallengeId,
  SessionId,
  UserId,
} from "@flying-mail/domain/value-objects/ids";

export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: EmailAddress): Promise<User | null>;
  list(): Promise<readonly User[]>;
  count(): Promise<number>;
  save(user: User): Promise<void>;
  /** Inserts `user` iff the table is empty, atomically, and reports whether
   * the insert happened. Backs the one-shot bootstrap: a count-then-save
   * pair would let two concurrent bootstrap calls both pass the emptiness
   * check on a store with no interactive transactions. */
  createFirstUser(user: User): Promise<boolean>;
}

export interface SessionRepository {
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: SessionId): Promise<void>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}

export interface EmailAuthChallengeRepository {
  findById(id: EmailAuthChallengeId): Promise<EmailAuthChallenge | null>;
  findByTokenHash(tokenHash: string): Promise<EmailAuthChallenge | null>;
  /** Challenges issued to `email` since `since`, consumed or not. Backs the
   * login-link throttle. */
  countRecentByEmail(email: EmailAddress, since: string): Promise<number>;
  save(challenge: EmailAuthChallenge): Promise<void>;
  deleteExpired(now: string): Promise<number>;
}
