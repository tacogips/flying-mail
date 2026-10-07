import {
  createDraftMessage,
  createInboundMessage,
  RecipientKind,
  type MessageRecipient,
} from "@flying-mail/domain/entities/message";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { describe, expect, test } from "vitest";
import { type BadUserInputError, NotFoundError } from "../errors";
import { createFakeDependencies } from "../test-support/fakes";
import {
  adminViewer,
  buildMailPermissions,
  memberViewer,
} from "../test-support/viewer-fixtures";
import { createComposeUseCases } from "./compose-usecases";
import { createListSendableAddressesUseCase } from "./send";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-compose-usecases");

function sourceMessage(draft = false) {
  const input = {
    id: createMessageId(draft ? "draft-source" : "inbound-source"),
    domainId: DOMAIN_ID,
    threadId: createThreadId("thread-source"),
    rfcMessageId: "source@example.net",
    inReplyTo: null,
    references: [],
    subject: "Source subject",
    fromAddress: createEmailAddress("sender@example.net"),
    fromName: null,
    textBody: "source body",
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
  };
  return draft
    ? createDraftMessage(input)
    : createInboundMessage({ ...input, spamScore: null });
}

function saveSource(
  fake: ReturnType<typeof createFakeDependencies>,
  draft = false,
) {
  const message = sourceMessage(draft);
  const recipients: MessageRecipient[] = [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("me@example.com"),
      name: null,
      position: 0,
    },
    {
      kind: RecipientKind.To,
      address: createEmailAddress("me@example.com"),
      name: null,
      position: 0,
    },
  ];
  fake.messageStores.messages.set(message.id, message);
  fake.messageStores.recipients.set(message.id, recipients);
  return message;
}

describe("createComposeUseCases", () => {
  test("returns NOT_FOUND when the source is unreadable", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const message = saveSource(fake);
    const usecases = createComposeUseCases(fake.deps);

    await expect(
      usecases.composeFromMessage(memberViewer(), message.id, "REPLY"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects a readable draft as a compose source", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const draft = saveSource(fake, true);
    const usecases = createComposeUseCases(fake.deps);

    await expect(
      usecases.composeFromMessage(adminViewer(), draft.id, "FORWARD"),
    ).rejects.toMatchObject({
      code: "BAD_USER_INPUT",
      message: "Cannot reply to or forward a draft",
    } satisfies Partial<BadUserInputError>);
  });

  test("loads authorized source relations and computes the prefill", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: DOMAIN_ID,
          name: createDomainName("example.com"),
          catchAll: false,
          verificationToken: "verify-compose",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
    const message = saveSource(fake);
    const usecases = createComposeUseCases(fake.deps);

    await expect(
      usecases.composeFromMessage(adminViewer(), message.id, "REPLY"),
    ).resolves.toMatchObject({
      from: "me@example.com",
      to: ["sender@example.net"],
      subject: "Re: Source subject",
      inReplyToMessageId: message.id,
    });
  });

  test("expands a member wildcard to the catch-all domain for reply-all", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: DOMAIN_ID,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "verify-compose-catchall",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
    const message = saveSource(fake);
    fake.messageStores.recipients.set(message.id, [
      {
        kind: RecipientKind.Envelope,
        address: createEmailAddress("me@example.com"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.To,
        address: createEmailAddress("me@example.com"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.To,
        address: createEmailAddress("coworker@example.net"),
        name: null,
        position: 1,
      },
      {
        kind: RecipientKind.Cc,
        address: createEmailAddress("cc@example.net"),
        name: null,
        position: 0,
      },
    ]);
    const userId = createUserId("usr-compose-catchall");
    const viewer = memberViewer(
      String(userId),
      buildMailPermissions(userId, [
        { effect: "ALLOW", domainId: DOMAIN_ID, addressPattern: "*" },
      ]),
    );
    await expect(
      createListSendableAddressesUseCase(fake.deps)(viewer),
    ).resolves.toEqual(["*"]);

    const usecases = createComposeUseCases(fake.deps);
    await expect(
      usecases.composeFromMessage(viewer, message.id, "REPLY_ALL"),
    ).resolves.toMatchObject({
      from: "me@example.com",
      to: ["sender@example.net"],
      cc: ["coworker@example.net", "cc@example.net"],
    });
  });
});
