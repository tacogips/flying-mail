import type {
  CloudflareSendEmailBinding,
  CloudflareSenderAddress,
} from "@flying-mail/adapter/mail/cloudflare-email";
import { parseCloudflareSenderAddress } from "@flying-mail/adapter/mail/cloudflare-email";
import type { R2BucketLike } from "@flying-mail/adapter/blob/r2";
import type { S3Config } from "@flying-mail/adapter/blob/s3";
import type { D1DatabaseLike } from "@flying-mail/adapter/sql/d1";
import type { SignupMode } from "@flying-mail/application/dependencies";
import type { DnsResolver } from "@flying-mail/application/ports/dns-resolver";
import type {
  Clock,
  RandomSource,
  TokenHasher,
} from "@flying-mail/application/ports/runtime-ports";

export type BlobBackend = "r2" | "s3" | "memory";
export type SqlBackend = "d1" | "sqlite";
/** Which `TcpDialer` implementation external mail's POP3/SMTP clients dial
 * through. Explicit only when a caller needs to force one -- the default is
 * feature detection, see `build-dependencies.ts`'s `resolveTcpDialer`. */
export type ExternalMailRuntime = "cloudflare" | "node";

export const DEFAULT_SQLITE_URL = "file:./data/mailcal.db";
export const DEFAULT_SPAM_THRESHOLD = 0.6;
export const DEFAULT_FILE_LINK_MAX_TTL_SECONDS = 604800;
export const DEFAULT_INBOUND_MX_SUFFIX = "mx.cloudflare.net";
const DEFAULT_S3_REGION = "us-east-1";

export interface BuildDependenciesConfig {
  readonly sqlBackend: SqlBackend;
  readonly d1?: D1DatabaseLike;
  readonly sqliteUrl?: string;
  readonly blobBackend: BlobBackend;
  readonly r2?: R2BucketLike;
  readonly s3?: S3Config;
  readonly email?: CloudflareSendEmailBinding;
  readonly mailFrom?: CloudflareSenderAddress;
  /** Cloudflare Email Sending credentials. When both are present this REST
   * path is preferred over the `send_email` binding, because the binding
   * can only reach addresses already verified as destinations on the
   * account -- unusable for a general mail server. */
  readonly emailSendingAccountId?: string;
  readonly emailSendingToken?: string;
  readonly publicOrigin?: string;
  readonly signupMode?: SignupMode;
  readonly spamThreshold?: number;
  readonly spamPhrases?: readonly string[];
  readonly fileLinkMaxTtlSeconds?: number;
  readonly inboundMxSuffix?: string | null;
  /** Base64-encoded 32-byte AES key for stored CardDAV and external-mail
   * credentials. Absent means credential-dependent operations are disabled. */
  readonly credentialKey?: string;
  /** Selects the `TcpDialer` external mail's POP3/SMTP clients use. Absent
   * means feature-detect the runtime instead -- see `resolveTcpDialer` in
   * `build-dependencies.ts` -- so neither `wrangler dev`/Miniflare nor a
   * plain `bun run` needs this set to get a working dialer. */
  readonly runtime?: ExternalMailRuntime;
  readonly clock?: Clock;
  readonly dns?: DnsResolver;
  readonly random?: RandomSource;
  readonly tokenHasher?: TokenHasher;
}

/** A set-but-invalid `FLYING_MAIL_PUBLIC_ORIGIN`. Thrown rather than silently
 * ignored: an operator who set the variable clearly intended login and
 * absolute file-link URLs to work, and degrading quietly would leave them
 * debugging a mail that never arrives. */
export class PublicOriginConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicOriginConfigurationError";
  }
}

/** A set-but-invalid `FLYING_MAIL_CREDENTIAL_KEY`. Same reasoning as
 * {@link PublicOriginConfigurationError}: an operator who set the secret
 * meant encrypted third-party credentials to work, and quietly running
 * without encryption would be worse than refusing to start. */
export class CredentialKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialKeyConfigurationError";
  }
}

/** A sender configured without a resolvable public origin, or an invalid
 * sender address. Either combination mails links that cannot work. */
export class MailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailConfigurationError";
  }
}

