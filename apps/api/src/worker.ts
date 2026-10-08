import {
  createUseCases,
  type UseCases,
} from "@flying-mail/application/usecases";
import { drainBlobCleanupQueue } from "@flying-mail/adapter/migrations/blob-cleanup";
import type { BlobStore } from "@flying-mail/application/ports/blob-store";
import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { buildDependencies } from "@flying-mail/infrastructure/composition/build-dependencies";
import { normalizeClientIpForRateLimit } from "@flying-mail/infrastructure/composition/config";
import {
  isRealtimeUpgradeRequest,
  checkRealtimeUpgrade,
} from "@flying-mail/infrastructure/realtime/upgrade";
import { MAIL_EVENT_HUB_NAME } from "@flying-mail/adapter/realtime/mail-event-notifiers";
import { buildWorkerConfig, buildWorkerNotifier } from "./worker-config";

export { buildWorkerConfig } from "./worker-config";
export { MailEventHub } from "./mail-event-hub";
import { createApp } from "@flying-mail/infrastructure/http/app";
import type { AuthVariables } from "@flying-mail/infrastructure/http/auth-middleware";
import type { Hono } from "hono";
import {
  type Env,
  type ExecutionContextLike,
  type ForwardableEmailMessageLike,
  headersToMap,
} from "./env";

type WorkerApp = Hono<{ Variables: AuthVariables }>;

interface BuiltWorker {
  readonly app: WorkerApp;
  readonly usecases: UseCases;
  readonly cleanupBlobs: () => Promise<void>;
  readonly deps: import("@flying-mail/application/dependencies").AppDependencies;
  readonly notifier: Exclude<
    ReturnType<typeof buildWorkerNotifier>,
    null
  > | null;
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
  const notifier = buildWorkerNotifier(env);
  const deps = buildDependencies(
    buildWorkerConfig(env, { mailEventNotifier: notifier }),
  );
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
    deps,
    notifier,
    cleanupBlobs: createBlobCleanupScheduler(deps.db, deps.blobs),
  };
  workerCache.set(env, built);
  return built;
}

/** Exported for tests, which need each case to start from a clean isolate. */
export function clearWorkerCacheForTesting(env: Env): void {
  workerCache.delete(env);
}

/** Exposes the cached composition root to tests for notifier ownership checks. */
export function getBuiltWorkerForTesting(env: Env): BuiltWorker {
  return getOrBuildWorker(env);
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
    if (isRealtimeUpgradeRequest(request)) {
      if (env.MAIL_EVENT_HUB === undefined) {
        return new Response("Realtime subscriptions are unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const clientIp = normalizeClientIpForRateLimit(
        request.headers.get("cf-connecting-ip")?.trim() || null,
      );
      const checked = await checkRealtimeUpgrade(request, {
        publicOrigin: worker.deps.instanceConfig.publicOrigin,
        clientIp,
        rateLimiter: worker.deps.rateLimiter,
        tokenHasher: worker.deps.tokenHasher,
      });
      if (!checked.ok) return checked.response;
      const headers = new Headers({
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": "graphql-transport-ws",
      });
      if (checked.info.clientIp !== null) {
        headers.set("x-flying-mail-client-ip", checked.info.clientIp);
      }
      if (checked.info.cookieTokenHash !== null) {
        headers.set(
          "x-flying-mail-session-token-hash",
          checked.info.cookieTokenHash,
        );
      }
      const stub = env.MAIL_EVENT_HUB.get(
        env.MAIL_EVENT_HUB.idFromName(MAIL_EVENT_HUB_NAME),
      );
      try {
        return await stub.fetch("https://mail-event-hub.internal/connect", {
          method: "GET",
          headers,
        });
      } catch {
        console.error("Realtime Durable Object request failed");
        return new Response("Realtime subscriptions are unavailable", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    // Passing `env`/`ctx` through makes them available as hono's c.env and
    // c.executionCtx, which the auth middleware's expiry sweep needs.
    const response = await worker.app.fetch(request, env, ctx);
    if (worker.notifier !== null) ctx.waitUntil(worker.notifier.settle());
    return response;
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
    } finally {
      if (worker.notifier !== null) ctx.waitUntil(worker.notifier.settle());
    }
  },
};
