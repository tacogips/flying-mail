import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { MigrationFile } from "@flying-mail/adapter/migrations/runner";
import { createMigrationRunner } from "@flying-mail/adapter/migrations/runner";
import { drainBlobCleanupQueue } from "@flying-mail/adapter/migrations/blob-cleanup";
import {
  AUTH_RATE_LIMIT,
  createInMemoryRateLimiter,
} from "@flying-mail/adapter/rate-limit/in-memory";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import {
  createUseCases,
  type UseCases,
} from "@flying-mail/application/usecases";
import { buildDependencies } from "@flying-mail/infrastructure/composition/build-dependencies";
import {
  loadConfigFromEnv,
  normalizeClientIpForRateLimit,
} from "@flying-mail/infrastructure/composition/config";
import { createApp } from "@flying-mail/infrastructure/http/app";
import type { AuthVariables } from "@flying-mail/infrastructure/http/auth-middleware";
import type { Context, Hono } from "hono";

/** Retry policy for local post-migration blob cleanup. */
export interface BlobCleanupRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface ServerConfig {
  readonly port: number;
  readonly migrationsDir: string;
}

const DEFAULT_PORT = 8787;
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** `Bun.serve` when running under Bun (faster, no extra dependency);
 * `@hono/node-server` otherwise, so the same file also runs under plain
 * Node. `typeof Bun` is a safe existence check on both: it evaluates to
 * `"undefined"` under Node rather than throwing. */
export function detectRuntime(): "bun" | "node" {
  return typeof Bun === "undefined" ? "node" : "bun";
}

function loadMigrationFiles(dir: string): readonly MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf-8") }));
}

/** `@libsql/client` does not create missing parent directories for a
 * `file:` URL -- it errors instead -- so the default `file:./data/mailcal.db`
 * would fail on a clean checkout. A no-op for `:memory:` and non-`file:`
 * URLs. The value is already normalized by `loadConfigFromEnv`, so a bare
 * path has become `file:...` by the time it reaches here. */
function ensureSqliteDirectoryExists(sqliteUrl: string): void {
  if (!sqliteUrl.startsWith("file:")) {
    return;
  }
  const filePath = sqliteUrl.slice("file:".length);
  if (filePath.length === 0 || filePath === ":memory:") {
    return;
  }
  const dir = dirname(filePath);
  if (dir !== "." && dir !== "") {
    mkdirSync(dir, { recursive: true });
  }
}

/** Local development has no SMTP path, so this route feeds a raw `.eml`
 * body through the *identical* ingest use case the Workers `email()`
 * handler uses.
 *
 * Registered only when GraphiQL is on -- i.e. never in production. It
 * accepts an unauthenticated raw message by design, which is precisely what
 * makes it useful locally and unacceptable anywhere else. */
function createDevInboundHandler(
  usecases: UseCases,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (from === undefined || to === undefined) {
      return Response.json(
        { error: "Both ?from= and ?to= query parameters are required" },
        { status: 400 },
      );
    }
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const result = await usecases.receiveMessage({
      envelopeFrom: from,
      envelopeTo: to,
      raw,
      rawSize: raw.length,
      headers: new Map(),
    });
    return result.kind === "REJECTED"
      ? Response.json({ rejected: result.reason }, { status: 422 })
      : Response.json({
          kind: result.kind,
          messageId: result.message.id,
          subject: result.message.subject,
        });
  };
}

export interface LocalApp {
  readonly app: Hono<{ Variables: AuthVariables }>;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  /** Resolves when the bounded background cleanup finishes. */
  readonly blobCleanup: Promise<void>;
}

const DEFAULT_CLEANUP_MAX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_BASE_DELAY_MS = 100;

interface LocalRequestEnvironment {
  readonly clientIp?: string | null;
  readonly incoming?: {
    readonly socket?: { readonly remoteAddress?: string };
  };
}

/** Reads only the peer address supplied by Bun or the Node server adapter. */
function resolveLocalClientIp(c: Context): string | null {
  const runtimeEnvironment: unknown = c.env;
  if (typeof runtimeEnvironment !== "object" || runtimeEnvironment === null) {
    return null;
  }
  const environment = runtimeEnvironment as LocalRequestEnvironment;
  if (environment.clientIp !== undefined) {
    return normalizeClientIpForRateLimit(environment.clientIp);
  }
  const incoming = environment.incoming;
  if (incoming === undefined || incoming.socket === undefined) {
    return null;
  }
  return normalizeClientIpForRateLimit(incoming.socket.remoteAddress ?? null);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Drains the durable cleanup queue with bounded exponential backoff. */
export async function drainBlobCleanupQueueWithRetry(
  db: AppDependencies["db"],
  blobs: AppDependencies["blobs"],
  options: BlobCleanupRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_CLEANUP_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_CLEANUP_BASE_DELAY_MS;
  const wait = options.sleep ?? sleep;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError(
      "Blob cleanup max attempts must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new RangeError(
      "Blob cleanup base delay must be a non-negative integer",
    );
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await drainBlobCleanupQueue(db, blobs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await wait(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

/** Builds the local app: config from `process.env`, every pending migration
 * applied, system tags seeded, then the hono app with GraphiQL on.
 *
 * Split out from {@link startServer} (which additionally binds a port) so
 * "migrations run before the app serves a single request" is testable
 * without opening a network listener. */
export async function createLocalApp(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<LocalApp> {
  const config = {
    ...loadConfigFromEnv(process.env),
    rateLimiter: createInMemoryRateLimiter({
      ...AUTH_RATE_LIMIT,
      clock: { now: () => new Date() },
    }),
  };
  if (config.sqlBackend === "sqlite" && config.sqliteUrl !== undefined) {
    ensureSqliteDirectoryExists(config.sqliteUrl);
  }
  const deps = buildDependencies(config);

  const runner = createMigrationRunner(deps.db);
  const { applied } = await runner.apply(loadMigrationFiles(migrationsDir));
  if (applied.length > 0) {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }
  // Cleanup is durable and independent of request serving. Start it eagerly,
  // but do not hold startup hostage to a temporarily unavailable blob store.
  const blobCleanup = drainBlobCleanupQueueWithRetry(deps.db, deps.blobs).catch(
    (error: unknown) => {
      console.error(
        "Failed to drain the post-migration blob cleanup queue after retries",
        error,
      );
    },
  );

  const usecases = createUseCases(deps);
  // Idempotent: creates only the system tags a migration has not already
  // seeded, which keeps a hand-migrated database consistent too.
  await usecases.ensureSystemTags();

  const app = createApp({
    deps,
    usecases,
    graphiql: true,
    devInbound: createDevInboundHandler(usecases),
    resolveClientIp: resolveLocalClientIp,
  });
  return { app, deps, usecases, blobCleanup };
}

export async function startServer(
  config?: Partial<ServerConfig>,
): Promise<void> {
  const port = config?.port ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  const migrationsDir = config?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  const { app } = await createLocalApp(migrationsDir);

  const runtime = detectRuntime();
  if (runtime === "bun") {
    Bun.serve({
      port,
      fetch: (request, server) =>
        app.fetch(request, {
          clientIp: server.requestIP(request)?.address ?? null,
        }),
    });
  } else {
    serve({ fetch: app.fetch, port });
  }
  console.log(
    `flying-mail-api listening on http://localhost:${port} (${runtime})`,
  );
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void startServer();
}