type EnvLike = Record<string, string | undefined>;

/** Normalizes to scheme + host with no trailing slash. Returns `undefined`
 * for an unset variable -- which disables login rather than breaking it --
 * and throws for a set-but-unusable one. */
export function resolvePublicOrigin(env: EnvLike): string | undefined {
  const raw = env["FLYING_MAIL_PUBLIC_ORIGIN"];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PublicOriginConfigurationError(
      "FLYING_MAIL_PUBLIC_ORIGIN is not a valid absolute URL",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PublicOriginConfigurationError(
      "FLYING_MAIL_PUBLIC_ORIGIN must use http or https",
    );
  }
  return url.origin;
}

/** Returns `undefined` when unset -- which disables CardDAV and external-mail
 * credential operations with a clear `SERVICE_UNAVAILABLE` -- and throws for
 * a value that is set but not a base64-encoded 32-byte key. */
export function resolveCredentialKey(env: EnvLike): string | undefined {
  const raw = env["FLYING_MAIL_CREDENTIAL_KEY"];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  let decoded: string;
  try {
    decoded = atob(trimmed);
  } catch {
    throw new CredentialKeyConfigurationError(
      "FLYING_MAIL_CREDENTIAL_KEY must be base64-encoded",
    );
  }
  if (decoded.length !== 32) {
    throw new CredentialKeyConfigurationError(
      "FLYING_MAIL_CREDENTIAL_KEY must decode to exactly 32 bytes",
    );
  }
  return trimmed;
}

export function resolveMailFrom(
  env: EnvLike,
): CloudflareSenderAddress | undefined {
  const raw = env["FLYING_MAIL_MAIL_FROM"];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = parseCloudflareSenderAddress(raw.trim());
  if (parsed === null) {
    throw new MailConfigurationError(
      "FLYING_MAIL_MAIL_FROM is not a valid single mailbox address",
    );
  }
  return parsed;
}

/** A configured sender with no public origin would mail login links whose
 * URL cannot be built. Failing here surfaces the mistake at deploy time
 * rather than on a user's first login attempt. */
export function assertMailOriginConsistency(params: {
  readonly mailFrom: CloudflareSenderAddress | undefined;
  readonly publicOrigin: string | undefined;
}): void {
  if (params.mailFrom !== undefined && params.publicOrigin === undefined) {
    throw new MailConfigurationError(
      "FLYING_MAIL_MAIL_FROM is set but FLYING_MAIL_PUBLIC_ORIGIN is not; login links could not be built",
    );
  }
}

/** Defaults to `"closed"`. This is a mail server, not a SaaS trial: an
 * unset or unrecognized value must not leave registration open. */
export function resolveSignupMode(env: EnvLike): SignupMode {
  return env["FLYING_MAIL_SIGNUP"] === "open" ? "open" : "closed";
}

function resolveNumber(
  raw: string | undefined,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && isValid(parsed) ? parsed : fallback;
}

export function resolveSpamThreshold(env: EnvLike): number {
  return resolveNumber(
    env["FLYING_MAIL_SPAM_THRESHOLD"],
    DEFAULT_SPAM_THRESHOLD,
    (value) => value >= 0 && value <= 1,
  );
}

/** `FLYING_MAIL_SPAM_PHRASES`: comma-separated phrases that raise the spam
 * score when matched. Blank entries are dropped. */
export function resolveSpamPhrases(env: EnvLike): readonly string[] {
  const raw = env["FLYING_MAIL_SPAM_PHRASES"];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);
}

export function resolveFileLinkMaxTtl(env: EnvLike): number {
  return resolveNumber(
    env["FLYING_MAIL_FILE_LINK_MAX_TTL"],
    DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
    (value) => Number.isInteger(value) && value >= 60,
  );
}

/** `FLYING_MAIL_INBOUND_MX_SUFFIX` defaults to Cloudflare Email Routing.
 * An empty or whitespace-only value disables the activation gate. */
export function resolveInboundMxSuffix(env: EnvLike): string | null {
  const raw = env["FLYING_MAIL_INBOUND_MX_SUFFIX"];
  if (raw === undefined) {
    return DEFAULT_INBOUND_MX_SUFFIX;
  }
  const normalized = raw.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length === 0 ? null : normalized;
}

