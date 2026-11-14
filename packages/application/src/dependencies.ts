import type { ApiKeyRepository } from "./ports/api-key-repository";
import type {
  EmailAuthChallengeRepository,
  SessionRepository,
  UserRepository,
} from "./ports/auth-repository";
import type { BlobStore } from "./ports/blob-store";
import type { FileLinkRepository } from "./ports/file-link-repository";
import type { MailAddressRepository } from "./ports/mail-address-repository";
import type { MailDomainRepository } from "./ports/mail-domain-repository";
import type { MailSender } from "./ports/mail-sender";
import type { ClassificationRuleRepository } from "./ports/classification-rule-repository";
import type { DnsResolver } from "./ports/dns-resolver";
import type { MessageEventRepository } from "./ports/message-event-repository";
import type { MessageRepository } from "./ports/message-repository";
import type { MimeBuilder, MimeParser } from "./ports/mime";
import type { Clock, RandomSource, TokenHasher } from "./ports/runtime-ports";
import type { SqlDatabase } from "./ports/sql-database";
import type { TagRepository } from "./ports/tag-repository";
import type { UserMailPermissionRepository } from "./ports/user-mail-permission-repository";
import type { CaldavAccountRepository, CaldavClient } from "./ports/caldav";
import type { CalendarEventRepository } from "./ports/calendar-event-repository";
import type { CalendarRepository } from "./ports/calendar-repository";
import type { CredentialCipher } from "./ports/credential-cipher";
import type { IcsCodec } from "./ports/ics-codec";
import type { MailTemplateRepository } from "./ports/mail-template-repository";
import type { TemplateRenderer } from "./ports/template-renderer";
import type { UserCalendarPermissionRepository } from "./ports/user-calendar-permission-repository";
import type { UserTemplatePermissionRepository } from "./ports/user-template-permission-repository";

/** Instance-wide self-signup gate. Defaults to `"closed"`: this is a mail
 * server, not a SaaS trial, so an unset value must not leave registration
 * open to the internet. */
export type SignupMode = "open" | "closed";

export interface InstanceConfig {
  readonly signupMode: SignupMode;
  /** Absolute origin (scheme + host, no trailing slash) this deployment is
   * reachable at, or `null` when unconfigured -- in which case passwordless
   * login is disabled rather than mailing broken links, and file-link URLs
   * are returned as relative paths. */
  readonly publicOrigin: string | null;
  /** Verified sender mailbox used for **system** mail only -- the
   * passwordless login link, which has no user-chosen sender to use. `null`
   * disables passwordless login with a clear `SERVICE_UNAVAILABLE` rather
   * than mailing from an address the provider would reject.
   *
   * Deliberately *not* the sender for user mail: mailcal runs many
   * addresses across many domains, and each message leaves as the mailbox
   * its sender was authorized for. */
  readonly mailFrom: string | null;
  /** Spam score at or above which the `SPAM` system tag is applied. */
  readonly spamThreshold: number;
  /** Operator-supplied phrases that contribute to the spam score when they
   * appear in a subject or body. Empty by default. */
  readonly spamPhrases: readonly string[];
  /** Hard cap on a file link's requested `ttlSeconds`. */
  readonly fileLinkMaxTtlSeconds: number;
}

/** Composition-root bundle of every port a use case may need. Concrete
 * adapters are wired into this object at the Worker / local-server entry
 * point; use cases only ever see the port interfaces.
 *
 * Repository ports live here alongside the infrastructure ports because use
 * cases need concrete repository instances, and the application layer
 * cannot construct those from `db` itself without importing concrete
 * adapters -- which would invert the dependency rule. `instanceConfig` is
 * not a port at all, just a read-only settings bundle resolved once at
 * startup. */
export interface AppDependencies {
  readonly db: SqlDatabase;
  readonly blobs: BlobStore;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly tokenHasher: TokenHasher;
  readonly mimeParser: MimeParser;
  readonly mimeBuilder: MimeBuilder;
  readonly mailSender: MailSender;
  readonly templateRenderer: TemplateRenderer;
  readonly icsCodec: IcsCodec;
  readonly caldavClient: CaldavClient;
  readonly credentialCipher: CredentialCipher;

  readonly mailDomainRepository: MailDomainRepository;
  readonly mailAddressRepository: MailAddressRepository;
  readonly messageRepository: MessageRepository;
  readonly messageEventRepository: MessageEventRepository;
  readonly classificationRuleRepository: ClassificationRuleRepository;
  readonly dns: DnsResolver;
  readonly tagRepository: TagRepository;
  readonly apiKeyRepository: ApiKeyRepository;
  readonly fileLinkRepository: FileLinkRepository;
  readonly userRepository: UserRepository;
  readonly userMailPermissionRepository: UserMailPermissionRepository;
  readonly sessionRepository: SessionRepository;
  readonly emailAuthChallengeRepository: EmailAuthChallengeRepository;
  readonly mailTemplateRepository: MailTemplateRepository;
  readonly userTemplatePermissionRepository: UserTemplatePermissionRepository;
  readonly calendarRepository: CalendarRepository;
  readonly calendarEventRepository: CalendarEventRepository;
  readonly caldavAccountRepository: CaldavAccountRepository;
  readonly userCalendarPermissionRepository: UserCalendarPermissionRepository;

  readonly instanceConfig: InstanceConfig;
}
