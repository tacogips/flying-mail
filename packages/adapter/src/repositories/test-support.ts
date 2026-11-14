import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  createMigrationRunner,
  type MigrationFile,
} from "../migrations/runner";
import { createInMemoryDatabase } from "../sql/libsql";

/** `apps/api/migrations`, resolved relative to this file so tests keep
 * working regardless of the working directory vitest is launched from. */
const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../apps/api/migrations", import.meta.url),
);

export function loadMigrationFiles(
  dir: string = MIGRATIONS_DIR,
): readonly MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf-8") }));
}

/** A fresh in-memory database with the **real** production migrations
 * applied.
 *
 * Repository tests run against the actual schema rather than a hand-written
 * test fixture, so a migration that drifts from what the repositories expect
 * fails here instead of at deploy time. */
export async function createMigratedDatabase(): Promise<SqlDatabase> {
  const db = createInMemoryDatabase();
  const runner = createMigrationRunner(db);
  await runner.apply(loadMigrationFiles());
  return db;
}

/** Ids of the four system tags seeded by `0002_system_tags.sql`. */
export const SYSTEM_TAG_IDS = {
  trash: "tag-trash",
  archived: "tag-archived",
  starred: "tag-starred",
} as const;

/** Inserts a domain directly, bypassing the use case layer, so repository
 * tests can set up foreign-key parents without dragging in the application
 * package. */
export async function seedDomain(
  db: SqlDatabase,
  options: {
    readonly id: string;
    readonly name: string;
    readonly status?: string;
    readonly catchAll?: boolean;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO domains
       (id, name, status, catch_all, verification_token, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'tok', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    [
      options.id,
      options.name,
      options.status ?? "ACTIVE",
      options.catchAll === false ? 0 : 1,
    ],
  );
}

export async function seedUser(
  db: SqlDatabase,
  options: { readonly id: string; readonly email: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO users (id, email, name, role, created_at, updated_at)
     VALUES (?, ?, 'Test User', 'ADMIN', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
    [options.id, options.email],
  );
}

export async function seedApiKey(
  db: SqlDatabase,
  options: { readonly id: string; readonly keyHash: string },
): Promise<void> {
  await db.execute(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
     VALUES (?, 'test key', ?, ?, '2026-08-23T00:00:00.000Z')`,
    [options.id, options.keyHash, `ybm_${options.id}`],
  );
}
