import { createMemoryBlobStore } from "@mailcal/adapter/blob/memory";
import { createR2BlobStore } from "@mailcal/adapter/blob/r2";
import { createS3BlobStore } from "@mailcal/adapter/blob/s3";
import {
  createCryptoRandomSource,
  createSha256TokenHasher,
} from "@mailcal/adapter/crypto";
import { createAddressBookRepository } from "@mailcal/adapter/repositories/address-book-repository";
import { createCarddavAccountRepository } from "@mailcal/adapter/repositories/carddav-account-repository";
import { createCarddavClient } from "@mailcal/adapter/carddav/carddav-client";
import { createContactRepository } from "@mailcal/adapter/repositories/contact-repository";
import { createVcardCodec } from "@mailcal/adapter/vcard/vcard-codec";
import { createCredentialCipher } from "@mailcal/adapter/crypto/credential-cipher";
import { createDohResolver } from "@mailcal/adapter/dns/doh-resolver";
import { createCloudflareEmailApiSender } from "@mailcal/adapter/mail/cloudflare-email-api";
import {
  createCloudflareMailSender,
  createUnavailableMailSender,
} from "@mailcal/adapter/mail/cloudflare-email";
import { createMimeTextBuilder } from "@mailcal/adapter/mime/mime-builder";
import { createPostalMimeParser } from "@mailcal/adapter/mime/postal-mime-parser";
import { createApiKeyRepository } from "@mailcal/adapter/repositories/api-key-repository";
import {
  createEmailAuthChallengeRepository,
  createSessionRepository,
  createUserRepository,
} from "@mailcal/adapter/repositories/auth-repository";
import { createClassificationRuleRepository } from "@mailcal/adapter/repositories/classification-rule-repository";
import { createMailTemplateRepository } from "@mailcal/adapter/repositories/mail-template-repository";
import { createUserTemplatePermissionRepository } from "@mailcal/adapter/repositories/user-template-permission-repository";
import { createEtaTemplateRenderer } from "@mailcal/adapter/templates/eta-renderer";
import { createExternalMailAccountRepository } from "@mailcal/adapter/repositories/external-mail-account-repository";
import { createExternalMessageStateRepository } from "@mailcal/adapter/repositories/external-message-state-repository";
import { createFileLinkRepository } from "@mailcal/adapter/repositories/file-link-repository";
import { createJmapClient } from "@mailcal/adapter/jmap/jmap-client";
import { createMessageEventRepository } from "@mailcal/adapter/repositories/message-event-repository";
import { createMailAddressRepository } from "@mailcal/adapter/repositories/mail-address-repository";
import { createMailDomainRepository } from "@mailcal/adapter/repositories/mail-domain-repository";
import { createMessageRepository } from "@mailcal/adapter/repositories/message-repository";
import { createPop3Client } from "@mailcal/adapter/pop3/pop3-client";
import { createSmtpSubmissionClient } from "@mailcal/adapter/smtp/smtp-client";
import { createTagRepository } from "@mailcal/adapter/repositories/tag-repository";
import { createCloudflareTcpDialer } from "@mailcal/adapter/tcp/cloudflare-tcp-dialer";
import { createNodeTcpDialer } from "@mailcal/adapter/tcp/node-tcp-dialer";
import { createUserMailPermissionRepository } from "@mailcal/adapter/repositories/user-mail-permission-repository";
import { createD1Database } from "@mailcal/adapter/sql/d1";
import { createLibsqlDatabase } from "@mailcal/adapter/sql/libsql";
import type { AppDependencies } from "@mailcal/application/dependencies";
import type { BlobStore } from "@mailcal/application/ports/blob-store";
import type { TcpDialer } from "@mailcal/application/ports/external-mail";
import type { MailSender } from "@mailcal/application/ports/mail-sender";
import type { Clock } from "@mailcal/application/ports/runtime-ports";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type BuildDependenciesConfig,
  DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
  DEFAULT_SPAM_THRESHOLD,
  DEFAULT_SQLITE_URL,
  type ExternalMailRuntime,
} from "./config";

