import type {
  CloudflareSendEmailBinding,
  CloudflareSenderAddress,
} from "@flying-mail/adapter/mail/cloudflare-email";
import { parseCloudflareSenderAddress } from "@flying-mail/adapter/mail/cloudflare-email";
import type { R2BucketLike } from "@flying-mail/adapter/blob/r2";
import type { S3Config } from "@flying-mail/adapter/blob/s3";
import type { D1DatabaseLike } from "@flying-mail/adapter/sql/d1";
import type { DnsResolver } from "@flying-mail/application/ports/dns-resolver";
import type { RateLimiter } from "@flying-mail/application/ports/rate-limiter";
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
export const DEFAULT_INVITE_TTL_SECONDS = 604800;
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
  readonly spamThreshold?: number;
  readonly spamPhrases?: readonly string[];
  readonly fileLinkMaxTtlSeconds?: number;
  readonly inviteTtlSeconds?: number;
  readonly bootstrapToken?: string;
  readonly turnstile?: {
    readonly secret: string;
    readonly siteKey: string;
    readonly expectedHostname: string;
  };
  readonly rateLimiter?: RateLimiter;
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

/** A configured bootstrap token that is too short to be safe to use. */
export class BootstrapTokenConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapTokenConfigurationError";
  }
}

/** An incomplete Turnstile configuration that cannot verify login tokens. */
export class TurnstileConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnstileConfigurationError";
  }
}

/** Returns a stable rate-limit key for a trusted client IP address.
 * IPv6 clients are grouped by their /64 network to limit address rotation;
 * IPv4 and IPv4-mapped IPv6 addresses retain their full address. */
export function normalizeClientIpForRateLimit(
  clientIp: string | null,
): string | null {
  if (clientIp === null) {
    return null;
  }
  const value = clientIp.trim();
  if (value.length === 0) {
    return null;
  }

  const ipv4 = parseIpv4(value);
  if (ipv4 !== null) {
    return ipv4.join(".");
  }

  const ipv6 = parseIpv6(value);
  if (ipv6 === null) {
    return null;
  }
  const isMappedIpv4 =
    ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  if (isMappedIpv4) {
    const mappedIpv4 = ipv6.slice(6);
    const first = mappedIpv4[0];
    const second = mappedIpv4[1];
    if (first === undefined || second === undefined) {
      return null;
    }
    return [first >> 8, first & 0xff, second >> 8, second & 0xff].join(".");
  }
  return `${ipv6
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(":")}::/64`;
}

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    return octet <= 255 ? octet : null;
  });
  return octets.every((octet) => octet !== null) ? (octets as number[]) : null;
}

function parseIpv6(value: string): readonly number[] | null {
  if (value.includes("%")) {
    return null;
  }
  let address = value.toLowerCase();
  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    const ipv4 = parseIpv4(address.slice(separator + 1));
    if (separator < 0 || ipv4 === null) {
      return null;
    }
    const [first, second, third, fourth] = ipv4;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      return null;
    }
    address = `${address.slice(0, separator)}:${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right =
    halves.length === 2 && halves[1] !== ""
      ? (halves[1]?.split(":") ?? [])
      : [];
  const hasCompression = halves.length === 2;
  if (
    (!hasCompression && left.length !== 8) ||
    (hasCompression && left.length + right.length >= 8)
  ) {
    return null;
  }
  const parts = hasCompression
    ? [
        ...left,
        ...Array<string>(8 - left.length - right.length).fill("0"),
        ...right,
      ]
    : left;
  const groups = parts.map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    return Number.parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((group) => group !== null)
    ? (groups as number[])
    : null;
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

/** Invalid invite lifetimes fall back to the seven-day default. */
export function resolveInviteTtlSeconds(env: EnvLike): number {
  const raw = env["FLYING_MAIL_INVITE_TTL_SECONDS"];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_INVITE_TTL_SECONDS;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_INVITE_TTL_SECONDS;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 86400 && parsed <= 2592000
    ? parsed
    : DEFAULT_INVITE_TTL_SECONDS;
}

/** Returns a trimmed bootstrap secret, or disables bootstrap when unset. */
export function resolveBootstrapToken(env: EnvLike): string | undefined {
  const raw = env["FLYING_MAIL_BOOTSTRAP_TOKEN"];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const token = raw.trim();
  if (token.length < 32) {
    throw new BootstrapTokenConfigurationError(
      "FLYING_MAIL_BOOTSTRAP_TOKEN must contain at least 32 characters",
    );
  }
  return token;
}

/** Resolves Turnstile only when its private secret is configured. */
export function resolveTurnstileConfig(
  env: EnvLike,
  publicOrigin: string | undefined,
):
  | {
      readonly secret: string;
      readonly siteKey: string;
      readonly expectedHostname: string;
    }
  | undefined {
  const secret = env["FLYING_MAIL_TURNSTILE_SECRET_KEY"]?.trim();
  if (secret === undefined || secret.length === 0) {
    return undefined;
  }

  const siteKey = env["FLYING_MAIL_TURNSTILE_SITE_KEY"]?.trim();
  if (siteKey === undefined || siteKey.length === 0) {
    throw new TurnstileConfigurationError(
      "FLYING_MAIL_TURNSTILE_SECRET_KEY requires FLYING_MAIL_TURNSTILE_SITE_KEY",
    );
  }
  if (publicOrigin === undefined) {
    throw new TurnstileConfigurationError(
      "FLYING_MAIL_TURNSTILE_SECRET_KEY requires FLYING_MAIL_PUBLIC_ORIGIN",
    );
  }

  let expectedHostname: string;
  try {
    expectedHostname = new URL(publicOrigin).hostname;
  } catch {
    throw new TurnstileConfigurationError(
      "FLYING_MAIL_PUBLIC_ORIGIN must be a valid URL when Turnstile is enabled",
    );
  }
  return { secret, siteKey, expectedHostname };
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
  const inviteTtlSeconds = resolveInviteTtlSeconds(env);
  const bootstrapToken = resolveBootstrapToken(env);
  const turnstile = resolveTurnstileConfig(env, publicOrigin);
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
    spamThreshold: resolveSpamThreshold(env),
    spamPhrases: resolveSpamPhrases(env),
    fileLinkMaxTtlSeconds: resolveFileLinkMaxTtl(env),
    inviteTtlSeconds,
    inboundMxSuffix: resolveInboundMxSuffix(env),
    ...(credentialKey === undefined ? {} : { credentialKey }),
    ...(bootstrapToken === undefined ? {} : { bootstrapToken }),
    ...(turnstile === undefined ? {} : { turnstile }),
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
