import type { AppDependencies, InstanceConfig } from "../dependencies";
import type { RateLimiter } from "../ports/rate-limiter";
import type { TurnstileVerifier } from "../ports/turnstile-verifier";
import {
  createFakeContactStores,
  type FakeContactStores,
  fakeAddressBookRepository,
  fakeCarddavAccountRepository,
  fakeContactRepository,
  identityVcardCodec,
  type ScriptedCarddavClient,
  scriptedCarddavClient,
} from "./contact-fakes";
import {
  createFakeTemplateStores,
  type FakeTemplateStores,
  fakeMailTemplateRepository,
  fakeTemplateRenderer,
  fakeUserTemplatePermissionRepository,
} from "./template-fakes";
import {
  createFakeExternalMailStores,
  type FakeExternalMailStores,
  fakeExternalMailAccountRepository,
  fakeExternalMessageStateRepository,
  recordingTcpDialer,
  type ScriptedJmapClient,
  scriptedJmapClient,
  type ScriptedPop3Client,
  scriptedPop3Client,
  type ScriptedSmtpSubmissionClient,
  scriptedSmtpSubmissionClient,
} from "./external-mail-fakes";
import {
  createClassificationRuleRepositoryFake,
  createFakeEventStores,
  createFakeRuleStores,
  createMessageEventRepositoryFake,
  type FakeEventStores,
  type FakeRuleStores,
} from "./event-and-rule-fakes";
import {
  createFakeMessageStores,
  type FakeMessageStores,
  fakeMessageRepository,
} from "./message-repository-fake";
import {
  createFakeStores,
  fakeApiKeyRepository,
  fakeEmailAuthChallengeRepository,
  fakeFileLinkRepository,
  fakeMailAddressRepository,
  fakeMailDomainRepository,
  fakeSessionRepository,
  fakeTagRepository,
  fakeUserMailPermissionRepository,
  fakeUserRepository,
  type FakeStores,
  seedSystemTags,
} from "./repository-fakes";
import {
  type FixedClock,
  fixedClock,
  type MemoryBlobStore,
  memoryBlobStore,
  plainCredentialCipher,
  plainTokenHasher,
  type RecordingMailSender,
  fakeDnsResolver,
  type FakeDnsResolver,
  recordingMailSender,
  sequenceRandom,
  type StubMimeParser,
  stubMimeParser,
  stubMimeBuilder,
  unusedSqlDatabase,
} from "./runtime-fakes";

export * from "./contact-fakes";
export * from "./external-mail-fakes";
export * from "./auth-hardening-fakes";
export * from "./message-repository-fake";
export * from "./repository-fakes";
export * from "./runtime-fakes";
export * from "./template-fakes";

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  inviteTtlSeconds: 604800,
  bootstrapToken: null,
  turnstileSiteKey: null,
  publicOrigin: "https://mail.example.com",
  mailFrom: "postmaster@example.com",
  spamThreshold: 0.6,
  spamPhrases: [],
  fileLinkMaxTtlSeconds: 604800,
  inboundMxSuffix: "mx.cloudflare.net",
};

/** Everything a test may want to reach into after driving a use case. */
export interface FakeDependencies {
  readonly deps: AppDependencies;
  readonly stores: FakeStores;
  readonly messageStores: FakeMessageStores;
  readonly eventStores: FakeEventStores;
  readonly ruleStores: FakeRuleStores;
  readonly templateStores: FakeTemplateStores;
  readonly contactStores: FakeContactStores;
  readonly carddavClient: ScriptedCarddavClient;
  readonly externalMailStores: FakeExternalMailStores;
  readonly jmapClient: ScriptedJmapClient;
  readonly pop3Client: ScriptedPop3Client;
  readonly smtpSubmissionClient: ScriptedSmtpSubmissionClient;
  readonly clock: FixedClock;
  readonly blobs: MemoryBlobStore;
  readonly mailSender: RecordingMailSender;
  readonly mimeParser: StubMimeParser;
  readonly dns: FakeDnsResolver;
}