/** Thrown when the config selects a backend without the binding or
 * credentials that backend needs. */
export class BuildDependenciesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildDependenciesError";
  }
}

function systemClock(): Clock {
  return { now: () => new Date() };
}

function resolveDb(config: BuildDependenciesConfig): SqlDatabase {
  if (config.sqlBackend === "d1") {
    if (config.d1 === undefined) {
      throw new BuildDependenciesError(
        'sqlBackend "d1" requires a D1 binding (config.d1)',
      );
    }
    return createD1Database(config.d1);
  }
  return createLibsqlDatabase(config.sqliteUrl ?? DEFAULT_SQLITE_URL);
}

/** Picks the outbound path.
 *
 * Email Sending's REST API wins when configured: it delivers to any
 * recipient. The `send_email` binding only reaches addresses already
 * verified as destinations on the Cloudflare account, so it is the
 * fallback, not the default -- useful for a private deployment that only
 * mails its own operators. Neither configured means every send fails with a
 * clear `SERVICE_UNAVAILABLE` rather than a masked internal error.
 *
 * Note `mailFrom` gates neither: it is the *system* sender for login links,
 * not the sender for user mail. */
function resolveMailSender(config: BuildDependenciesConfig): MailSender {
  if (
    config.emailSendingAccountId !== undefined &&
    config.emailSendingToken !== undefined
  ) {
    return createCloudflareEmailApiSender({
      accountId: config.emailSendingAccountId,
      apiToken: config.emailSendingToken,
    });
  }
  return config.email === undefined
    ? createUnavailableMailSender()
    : createCloudflareMailSender(config.email);
}

function resolveBlobs(config: BuildDependenciesConfig): BlobStore {
  if (config.blobBackend === "r2") {
    if (config.r2 === undefined) {
      throw new BuildDependenciesError(
        'blobBackend "r2" requires an R2 binding (config.r2)',
      );
    }
    return createR2BlobStore(config.r2);
  }
  if (config.blobBackend === "s3") {
    if (config.s3 === undefined) {
      throw new BuildDependenciesError(
        'blobBackend "s3" requires S3 config (config.s3)',
      );
    }
    return createS3BlobStore(config.s3);
  }
  return createMemoryBlobStore();
}

/** Cloudflare Workers sets `navigator.userAgent` to this exact string --
 * the platform's own documented, synchronous way to detect workerd without
 * touching a runtime-specific import (`cloudflare:sockets` only resolves
 * inside `dial()`, well after this check). Bun and Node both expose a
 * `navigator` too, but with a different `userAgent`, so the fallback below
 * is "node" everywhere else. */
export function detectExternalMailRuntime(): ExternalMailRuntime {
  return typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
    ? "cloudflare"
    : "node";
}

/** `config.runtime` wins when set; otherwise the runtime is feature-detected
 * via {@link detectExternalMailRuntime}, so a plain `bun run` and `wrangler
 * dev`/Miniflare each get a working `TcpDialer` with no required config.
 * Split out from {@link resolveTcpDialer} so the decision itself -- as
 * opposed to the dialer construction, which touches real sockets once
 * `dial()` runs -- is directly unit-testable. */
export function resolveExternalMailRuntime(
  config: BuildDependenciesConfig,
): ExternalMailRuntime {
  return config.runtime ?? detectExternalMailRuntime();
}

/** Picks the `TcpDialer` external mail's POP3/SMTP clients dial through.
 * Both `createCloudflareTcpDialer` and `createNodeTcpDialer` are safe to
 * *import* on every runtime by their own design (the former only touches
 * `cloudflare:sockets` inside `dial()`; the latter's `node:net`/`node:tls`
 * imports are satisfied under workerd by the `nodejs_compat` flag
 * `apps/api` already sets) -- only the *call* below is runtime-gated. */
