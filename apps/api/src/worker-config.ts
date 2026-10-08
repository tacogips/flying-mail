import { createDurableObjectMailEventNotifier } from "@flying-mail/adapter/realtime/mail-event-notifiers";
import type { MailEventNotifier } from "@flying-mail/application/ports/mail-event-notifier";
import { createWorkersRateLimiter } from "@flying-mail/adapter/rate-limit/workers-binding";
import type { BuildDependenciesConfig } from "@flying-mail/infrastructure/composition/config";
import {
  assertMailOriginConsistency,
  resolveBlobBackend,
  resolveBootstrapToken,
  resolveCredentialKey,
  resolveEmailSendingAccountId,
  resolveEmailSendingToken,
  resolveEventRetentionSeconds,
  resolveFileLinkMaxTtl,
  resolveInboundMxSuffix,
  resolveInviteTtlSeconds,
  resolveMailFrom,
  resolvePublicOrigin,
  resolveS3Config,
  resolveSpamPhrases,
  resolveSpamThreshold,
  resolveTurnstileConfig,
} from "@flying-mail/infrastructure/composition/config";
import { envToRecord, type Env } from "./env";

export function buildWorkerNotifier(
  env: Env,
): (MailEventNotifier & { settle(): Promise<void> }) | null {
  return env.MAIL_EVENT_HUB === undefined
    ? null
    : createDurableObjectMailEventNotifier(env.MAIL_EVENT_HUB);
}

export function buildWorkerConfig(
  env: Env,
  options?: { readonly mailEventNotifier?: MailEventNotifier | null },
): BuildDependenciesConfig {
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
    eventRetentionSeconds: resolveEventRetentionSeconds(record),
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
    ...(options?.mailEventNotifier == null
      ? {}
      : { mailEventNotifier: options.mailEventNotifier }),
  };
}
