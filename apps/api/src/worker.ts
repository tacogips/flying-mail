import {
  createUseCases,
  type UseCases,
} from "@flying-mail/application/usecases";
import { drainBlobCleanupQueue } from "@flying-mail/adapter/migrations/blob-cleanup";
import { createWorkersRateLimiter } from "@flying-mail/adapter/rate-limit/workers-binding";
import type { BlobStore } from "@flying-mail/application/ports/blob-store";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { buildDependencies } from "@flying-mail/infrastructure/composition/build-dependencies";
import {
  assertMailOriginConsistency,
  type BuildDependenciesConfig,
  resolveBlobBackend,
  resolveBootstrapToken,
  resolveCredentialKey,
  resolveFileLinkMaxTtl,
  resolveInviteTtlSeconds,
  resolveInboundMxSuffix,
  resolveEmailSendingAccountId,
  resolveEmailSendingToken,
  resolveMailFrom,
  resolvePublicOrigin,
  resolveS3Config,
  resolveSpamPhrases,
  resolveSpamThreshold,
  resolveTurnstileConfig,
  normalizeClientIpForRateLimit,
} from "@flying-mail/infrastructure/composition/config";
import { createApp } from "@flying-mail/infrastructure/http/app";
import type { AuthVariables } from "@flying-mail/infrastructure/http/auth-middleware";
import type { Hono } from "hono";
import {
  type Env,
  envToRecord,
  type ExecutionContextLike,
  type ForwardableEmailMessageLike,
  headersToMap,
} from "./env";

/** Builds the composition config from Workers bindings and vars.
 *
 * Throws `PublicOriginConfigurationError` / `MailConfigurationError` for a
 * set-but-invalid `FLYING_MAIL_PUBLIC_ORIGIN`, or a `FLYING_MAIL_MAIL_FROM` with no
 * resolvable origin -- both deployment mistakes that would otherwise
 * silently disable passwordless login. Exported for unit testing. */
export function buildWorkerConfig(env: Env): BuildDependenciesConfig {
  const record = envToRecord(env);
  const blobBackend = resolveBlobBackend(record);
  const publicOrigin = resolvePublicOrigin(record);
  const mailFrom = resolveMailFrom(record);
  assertMailOriginConsistency({ mailFrom, publicOrigin });
  const credentialKey = resolveCredentialKey(record);
  const emailSendingAccountId = resolveEmailSendingAccountId(record);
  const emailSendingToken = resolveEmailSendingToken(record);
  const bootstrapToken = resolveBootstrapToken(record);
  const turnstile = resolveTurnstileConfig(record, publicOrigin);

  return {
    sqlBackend: "d1",
    d1: env.DB,
    blobBackend,
    spamThreshold: resolveSpamThreshold(record),
    spamPhrases: resolveSpamPhrases(record),
    fileLinkMaxTtlSeconds: resolveFileLinkMaxTtl(record),
    inviteTtlSeconds: resolveInviteTtlSeconds(record),
    inboundMxSuffix: resolveInboundMxSuffix(record),
    email: env.EMAIL,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(mailFrom === undefined ? {} : { mailFrom }),
    ...(blobBackend === "r2" ? { r2: env.BLOB } : {}),
    ...(blobBackend === "s3" ? { s3: resolveS3Config(record) } : {}),
    ...(credentialKey === undefined ? {} : { credentialKey }),
    ...(emailSendingAccountId === undefined ? {} : { emailSendingAccountId }),
    ...(emailSendingToken === undefined ? {} : { emailSendingToken }),
    ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
    ...(turnstile === undefined ? {} : { turnstile }),
    ...(env.AUTH_RATE_LIMITER === undefined
      ? {}
      : { rateLimiter: createWorkersRateLimiter(env.AUTH_RATE_LIMITER) }),
  };
}

type WorkerApp = Hono<{ Variables: AuthVariables }>;

