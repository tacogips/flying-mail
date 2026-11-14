import type { AppDependencies, InstanceConfig } from "../dependencies";
import {
  createFakeCalendarStores,
  type FakeCalendarStores,
  fakeCaldavAccountRepository,
  fakeCalendarEventRepository,
  fakeCalendarRepository,
  fakeUserCalendarPermissionRepository,
  plainCredentialCipher,
  type ScriptedCaldavClient,
  scriptedCaldavClient,
  unusedIcsCodec,
} from "./calendar-fakes";
import {
  createFakeTemplateStores,
  type FakeTemplateStores,
  fakeMailTemplateRepository,
  fakeTemplateRenderer,
  fakeUserTemplatePermissionRepository,
} from "./template-fakes";
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

export * from "./calendar-fakes";
export * from "./message-repository-fake";
export * from "./repository-fakes";
export * from "./runtime-fakes";
export * from "./template-fakes";

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  signupMode: "closed",
  publicOrigin: "https://mail.example.com",
  mailFrom: "postmaster@example.com",
  spamThreshold: 0.6,
  spamPhrases: [],
  fileLinkMaxTtlSeconds: 604800,
};

/** Everything a test may want to reach into after driving a use case. */
export interface FakeDependencies {
  readonly deps: AppDependencies;
  readonly stores: FakeStores;
  readonly messageStores: FakeMessageStores;
  readonly eventStores: FakeEventStores;
  readonly ruleStores: FakeRuleStores;
  readonly calendarStores: FakeCalendarStores;
  readonly templateStores: FakeTemplateStores;
  readonly caldavClient: ScriptedCaldavClient;
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
  /** Replaces the failing default ICS codec for tests that exercise CalDAV
   * sync end to end. */
  readonly icsCodec?: AppDependencies["icsCodec"];
  /** Scripts the fake CalDAV client's canned responses. */
  readonly caldav?: Parameters<typeof scriptedCaldavClient>[0];
  /** Set false to simulate a deployment with no MAILCAL_CREDENTIAL_KEY. */
  readonly credentialCipherAvailable?: boolean;
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
  // Shares the message stores' attachment map, so an attachment staged via
  // `messageRepository` is the same object an event can claim -- exactly as
  // the two tables share `attachments` in D1.
  const calendarStores = createFakeCalendarStores(messageStores.attachments);
  const templateStores = createFakeTemplateStores();
  const calendarPermissions = new Map<
    string,
    import("@mailcal/domain/entities/user-calendar-permission").UserCalendarPermission
  >();
  const caldavClient = scriptedCaldavClient(options.caldav);
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
    icsCodec: options.icsCodec ?? unusedIcsCodec(),
    caldavClient,
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
    userCalendarPermissionRepository:
      fakeUserCalendarPermissionRepository(calendarPermissions),
    calendarRepository: fakeCalendarRepository(calendarStores),
    calendarEventRepository: fakeCalendarEventRepository(calendarStores),
    caldavAccountRepository: fakeCaldavAccountRepository(calendarStores),
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
    calendarStores,
    templateStores,
    caldavClient,
    clock,
    blobs,
    mailSender,
    mimeParser,
    dns,
  };
}
