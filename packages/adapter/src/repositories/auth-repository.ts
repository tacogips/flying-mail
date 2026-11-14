import type {
  EmailAuthChallengeRepository,
  SessionRepository,
  UserRepository,
} from "@mailcal/application/ports/auth-repository";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import type { EmailAuthChallenge } from "@mailcal/domain/entities/email-auth-challenge";
import type { Session } from "@mailcal/domain/entities/session";
import { type User, UserRole } from "@mailcal/domain/entities/user";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createEmailAuthChallengeId,
  createSessionId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { assertEnumValue } from "./sql-helpers";

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deactivated_at: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: createUserId(row.id),
    email: createEmailAddress(row.email),
    name: row.name,
    role: assertEnumValue(UserRole, row.role, "user role"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deactivatedAt: row.deactivated_at,
  };
}

const UPSERT_USER_SQL = `INSERT INTO users
  (id, email, name, role, created_at, updated_at, deactivated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    name = excluded.name,
    role = excluded.role,
    updated_at = excluded.updated_at,
    deactivated_at = excluded.deactivated_at`;

export function createUserRepository(db: SqlDatabase): UserRepository {
  return {
    async findById(id) {
      const rows = await db.query<UserRow>("SELECT * FROM users WHERE id = ?", [
        id,
      ]);
      return rows[0] === undefined ? null : rowToUser(rows[0]);
    },

    async findByEmail(email) {
      const rows = await db.query<UserRow>(
        "SELECT * FROM users WHERE email = ?",
        [email],
      );
      return rows[0] === undefined ? null : rowToUser(rows[0]);
    },

    async list() {
      const rows = await db.query<UserRow>(
        "SELECT * FROM users ORDER BY created_at ASC",
      );
      return rows.map(rowToUser);
    },

    async count() {
      const rows = await db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users",
      );
      return rows[0]?.count ?? 0;
    },

    async save(user) {
      await db.execute(UPSERT_USER_SQL, [
        user.id,
        user.email,
        user.name,
        user.role,
        user.createdAt,
        user.updatedAt,
        user.deactivatedAt,
      ]);
    },

    async createFirstUser(user) {
      // `INSERT ... SELECT ... WHERE NOT EXISTS` folds the emptiness check
      // into the insert itself: of N racing bootstrap calls, exactly one
      // observes an empty table inside its own statement and wins.
      const result = await db.execute(
        `INSERT INTO users (id, email, name, role, created_at, updated_at, deactivated_at)
         SELECT ?, ?, ?, ?, ?, ?, NULL
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
        [
          user.id,
          user.email,
          user.name,
          user.role,
          user.createdAt,
          user.updatedAt,
        ],
      );
      return result.rowsAffected > 0;
    },
  };
}

interface SessionRow {
  readonly id: string;
  readonly token_hash: string;
  readonly user_id: string;
  readonly expires_at: string;
  readonly created_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: createSessionId(row.id),
    tokenHash: row.token_hash,
    userId: createUserId(row.user_id),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function createSessionRepository(db: SqlDatabase): SessionRepository {
  return {
    async findByTokenHash(tokenHash) {
      const rows = await db.query<SessionRow>(
        "SELECT * FROM sessions WHERE token_hash = ?",
        [tokenHash],
      );
      return rows[0] === undefined ? null : rowToSession(rows[0]);
    },

    async save(session) {
      await db.execute(
        `INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at`,
        [
          session.id,
          session.tokenHash,
          session.userId,
          session.expiresAt,
          session.createdAt,
        ],
      );
    },

    async delete(id) {
      await db.execute("DELETE FROM sessions WHERE id = ?", [id]);
    },

    async deleteByTokenHash(tokenHash) {
      await db.execute("DELETE FROM sessions WHERE token_hash = ?", [
        tokenHash,
      ]);
    },

    async deleteExpired(now) {
      const result = await db.execute(
        "DELETE FROM sessions WHERE expires_at <= ?",
        [now],
      );
      return result.rowsAffected;
    },
  };
}

interface ChallengeRow {
  readonly id: string;
  readonly email: string;
  readonly token_hash: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly created_at: string;
}

function rowToChallenge(row: ChallengeRow): EmailAuthChallenge {
  return {
    id: createEmailAuthChallengeId(row.id),
    email: createEmailAddress(row.email),
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

export function createEmailAuthChallengeRepository(
  db: SqlDatabase,
): EmailAuthChallengeRepository {
  return {
    async findById(id) {
      const rows = await db.query<ChallengeRow>(
        "SELECT * FROM email_auth_challenges WHERE id = ?",
        [id],
      );
      return rows[0] === undefined ? null : rowToChallenge(rows[0]);
    },

    async findByTokenHash(tokenHash) {
      const rows = await db.query<ChallengeRow>(
        "SELECT * FROM email_auth_challenges WHERE token_hash = ?",
        [tokenHash],
      );
      return rows[0] === undefined ? null : rowToChallenge(rows[0]);
    },

    async countRecentByEmail(email, since) {
      const rows = await db.query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM email_auth_challenges
         WHERE email = ? AND created_at >= ?`,
        [email, since],
      );
      return rows[0]?.count ?? 0;
    },

    async save(challenge) {
      await db.execute(
        `INSERT INTO email_auth_challenges
           (id, email, token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET consumed_at = excluded.consumed_at`,
        [
          challenge.id,
          challenge.email,
          challenge.tokenHash,
          challenge.expiresAt,
          challenge.consumedAt,
          challenge.createdAt,
        ],
      );
    },

    async deleteExpired(now) {
      const result = await db.execute(
        "DELETE FROM email_auth_challenges WHERE expires_at <= ?",
        [now],
      );
      return result.rowsAffected;
    },
  };
}