export interface CreateFakeDependenciesOptions {
  readonly instanceConfig?: Partial<InstanceConfig>;
  readonly now?: string;
  readonly idPrefix?: string;
  /** Seeds the system tags, as the migrations do. Defaults to true. */
  readonly seedSystemTags?: boolean;
  /** Scripts the fake CardDAV client's canned responses. */
  readonly carddav?: Parameters<typeof scriptedCarddavClient>[0];
  /** Scripts the fake JMAP client's canned responses. */
  readonly jmap?: Parameters<typeof scriptedJmapClient>[0];
  /** Scripts the fake POP3 client's canned responses. */
  readonly pop3?: Parameters<typeof scriptedPop3Client>[0];
  /** Scripts the fake SMTP submission client's canned responses. */
  readonly smtp?: Parameters<typeof scriptedSmtpSubmissionClient>[0];
  /** Set false to simulate a deployment with no FLYING_MAIL_CREDENTIAL_KEY. */
  readonly credentialCipherAvailable?: boolean;
  readonly rateLimiter?: RateLimiter | null;
  readonly turnstileVerifier?: TurnstileVerifier | null;
}

/** Builds a fully in-memory `AppDependencies` plus handles on its backing
 * stores. Every use case test starts here; no adapter is involved. */
export function createFakeDependencies(
  options: CreateFakeDependenciesOptions = {},
): FakeDependencies {
  const now = options.now ?? "2026-08-23T00:00:00.000Z";
  const stores = createFakeStores();
  const messageStores = createFakeMessageStores();
  const eventStores = createFakeEventStores();
  const ruleStores = createFakeRuleStores();
  const templateStores = createFakeTemplateStores();
  const contactStores = createFakeContactStores();
  const carddavClient = scriptedCarddavClient(options.carddav);
  const externalMailStores = createFakeExternalMailStores();
  const jmapClient = scriptedJmapClient(options.jmap);
  const pop3Client = scriptedPop3Client(options.pop3);
  const smtpSubmissionClient = scriptedSmtpSubmissionClient(options.smtp);
  const clock = fixedClock(now);
  const blobs = memoryBlobStore();
  const mailSender = recordingMailSender();
  const dns = fakeDnsResolver();
  const mimeParser = stubMimeParser();

  if (options.seedSystemTags !== false) {
    seedSystemTags(stores, now);
  }

  const deps: AppDependencies = {
    db: unusedSqlDatabase(),
    blobs,
    clock,
    random: sequenceRandom(options.idPrefix ?? "id"),
    tokenHasher: plainTokenHasher(),
    mimeParser,
    mimeBuilder: stubMimeBuilder(),
    mailSender,
    vcardCodec: identityVcardCodec(),
    carddavClient,
    credentialCipher: plainCredentialCipher({
      available: options.credentialCipherAvailable ?? true,
    }),
    templateRenderer: fakeTemplateRenderer(),
    mailDomainRepository: fakeMailDomainRepository(stores),
    mailAddressRepository: fakeMailAddressRepository(stores),
    messageRepository: fakeMessageRepository(messageStores),
    messageEventRepository: createMessageEventRepositoryFake(
      eventStores,
      messageStores,
    ),
    classificationRuleRepository:
      createClassificationRuleRepositoryFake(ruleStores),
    dns,
    tagRepository: fakeTagRepository(stores),
    apiKeyRepository: fakeApiKeyRepository(stores),
    fileLinkRepository: fakeFileLinkRepository(stores),
    userRepository: fakeUserRepository(stores),
    userMailPermissionRepository: fakeUserMailPermissionRepository(stores),
    mailTemplateRepository: fakeMailTemplateRepository(templateStores),
    userTemplatePermissionRepository:
      fakeUserTemplatePermissionRepository(templateStores),
    addressBookRepository: fakeAddressBookRepository(
      contactStores,
      stores.mailAddresses,
    ),
    contactRepository: fakeContactRepository(contactStores),
    carddavAccountRepository: fakeCarddavAccountRepository(contactStores),
    externalMailAccountRepository:
      fakeExternalMailAccountRepository(externalMailStores),
    externalMessageStateRepository:
      fakeExternalMessageStateRepository(externalMailStores),
    rateLimiter: options.rateLimiter ?? null,
    turnstileVerifier: options.turnstileVerifier ?? null,
    jmapClient,
    pop3Client,
    smtpSubmissionClient,
    tcpDialer: recordingTcpDialer(),
    sessionRepository: fakeSessionRepository(stores),
    emailAuthChallengeRepository: fakeEmailAuthChallengeRepository(stores),
    instanceConfig: {
      ...DEFAULT_INSTANCE_CONFIG,
      ...options.instanceConfig,
    },
  };

  return {
    deps,
    stores,
    messageStores,
    eventStores,
    ruleStores,
    templateStores,
    contactStores,
    carddavClient,
    externalMailStores,
    jmapClient,
    pop3Client,
    smtpSubmissionClient,
    clock,
    blobs,
    mailSender,
    mimeParser,
    dns,
  };
}