/** Normalizes a SQLite location into something `@libsql/client` accepts.
 *
 * libsql requires a URL (`file:...`, `libsql://...`, `:memory:`) and throws
 * an opaque `URL_INVALID` for a bare filesystem path -- which is exactly
 * what an operator naturally writes. A plain path is therefore promoted to
 * a `file:` URL rather than being rejected. */
export function normalizeSqliteUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_SQLITE_URL;
  }
  if (trimmed === ":memory:" || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed;
  }
  return `file:${trimmed}`;
}

export function resolveBlobBackend(env: EnvLike): BlobBackend {
  const raw = env["FLYING_MAIL_BLOB_BACKEND"];
  return raw === "s3" || raw === "memory" || raw === "r2" ? raw : "r2";
}

function requireS3Var(
  env: EnvLike,
  name:
    | "FLYING_MAIL_S3_ENDPOINT"
    | "FLYING_MAIL_S3_BUCKET"
    | "FLYING_MAIL_S3_ACCESS_KEY_ID"
    | "FLYING_MAIL_S3_SECRET_ACCESS_KEY",
): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`FLYING_MAIL_BLOB_BACKEND=s3 requires ${name} to be set`);
  }
  return value;
}

export function resolveS3Config(env: EnvLike): S3Config {
  return {
    endpoint: requireS3Var(env, "FLYING_MAIL_S3_ENDPOINT"),
    bucket: requireS3Var(env, "FLYING_MAIL_S3_BUCKET"),
    accessKeyId: requireS3Var(env, "FLYING_MAIL_S3_ACCESS_KEY_ID"),
    secretAccessKey: requireS3Var(env, "FLYING_MAIL_S3_SECRET_ACCESS_KEY"),
    region: env["FLYING_MAIL_S3_REGION"] ?? DEFAULT_S3_REGION,
    forcePathStyle: true,
  };
}

/** Builds the local (Bun/Node) server's config from `process.env`.
 *
 * Defaults to a libsql file plus an in-memory blob store, so a clean
 * checkout runs with no setup at all. */
export function loadConfigFromEnv(env: EnvLike): BuildDependenciesConfig {
  const publicOrigin = resolvePublicOrigin(env);
  const mailFrom = resolveMailFrom(env);
  assertMailOriginConsistency({ mailFrom, publicOrigin });

  const credentialKey = resolveCredentialKey(env);

  const blobBackend = resolveBlobBackend(env);
  const localBlobBackend: BlobBackend =
    env["FLYING_MAIL_BLOB_BACKEND"] === undefined ? "memory" : blobBackend;

  return {
    sqlBackend: "sqlite",
    sqliteUrl: normalizeSqliteUrl(
      env["FLYING_MAIL_SQLITE_URL"] ?? DEFAULT_SQLITE_URL,
    ),
    blobBackend: localBlobBackend,
    ...(localBlobBackend === "s3" ? { s3: resolveS3Config(env) } : {}),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(mailFrom === undefined ? {} : { mailFrom }),
    signupMode: resolveSignupMode(env),
    spamThreshold: resolveSpamThreshold(env),
    spamPhrases: resolveSpamPhrases(env),
    fileLinkMaxTtlSeconds: resolveFileLinkMaxTtl(env),
    inboundMxSuffix: resolveInboundMxSuffix(env),
    ...(credentialKey === undefined ? {} : { credentialKey }),
  };
}

/** Trimmed non-empty value, or `undefined`. Both Email Sending settings go
 * through this so a blank var reads as "not configured" rather than as an
 * empty credential the API would reject at send time. */
function optionalEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function resolveEmailSendingAccountId(
  env: Record<string, string | undefined>,
): string | undefined {
  return optionalEnv(env, "FLYING_MAIL_EMAIL_SENDING_ACCOUNT_ID");
}

export function resolveEmailSendingToken(
  env: Record<string, string | undefined>,
): string | undefined {
  return optionalEnv(env, "FLYING_MAIL_EMAIL_SENDING_TOKEN");
}