function resolveTcpDialer(config: BuildDependenciesConfig): TcpDialer {
  return resolveExternalMailRuntime(config) === "cloudflare"
    ? createCloudflareTcpDialer()
    : createNodeTcpDialer();
}

/** Composition root.
 *
 * Resolves the selected SQL and blob backends, builds every repository over
 * that database, and wires the MIME and mail adapters. Outbound mail is only
 * available when both a binding *and* a verified sender are present --
 * otherwise a deliberately-failing sender is installed, so the server still
 * starts (an operator can log in and finish configuring it) while every send
 * says plainly what is missing. */
export function buildDependencies(
  config: BuildDependenciesConfig,
): AppDependencies {
  const db = resolveDb(config);
  const blobs = resolveBlobs(config);
  const tcpDialer = resolveTcpDialer(config);

  return {
    db,
    blobs,
    clock: config.clock ?? systemClock(),
    random: config.random ?? createCryptoRandomSource(),
    tokenHasher: config.tokenHasher ?? createSha256TokenHasher(),
    mimeParser: createPostalMimeParser(),
    mimeBuilder: createMimeTextBuilder(),
    mailSender: resolveMailSender(config),
    // Parses Eta rather than compiling it: this same object runs inside a
    // Cloudflare Worker, where `new Function` is not available at all.
    templateRenderer: createEtaTemplateRenderer(),
    // CardDAV and external mail share one AES-256-GCM cipher derived from
    // `MAILCAL_CREDENTIAL_KEY`. When the key is absent, the cipher reports
    // `available: false` and credential-dependent operations fail with
    // SERVICE_UNAVAILABLE while the rest of the server remains usable.
    credentialCipher: createCredentialCipher(config.credentialKey ?? null),
    vcardCodec: createVcardCodec(),
    carddavClient: createCarddavClient({ fetchImpl: fetch }),
    // One deployment key covers every retained third-party credential kind:
    // CardDAV, JMAP, POP3, and SMTP.
    jmapClient: createJmapClient({ fetchImpl: fetch }),
    pop3Client: createPop3Client(tcpDialer),
    smtpSubmissionClient: createSmtpSubmissionClient(tcpDialer),
    tcpDialer,

    mailDomainRepository: createMailDomainRepository(db),
    mailAddressRepository: createMailAddressRepository(db),
    messageRepository: createMessageRepository(db),
    messageEventRepository: createMessageEventRepository(db),
    classificationRuleRepository: createClassificationRuleRepository(db),
    dns: config.dns ?? createDohResolver(),
    tagRepository: createTagRepository(db),
    apiKeyRepository: createApiKeyRepository(db),
    fileLinkRepository: createFileLinkRepository(db),
    userRepository: createUserRepository(db),
    userMailPermissionRepository: createUserMailPermissionRepository(db),
    mailTemplateRepository: createMailTemplateRepository(db),
    userTemplatePermissionRepository:
      createUserTemplatePermissionRepository(db),
    addressBookRepository: createAddressBookRepository(db),
    contactRepository: createContactRepository(db),
    carddavAccountRepository: createCarddavAccountRepository(db),
    externalMailAccountRepository: createExternalMailAccountRepository(db),
    externalMessageStateRepository: createExternalMessageStateRepository(db),
    sessionRepository: createSessionRepository(db),
    emailAuthChallengeRepository: createEmailAuthChallengeRepository(db),

    instanceConfig: {
      signupMode: config.signupMode ?? "closed",
      publicOrigin: config.publicOrigin ?? null,
      mailFrom: config.mailFrom ?? null,
      spamThreshold: config.spamThreshold ?? DEFAULT_SPAM_THRESHOLD,
      spamPhrases: config.spamPhrases ?? [],
      fileLinkMaxTtlSeconds:
        config.fileLinkMaxTtlSeconds ?? DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
    },
  };
}