interface BuiltWorker {
  readonly app: WorkerApp;
  readonly usecases: UseCases;
  readonly cleanupBlobs: () => Promise<void>;
}

function createBlobCleanupScheduler(
  db: SqlDatabase,
  blobs: BlobStore,
): () => Promise<void> {
  let complete = false;
  let inFlight: Promise<void> | null = null;
  return (): Promise<void> => {
    if (complete) {
      return Promise.resolve();
    }
    if (inFlight !== null) {
      return inFlight;
    }
    const attempt = drainBlobCleanupQueue(db, blobs)
      .then(() => {
        complete = true;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  };
}

/** Per-isolate cache keyed by the Workers `env` object, which is a stable
 * reference across requests within one isolate.
 *
 * Rebuilding dependencies, use cases and the hono app (which itself reuses a
 * cached GraphQL schema) on every request is pure overhead: none of it
 * depends on the request, only on `env`. A *failed* build is deliberately
 * never cached, so a misconfigured deployment retries construction on the
 * next request instead of staying wedged until the next cold start. */
const workerCache = new WeakMap<Env, BuiltWorker>();

function getOrBuildWorker(env: Env): BuiltWorker {
  const cached = workerCache.get(env);
  if (cached !== undefined) {
    return cached;
  }
  const deps = buildDependencies(buildWorkerConfig(env));
  const usecases = createUseCases(deps);
  const app = createApp({
    deps,
    usecases,
    graphiql: false,
    resolveClientIp: (c) =>
      normalizeClientIpForRateLimit(
        c.req.header("cf-connecting-ip")?.trim() || null,
      ),
    onNotFound: (c) => env.ASSETS.fetch(c.req.raw),
  });
  const built: BuiltWorker = {
    app,
    usecases,
    cleanupBlobs: createBlobCleanupScheduler(deps.db, deps.blobs),
  };
  workerCache.set(env, built);
  return built;
}

/** Exported for tests, which need each case to start from a clean isolate. */
export function clearWorkerCacheForTesting(env: Env): void {
  workerCache.delete(env);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    let worker: BuiltWorker;
    try {
      worker = getOrBuildWorker(env);
    } catch (error) {
      // Construction fails before `createApp`'s own `onError` handler
      // exists, so the masked-JSON-500 shape is mirrored by hand rather than
      // leaking a configuration error message -- which can echo env var
      // values -- to the client.
      console.error("Failed to build application dependencies", error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
    ctx.waitUntil(
      worker.cleanupBlobs().catch((error: unknown) => {
        console.error(
          "Failed to drain the post-migration blob cleanup queue",
          error,
        );
      }),
    );
    // Passing `env`/`ctx` through makes them available as hono's `c.env` and
    // `c.executionCtx`, which the auth middleware's expiry sweep needs so
    // the runtime does not cancel that cleanup once the response returns.
    return worker.app.fetch(request, env, ctx);
  },

  /** Cloudflare Email Routing delivers inbound mail here.
   *
   * A rejected message is refused at SMTP time via `setReject`, so the
   * sender learns immediately rather than having the mail black-holed. An
   * unexpected failure is logged and rethrown, which makes Cloudflare retry
   * delivery instead of silently dropping the message. */
  async email(
    message: ForwardableEmailMessageLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    const worker = getOrBuildWorker(env);
    ctx.waitUntil(
      worker.cleanupBlobs().catch((error: unknown) => {
        console.error(
          "Failed to drain the post-migration blob cleanup queue",
          error,
        );
      }),
    );
    try {
      const result = await worker.usecases.receiveMessage({
        envelopeFrom: message.from,
        envelopeTo: message.to,
        raw: message.raw,
        rawSize: message.rawSize,
        headers: headersToMap(message.headers),
      });
      if (result.kind === "REJECTED") {
        message.setReject(result.reason);
      }
    } catch (error) {
      console.error("Failed to ingest inbound message", error);
      throw error;
    }
  },
};
