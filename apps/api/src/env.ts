import type { R2BucketLike } from "@mailcal/adapter/blob/r2";
import type { CloudflareSendEmailBinding } from "@mailcal/adapter/mail/cloudflare-email";
import type { D1DatabaseLike } from "@mailcal/adapter/sql/d1";

/** Minimal structural surface of the Workers Static Assets binding, used by
 * `worker.ts`'s SPA fallthrough. Kept local (see `D1DatabaseLike` and
 * `R2BucketLike` for the same rationale) rather than importing the
 * ambient-global `@cloudflare/workers-types`. */
export interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/** Minimal structural surface of a Workers `ExecutionContext`.
 *
 * Forwarded to `app.fetch(request, env, ctx)`, which makes it available as
 * hono's `c.executionCtx` -- used by the auth middleware's once-per-isolate
 * expiry sweep, so the runtime does not cancel that fire-and-forget cleanup
 * once the response is returned. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** Present for structural compatibility with hono's own `ExecutionContext`
   * type; mailcal never reads it. */
  readonly props: unknown;
}

/** Cloudflare Email Routing's inbound message, as a local structural type.
 *
 * `to` is the SMTP envelope recipient -- the address that actually caused
 * delivery -- which is what the ingest pipeline resolves the domain from and
 * what API key scopes are matched against. */
export interface ForwardableEmailMessageLike {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

/** Workers bindings and vars, matching `wrangler.toml`. */
export interface Env {
  readonly DB: D1DatabaseLike;
  readonly BLOB: R2BucketLike;
  readonly ASSETS: FetcherLike;
  readonly EMAIL: CloudflareSendEmailBinding;
  readonly MAILCAL_PUBLIC_ORIGIN?: string;
  readonly MAILCAL_MAIL_FROM?: string;
  /** Cloudflare Email Sending credentials. Set both to send to arbitrary
   * recipients instead of only the account's verified destinations. Keep
   * the token a Worker *secret*, never a plaintext var. */
  readonly MAILCAL_EMAIL_SENDING_ACCOUNT_ID?: string;
  readonly MAILCAL_EMAIL_SENDING_TOKEN?: string;
  readonly MAILCAL_SIGNUP?: string;
  readonly MAILCAL_SPAM_THRESHOLD?: string;
  readonly MAILCAL_SPAM_PHRASES?: string;
  readonly MAILCAL_FILE_LINK_MAX_TTL?: string;
  readonly MAILCAL_BLOB_BACKEND?: string;
  readonly MAILCAL_S3_ENDPOINT?: string;
  readonly MAILCAL_S3_BUCKET?: string;
  readonly MAILCAL_S3_ACCESS_KEY_ID?: string;
  readonly MAILCAL_S3_SECRET_ACCESS_KEY?: string;
  readonly MAILCAL_S3_REGION?: string;
}

/** Workers vars arrive on the `Env` object rather than in `process.env`, so
 * the shared `composition/config.ts` resolvers -- which take a plain
 * string map -- are fed through this. */
export function envToRecord(env: Env): Record<string, string | undefined> {
  return {
    MAILCAL_PUBLIC_ORIGIN: env.MAILCAL_PUBLIC_ORIGIN,
    MAILCAL_MAIL_FROM: env.MAILCAL_MAIL_FROM,
    MAILCAL_EMAIL_SENDING_ACCOUNT_ID: env.MAILCAL_EMAIL_SENDING_ACCOUNT_ID,
    MAILCAL_EMAIL_SENDING_TOKEN: env.MAILCAL_EMAIL_SENDING_TOKEN,
    MAILCAL_SIGNUP: env.MAILCAL_SIGNUP,
    MAILCAL_SPAM_THRESHOLD: env.MAILCAL_SPAM_THRESHOLD,
    MAILCAL_SPAM_PHRASES: env.MAILCAL_SPAM_PHRASES,
    MAILCAL_FILE_LINK_MAX_TTL: env.MAILCAL_FILE_LINK_MAX_TTL,
    MAILCAL_BLOB_BACKEND: env.MAILCAL_BLOB_BACKEND,
    MAILCAL_S3_ENDPOINT: env.MAILCAL_S3_ENDPOINT,
    MAILCAL_S3_BUCKET: env.MAILCAL_S3_BUCKET,
    MAILCAL_S3_ACCESS_KEY_ID: env.MAILCAL_S3_ACCESS_KEY_ID,
    MAILCAL_S3_SECRET_ACCESS_KEY: env.MAILCAL_S3_SECRET_ACCESS_KEY,
    MAILCAL_S3_REGION: env.MAILCAL_S3_REGION,
  };
}

/** Flattens Workers `Headers` into the lower-cased map the ingest use case
 * reads spam signals from. */
export function headersToMap(headers: Headers): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    const existing = map.get(lower);
    map.set(lower, existing === undefined ? value : `${existing}, ${value}`);
  });
  return map;
}
