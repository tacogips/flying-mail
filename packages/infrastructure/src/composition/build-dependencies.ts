import { createMemoryBlobStore } from "@mailcal/adapter/blob/memory";
import { createR2BlobStore } from "@mailcal/adapter/blob/r2";
import { createS3BlobStore } from "@mailcal/adapter/blob/s3";
import {
  createCryptoRandomSource,
  createSha256TokenHasher,
} from "@mailcal/adapter/crypto";
import { createCaldavClient } from "@mailcal/adapter/caldav/caldav-client";
import { createCredentialCipher } from "@mailcal/adapter/crypto/credential-cipher";
import { createDohResolver } from "@mailcal/adapter/dns/doh-resolver";
import { createIcsCodec } from "@mailcal/adapter/ics/ics-codec";
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
import { createCaldavAccountRepository } from "@mailcal/adapter/repositories/caldav-account-repository";
import { createCalendarEventRepository } from "@mailcal/adapter/repositories/calendar-event-repository";
import { createCalendarRepository } from "@mailcal/adapter/repositories/calendar-repository";
import { createClassificationRuleRepository } from "@mailcal/adapter/repositories/classification-rule-repository";
import { createMailTemplateRepository } from "@mailcal/adapter/repositories/mail-template-repository";
import { createUserCalendarPermissionRepository } from "@mailcal/adapter/repositories/user-calendar-permission-repository";
import { createUserTemplatePermissionRepository } from "@mailcal/adapter/repositories/user-template-permission-repository";
import { createEtaTemplateRenderer } from "@mailcal/adapter/templates/eta-renderer";
import { createFileLinkRepository } from "@mailcal/adapter/repositories/file-link-repository";
import { createMessageEventRepository } from "@mailcal/adapter/repositories/message-event-repository";
import { createMailAddressRepository } from "@mailcal/adapter/repositories/mail-address-repository";
import { createMailDomainRepository } from "@mailcal/adapter/repositories/mail-domain-repository";
import { createMessageRepository } from "@mailcal/adapter/repositories/message-repository";
import { createTagRepository } from "@mailcal/adapter/repositories/tag-repository";
import { createUserMailPermissionRepository } from "@mailcal/adapter/repositories/user-mail-permission-repository";
import { createD1Database } from "@mailcal/adapter/sql/d1";
import { createLibsqlDatabase } from "@mailcal/adapter/sql/libsql";
import type { AppDependencies } from "@mailcal/application/dependencies";
import type { BlobStore } from "@mailcal/application/ports/blob-store";
import type { MailSender } from "@mailcal/application/ports/mail-sender";
import type { Clock } from "@mailcal/application/ports/runtime-ports";
import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  type BuildDependenciesConfig,
  DEFAULT_FILE_LINK_MAX_TTL_SECONDS,
  DEFAULT_SPAM_THRESHOLD,
  DEFAULT_SQLITE_URL,
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
    // CalDAV: without `MAILCAL_CREDENTIAL_KEY` the cipher reports
    // `available: false` and the CalDAV use cases fail with
    // SERVICE_UNAVAILABLE, while calendars and events keep working.
    icsCodec: createIcsCodec(),
    caldavClient: createCaldavClient(),
    credentialCipher: createCredentialCipher(config.credentialKey ?? null),

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
    userCalendarPermissionRepository:
      createUserCalendarPermissionRepository(db),
    calendarRepository: createCalendarRepository(db),
    calendarEventRepository: createCalendarEventRepository(db),
    caldavAccountRepository: createCaldavAccountRepository(db),
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
