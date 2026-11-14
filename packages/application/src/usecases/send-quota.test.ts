import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { RateLimitedError } from "../errors";
import { RateLimiterUnavailableError } from "../ports/rate-limiter";
import { createFakeRateLimiter } from "../test-support/auth-hardening-fakes";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, apiKeyViewer } from "../test-support/viewer-fixtures";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { createSaveDraftUseCase, createSendDraftUseCase } from "./drafts";
import { createSendMessageUseCase } from "./send";
import { createUseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

async function seedDomain(fake: FakeDependencies): Promise<void> {
  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
      NOW,
    ),
  );
}

const input = {
  from: "support@example.com",
  to: ["customer@other.com"],
  subject: "Hello",
  text: "body",
};

describe("send quota: per-credential rate limiter", () => {
  test("a denied limiter key refuses the send before anything is stored", async () => {
    const { limiter, keys } = createFakeRateLimiter({
      deny: new Set(["send:user:usr-admin"]),
    });
    const fake = createFakeDependencies({ now: NOW, rateLimiter: limiter });
    await seedDomain(fake);

    await expect(
      createSendMessageUseCase(fake.deps)(adminViewer(), input),
    ).rejects.toBeInstanceOf(RateLimitedError);

    expect(keys).toEqual(["send:user:usr-admin"]);
    expect(fake.messageStores.messages.size).toBe(0);
    expect(fake.mailSender.sent).toHaveLength(0);
  });

  test("an API key is limited under its own key", async () => {
    const { limiter, keys } = createFakeRateLimiter({
      deny: new Set(["send:key:key-7"]),
    });
    const fake = createFakeDependencies({ now: NOW, rateLimiter: limiter });
    await seedDomain(fake);
    const viewer = apiKeyViewer(
      [{ capability: Capability.MailSend, domainId, addressPattern: "*" }],
      "key-7",
    );

    await expect(
      createSendMessageUseCase(fake.deps)(viewer, input),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(keys).toEqual(["send:key:key-7"]);
  });

  test("a limiter outage fails open for sends, but the daily budget still applies", async () => {
    const fake = createFakeDependencies({
      now: NOW,
      rateLimiter: {
        async limit(): Promise<boolean> {
          throw new RateLimiterUnavailableError("binding down");
        },
      },
      instanceConfig: { maxSendsPerDomainPerDay: 1 },
    });
    await seedDomain(fake);
    const send = createSendMessageUseCase(fake.deps);

    await expect(send(adminViewer(), input)).resolves.toMatchObject({
      fromAddress: "support@example.com",
    });
    await expect(send(adminViewer(), input)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  test("a null limiter skips the burst check", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedDomain(fake);
    const sent = await createSendMessageUseCase(fake.deps)(
      adminViewer(),
      input,
    );
    expect(sent.fromAddress).toBe("support@example.com");
  });

  test("a denied limiter also refuses sending a draft and leaves it a draft", async () => {
    const { limiter } = createFakeRateLimiter({
      deny: new Set(["send:user:usr-admin"]),
    });
    const fake = createFakeDependencies({ now: NOW });
    await seedDomain(fake);
    const draft = await createSaveDraftUseCase(fake.deps)(adminViewer(), input);

    const limited = createFakeDependencies({ now: NOW, rateLimiter: limiter });
    limited.messageStores.messages.set(draft.id, draft);
    limited.messageStores.recipients.set(
      draft.id,
      fake.messageStores.recipients.get(draft.id) ?? [],
    );
    await seedDomain(limited);

    await expect(
      createSendDraftUseCase(limited.deps)(adminViewer(), draft.id),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(limited.messageStores.messages.get(draft.id)?.status).toBe("DRAFT");
    expect(limited.mailSender.sent).toHaveLength(0);
  });
});

describe("send quota: daily per-domain budget", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({
      now: NOW,
      instanceConfig: { maxSendsPerDomainPerDay: 2 },
    });
    await seedDomain(fake);
  });

  test("refuses the send that would exceed the budget", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await send(adminViewer(), input);
    await send(adminViewer(), input);

    await expect(send(adminViewer(), input)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fake.mailSender.sent).toHaveLength(2);
    expect(fake.messageStores.messages.size).toBe(2);
  });

  test("applies to sending a draft, and drafts themselves do not count", async () => {
    const save = createSaveDraftUseCase(fake.deps);
    const draftA = await save(adminViewer(), input);
    const draftB = await save(adminViewer(), input);
    const draftC = await save(adminViewer(), input);
    const sendDraft = createSendDraftUseCase(fake.deps);

    await sendDraft(adminViewer(), draftA.id);
    await sendDraft(adminViewer(), draftB.id);
    await expect(sendDraft(adminViewer(), draftC.id)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(fake.messageStores.messages.get(draftC.id)?.status).toBe("DRAFT");
  });

  test("applies to a templated send because it goes through the send use case", async () => {
    const usecases = createUseCases(fake.deps);
    const template = await usecases.createMailTemplate(adminViewer(), {
      name: "Receipt",
      subject: "Receipt",
      textBody: "Thanks",
      from: "support@example.com",
      to: ["customer@other.com"],
      variables: [],
    });
    await usecases.sendTemplatedMessage(adminViewer(), {
      templateId: template.id,
      values: [],
    });
    await usecases.sendTemplatedMessage(adminViewer(), {
      templateId: template.id,
      values: [],
    });

    await expect(
      usecases.sendTemplatedMessage(adminViewer(), {
        templateId: template.id,
        values: [],
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(fake.mailSender.sent).toHaveLength(2);
  });

  test("messages older than 24 hours fall out of the window", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await send(adminViewer(), input);
    await send(adminViewer(), input);
    await expect(send(adminViewer(), input)).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    fake.clock.advanceSeconds(24 * 60 * 60 + 1);
    await expect(send(adminViewer(), input)).resolves.toMatchObject({
      fromAddress: "support@example.com",
    });
  });

  test("the budget is per domain", async () => {
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: createDomainId("dom-2"),
          name: createDomainName("other.example"),
          catchAll: true,
          verificationToken: "tok2",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
    const send = createSendMessageUseCase(fake.deps);
    await send(adminViewer(), input);
    await send(adminViewer(), input);

    await expect(
      send(adminViewer(), { ...input, from: "hello@other.example" }),
    ).resolves.toMatchObject({ fromAddress: "hello@other.example" });
  });
});
