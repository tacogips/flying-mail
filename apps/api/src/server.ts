import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { MigrationFile } from "@mailcal/adapter/migrations/runner";
import { createMigrationRunner } from "@mailcal/adapter/migrations/runner";
import type { AppDependencies } from "@mailcal/application/dependencies";
import { createUseCases, type UseCases } from "@mailcal/application/usecases";
import { buildDependencies } from "@mailcal/infrastructure/composition/build-dependencies";
import { loadConfigFromEnv } from "@mailcal/infrastructure/composition/config";
import { createApp } from "@mailcal/infrastructure/http/app";
import type { AuthVariables } from "@mailcal/infrastructure/http/auth-middleware";
import type { Context, Hono } from "hono";

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
  const config = loadConfigFromEnv(process.env);
  if (config.sqlBackend === "sqlite" && config.sqliteUrl !== undefined) {
    ensureSqliteDirectoryExists(config.sqliteUrl);
  }
  const deps = buildDependencies(config);

  const runner = createMigrationRunner(deps.db);
  const { applied } = await runner.apply(loadMigrationFiles(migrationsDir));
  if (applied.length > 0) {
    console.log(`Applied migrations: ${applied.join(", ")}`);
  }

  const usecases = createUseCases(deps);
  // Idempotent: creates only the system tags a migration has not already
  // seeded, which keeps a hand-migrated database consistent too.
  await usecases.ensureSystemTags();

  const app = createApp({
    deps,
    usecases,
    graphiql: true,
    devInbound: createDevInboundHandler(usecases),
  });
  return { app, deps, usecases };
}

export async function startServer(
  config?: Partial<ServerConfig>,
): Promise<void> {
  const port = config?.port ?? Number(process.env["PORT"] ?? DEFAULT_PORT);
  const migrationsDir = config?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  const { app } = await createLocalApp(migrationsDir);

  const runtime = detectRuntime();
  if (runtime === "bun") {
    Bun.serve({ port, fetch: app.fetch });
  } else {
    serve({ fetch: app.fetch, port });
  }
  console.log(`mailcal-api listening on http://localhost:${port} (${runtime})`);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  void startServer();
}
