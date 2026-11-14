import { createUseCases, type UseCases } from "@mailcal/application/usecases";
import { buildDependencies } from "@mailcal/infrastructure/composition/build-dependencies";
import {
  assertMailOriginConsistency,
  type BuildDependenciesConfig,
  resolveBlobBackend,
  resolveCredentialKey,
  resolveFileLinkMaxTtl,
  resolveEmailSendingAccountId,
  resolveEmailSendingToken,
  resolveMailFrom,
  resolvePublicOrigin,
  resolveS3Config,
  resolveSignupMode,
  resolveSpamPhrases,
  resolveSpamThreshold,
} from "@mailcal/infrastructure/composition/config";
import { createApp } from "@mailcal/infrastructure/http/app";
import type { AuthVariables } from "@mailcal/infrastructure/http/auth-middleware";
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
 * set-but-invalid `MAILCAL_PUBLIC_ORIGIN`, or a `MAILCAL_MAIL_FROM` with no
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

  return {
    sqlBackend: "d1",
    d1: env.DB,
    blobBackend,
    signupMode: resolveSignupMode(record),
    spamThreshold: resolveSpamThreshold(record),
    spamPhrases: resolveSpamPhrases(record),
    fileLinkMaxTtlSeconds: resolveFileLinkMaxTtl(record),
    email: env.EMAIL,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(mailFrom === undefined ? {} : { mailFrom }),
    ...(blobBackend === "r2" ? { r2: env.BLOB } : {}),
    ...(blobBackend === "s3" ? { s3: resolveS3Config(record) } : {}),
    ...(credentialKey === undefined ? {} : { credentialKey }),
    ...(emailSendingAccountId === undefined ? {} : { emailSendingAccountId }),
    ...(emailSendingToken === undefined ? {} : { emailSendingToken }),
  };
}

type WorkerApp = Hono<{ Variables: AuthVariables }>;

interface BuiltWorker {
  readonly app: WorkerApp;
  readonly usecases: UseCases;
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
    onNotFound: (c) => env.ASSETS.fetch(c.req.raw),
  });
  const built: BuiltWorker = { app, usecases };
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
    _ctx: ExecutionContextLike,
  ): Promise<void> {
    const worker = getOrBuildWorker(env);
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
