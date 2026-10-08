import type { R2BucketLike } from "@flying-mail/adapter/blob/r2";
import type { CloudflareSendEmailBinding } from "@flying-mail/adapter/mail/cloudflare-email";
import type { D1DatabaseLike } from "@flying-mail/adapter/sql/d1";
import type { RateLimitBindingLike } from "@flying-mail/adapter/rate-limit/workers-binding";

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
   * type; flying-mail never reads it. */
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
  readonly AUTH_RATE_LIMITER?: RateLimitBindingLike;
  readonly FLYING_MAIL_PUBLIC_ORIGIN?: string;
  readonly FLYING_MAIL_MAIL_FROM?: string;
  readonly FLYING_MAIL_BOOTSTRAP_TOKEN?: string;
  readonly FLYING_MAIL_TURNSTILE_SECRET_KEY?: string;
  readonly FLYING_MAIL_TURNSTILE_SITE_KEY?: string;
  readonly FLYING_MAIL_INVITE_TTL_SECONDS?: string;
  /** Cloudflare Email Sending credentials. Set both to send to arbitrary
   * recipients instead of only the account's verified destinations. Keep
   * the token a Worker *secret*, never a plaintext var. */
  readonly FLYING_MAIL_EMAIL_SENDING_ACCOUNT_ID?: string;
  readonly FLYING_MAIL_EMAIL_SENDING_TOKEN?: string;
  readonly FLYING_MAIL_SPAM_THRESHOLD?: string;
  readonly FLYING_MAIL_SPAM_PHRASES?: string;
  readonly FLYING_MAIL_FILE_LINK_MAX_TTL?: string;
  readonly FLYING_MAIL_INBOUND_MX_SUFFIX?: string;
  readonly FLYING_MAIL_BLOB_BACKEND?: string;
  readonly FLYING_MAIL_S3_ENDPOINT?: string;
  readonly FLYING_MAIL_S3_BUCKET?: string;
  readonly FLYING_MAIL_S3_ACCESS_KEY_ID?: string;
  readonly FLYING_MAIL_S3_SECRET_ACCESS_KEY?: string;
  readonly FLYING_MAIL_S3_REGION?: string;
}

/** Workers vars arrive on the `Env` object rather than in `process.env`, so
 * the shared `composition/config.ts` resolvers -- which take a plain
 * string map -- are fed through this. */
export function envToRecord(env: Env): Record<string, string | undefined> {
  return {
    FLYING_MAIL_PUBLIC_ORIGIN: env.FLYING_MAIL_PUBLIC_ORIGIN,
    FLYING_MAIL_MAIL_FROM: env.FLYING_MAIL_MAIL_FROM,
    FLYING_MAIL_BOOTSTRAP_TOKEN: env.FLYING_MAIL_BOOTSTRAP_TOKEN,
    FLYING_MAIL_TURNSTILE_SECRET_KEY: env.FLYING_MAIL_TURNSTILE_SECRET_KEY,
    FLYING_MAIL_TURNSTILE_SITE_KEY: env.FLYING_MAIL_TURNSTILE_SITE_KEY,
    FLYING_MAIL_INVITE_TTL_SECONDS: env.FLYING_MAIL_INVITE_TTL_SECONDS,
    FLYING_MAIL_EMAIL_SENDING_ACCOUNT_ID:
      env.FLYING_MAIL_EMAIL_SENDING_ACCOUNT_ID,
    FLYING_MAIL_EMAIL_SENDING_TOKEN: env.FLYING_MAIL_EMAIL_SENDING_TOKEN,
    FLYING_MAIL_SPAM_THRESHOLD: env.FLYING_MAIL_SPAM_THRESHOLD,
    FLYING_MAIL_SPAM_PHRASES: env.FLYING_MAIL_SPAM_PHRASES,
    FLYING_MAIL_FILE_LINK_MAX_TTL: env.FLYING_MAIL_FILE_LINK_MAX_TTL,
    FLYING_MAIL_INBOUND_MX_SUFFIX: env.FLYING_MAIL_INBOUND_MX_SUFFIX,
    FLYING_MAIL_BLOB_BACKEND: env.FLYING_MAIL_BLOB_BACKEND,
    FLYING_MAIL_S3_ENDPOINT: env.FLYING_MAIL_S3_ENDPOINT,
    FLYING_MAIL_S3_BUCKET: env.FLYING_MAIL_S3_BUCKET,
    FLYING_MAIL_S3_ACCESS_KEY_ID: env.FLYING_MAIL_S3_ACCESS_KEY_ID,
    FLYING_MAIL_S3_SECRET_ACCESS_KEY: env.FLYING_MAIL_S3_SECRET_ACCESS_KEY,
    FLYING_MAIL_S3_REGION: env.FLYING_MAIL_S3_REGION,
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
