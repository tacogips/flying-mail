import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { DeliveryStatus } from "@mailcal/domain/entities/message";
import {
  createMailAddress,
  MailAddressStatus,
  setMailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  createAttachmentId,
  createDomainId,
  createMailAddressId,
  createMessageId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  buildMailPermissions,
  mailboxAgentViewer,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import {
  createListSendableAddressesUseCase,
  createRetrySendUseCase,
  createSendMessageUseCase,
  MAX_RECIPIENTS_PER_MESSAGE,
  type SendMessageInput,
  validateCustomHeaders,
} from "./send";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

/** Under `exactOptionalPropertyTypes`, an explicit `undefined` is not a
 * valid value for an optional property -- but "unset this field" is exactly
 * what several tests need to express. This override type allows it and the
 * helper strips those keys, so `{ text: undefined }` means "send with no
 * text body". */
type SendMessageOverrides = {
  readonly [K in keyof SendMessageInput]?: SendMessageInput[K] | undefined;
};

function baseSend(overrides: SendMessageOverrides = {}): SendMessageInput {
  const merged: Record<string, unknown> = {
    from: "support@example.com",
    to: ["customer@other.com"],
    subject: "Re: your ticket",
    text: "Thanks for reaching out.",
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {
      delete merged[key];
    }
  }
  return merged as unknown as SendMessageInput;
}

describe("sendMessage", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
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
  });

  test("persists the message and delivers it", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(adminViewer(), baseSend());

    expect(message.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(message.fromAddress).toBe("support@example.com");
    expect(fake.mailSender.sent).toHaveLength(1);
    expect(fake.mailSender.sent[0]?.to).toEqual(["customer@other.com"]);
    expect(fake.messageStores.messages.get(message.id)?.deliveryStatus).toBe(
      DeliveryStatus.Sent,
    );
  });

  test("stores the raw source in the object store", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(adminViewer(), baseSend());
    expect(fake.blobs.keys()).toContain(`raw/${message.id}.eml`);
  });

  test("writes the message row before attempting delivery", async () => {
    fake.mailSender.failNext(new Error("MailDeliveryError"));
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(adminViewer(), baseSend());

    // The row exists and is FAILED -- not absent, which is what a
    // send-then-persist ordering would leave behind on a crash.
    expect(message.deliveryStatus).toBe(DeliveryStatus.Failed);
    expect(fake.messageStores.messages.has(message.id)).toBe(true);
    expect(message.deliveryError).toBe("Error");
  });

  test("records only the error class, never provider detail", async () => {
    class MailDeliveryError extends Error {
      constructor() {
        super("failed for customer@other.com re: your ticket");
        this.name = "MailDeliveryError";
      }
    }
    fake.mailSender.failNext(new MailDeliveryError());
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(adminViewer(), baseSend());
    expect(message.deliveryError).toBe("MailDeliveryError");
    expect(message.deliveryError).not.toContain("customer@other.com");
  });

  test("rejects a from address outside any managed domain", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(adminViewer(), baseSend({ from: "me@unmanaged.com" })),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects an unverified domain", async () => {
    await fake.deps.mailDomainRepository.save(
      createMailDomain({
        id: createDomainId("dom-2"),
        name: createDomainName("pending.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
    );
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(adminViewer(), baseSend({ from: "a@pending.com" })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects a key without a matching MAIL_SEND scope", async () => {
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(viewer, baseSend({ from: "billing@example.com" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("allows a key with a matching MAIL_SEND scope", async () => {
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(viewer, baseSend());
    expect(message.deliveryStatus).toBe(DeliveryStatus.Sent);
  });

  test("rejects a read-only key", async () => {
    const viewer = apiKeyViewer([
      { capability: Capability.MailRead, domainId, addressPattern: "*" },
    ]);
    const send = createSendMessageUseCase(fake.deps);
    await expect(send(viewer, baseSend())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("rejects a MEMBER user with no matching ALLOW rule", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await expect(send(memberViewer(), baseSend())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("allows a MEMBER user with a matching ALLOW rule", async () => {
    const userId = createUserId("usr-member-1");
    const permissions = buildMailPermissions(userId, [
      { effect: "ALLOW", domainId, addressPattern: "support@example.com" },
    ]);
    const viewer = memberViewer("usr-member-1", permissions);
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(viewer, baseSend());
    expect(message.deliveryStatus).toBe(DeliveryStatus.Sent);
  });

  test("rejects a VIEWER user, which can never hold MAIL_SEND even with a matching ALLOW rule", async () => {
    const userId = createUserId("usr-viewer-1");
    const permissions = buildMailPermissions(userId, [
      { effect: "ALLOW", domainId, addressPattern: "support@example.com" },
    ]);
    const viewer = viewerViewer("usr-viewer-1", permissions);
    const send = createSendMessageUseCase(fake.deps);
    await expect(send(viewer, baseSend())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test.each([
    ["no recipients", { to: [] }],
    ["no body", { text: undefined, html: undefined }],
    ["malformed recipient", { to: ["not-an-address"] }],
  ])("rejects a send with %s", async (_name, overrides) => {
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(adminViewer(), baseSend(overrides)),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects more than the recipient cap", async () => {
    const to = Array.from(
      { length: MAX_RECIPIENTS_PER_MESSAGE + 1 },
      (_value, index) => `user${index}@other.com`,
    );
    const send = createSendMessageUseCase(fake.deps);
    await expect(send(adminViewer(), baseSend({ to }))).rejects.toBeInstanceOf(
      BadUserInputError,
    );
  });

  test("accepts an html-only body", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const message = await send(
      adminViewer(),
      baseSend({ text: undefined, html: "<p>hi</p>" }),
    );
    expect(message.htmlBody).toBe("<p>hi</p>");
  });

  test("joins the referenced message's thread", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const first = await send(adminViewer(), baseSend());
    const reply = await send(
      adminViewer(),
      baseSend({ inReplyToMessageId: first.id, subject: "Re: again" }),
    );
    expect(reply.threadId).toBe(first.threadId);
    expect(reply.inReplyTo).toBe(first.rfcMessageId);
    expect(reply.references).toContain(first.rfcMessageId);
  });

  test("rejects a reply to an unknown message", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(
        adminViewer(),
        baseSend({ inReplyToMessageId: createMessageId("nope") }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rejects an unknown attachment id", async () => {
    const send = createSendMessageUseCase(fake.deps);
    await expect(
      send(
        adminViewer(),
        baseSend({ attachmentIds: [createAttachmentId("att-nope")] }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("validateCustomHeaders", () => {
  test("accepts X- prefixed headers", () => {
    const headers = validateCustomHeaders([
      { name: "X-Campaign-Id", value: "abc-123" },
    ]);
    expect(headers.get("X-Campaign-Id")).toBe("abc-123");
  });

  test("returns an empty map for no headers", () => {
    expect(validateCustomHeaders(undefined).size).toBe(0);
  });

  test.each([
    ["a non X- name", "Subject"],
    ["a lowercase non X- name", "bcc"],
    ["an empty name", ""],
    ["a name with a space", "X Bad"],
  ])("rejects %s", (_label, name) => {
    expect(() => validateCustomHeaders([{ name, value: "v" }])).toThrow(
      BadUserInputError,
    );
  });

  test.each([
    ["CR", "value\rBcc: attacker@evil.com"],
    ["LF", "value\nBcc: attacker@evil.com"],
    ["CRLF", "value\r\nBcc: attacker@evil.com"],
  ])("rejects a value containing %s (header injection)", (_label, value) => {
    expect(() => validateCustomHeaders([{ name: "X-Note", value }])).toThrow(
      BadUserInputError,
    );
  });
});

describe("retrySend", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
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
  });

  test("re-delivers a failed message", async () => {
    fake.mailSender.failNext(new Error("MailDeliveryError"));
    const send = createSendMessageUseCase(fake.deps);
    const failed = await send(adminViewer(), baseSend());
    expect(failed.deliveryStatus).toBe(DeliveryStatus.Failed);

    const retry = createRetrySendUseCase(fake.deps);
    const retried = await retry(adminViewer(), failed.id);
    expect(retried.deliveryStatus).toBe(DeliveryStatus.Sent);
    expect(fake.mailSender.sent).toHaveLength(1);
  });

  test("refuses to retry a sent message", async () => {
    const send = createSendMessageUseCase(fake.deps);
    const sent = await send(adminViewer(), baseSend());
    const retry = createRetrySendUseCase(fake.deps);
    await expect(retry(adminViewer(), sent.id)).rejects.toBeInstanceOf(
      BadUserInputError,
    );
  });

  test("rejects an unknown message", async () => {
    const retry = createRetrySendUseCase(fake.deps);
    await expect(
      retry(adminViewer(), createMessageId("nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listSendableAddresses", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
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
    await fake.deps.mailDomainRepository.save(
      createMailDomain({
        id: createDomainId("dom-pending"),
        name: createDomainName("pending.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
    );
  });

  /** Provisions a mailbox on the verified test domain. */
  async function provision(localPart: string, active = true) {
    const address = setMailAddressStatus(
      createMailAddress({
        id: createMailAddressId(`addr-${localPart}`),
        domainId,
        domainName: createDomainName("example.com"),
        localPart,
        createdByUserId: null,
        createdAt: NOW,
      }),
      active ? MailAddressStatus.Active : MailAddressStatus.Disabled,
      NOW,
    );
    await fake.deps.mailAddressRepository.save(address);
    return address;
  }

  test("lists provisioned mailboxes concretely once they exist", async () => {
    await provision("support");
    await provision("billing");
    const list = createListSendableAddressesUseCase(fake.deps);
    // Concrete addresses, so a caller can pass one straight back as `from`.
    // Ordered by address, which is the repository's stable listing order.
    expect(await list(adminViewer())).toEqual([
      "billing@example.com",
      "support@example.com",
    ]);
  });

  test("omits a disabled mailbox", async () => {
    await provision("support");
    await provision("closed", false);
    const list = createListSendableAddressesUseCase(fake.deps);
    expect(await list(adminViewer())).toEqual(["support@example.com"]);
  });

  test("a key sees only the provisioned mailboxes its scope covers", async () => {
    await provision("support");
    await provision("billing");
    const list = createListSendableAddressesUseCase(fake.deps);
    const scoped = mailboxAgentViewer(domainId, "support@example.com");
    expect(await list(scoped)).toEqual(["support@example.com"]);
  });

  test("a key with no MAIL_SEND reach on the domain sees nothing", async () => {
    await provision("support");
    const list = createListSendableAddressesUseCase(fake.deps);
    const elsewhere = apiKeyViewer([
      {
        capability: Capability.MailSend,
        domainId: createDomainId("dom-other"),
        addressPattern: "*",
      },
    ]);
    expect(await list(elsewhere)).toEqual([]);
  });

  test("falls back to the pattern form for a domain with no usable mailbox", async () => {
    // Every deployment predating mailbox provisioning looks like this, and
    // emptying its sender picker would be a regression.
    const list = createListSendableAddressesUseCase(fake.deps);
    expect(await list(adminViewer())).toEqual(["*@example.com"]);
  });

  test("a user may send from every verified domain", async () => {
    const list = createListSendableAddressesUseCase(fake.deps);
    expect(await list(adminViewer())).toEqual(["*@example.com"]);
  });

  test("a scoped key sees only its own address", async () => {
    const list = createListSendableAddressesUseCase(fake.deps);
    const viewer = mailboxAgentViewer(domainId, "support@example.com");
    expect(await list(viewer)).toEqual(["support@example.com"]);
  });

  test("a key with no send scope sees nothing", async () => {
    const list = createListSendableAddressesUseCase(fake.deps);
    const viewer = apiKeyViewer([
      { capability: Capability.MailRead, domainId },
    ]);
    expect(await list(viewer)).toEqual([]);
  });
});
