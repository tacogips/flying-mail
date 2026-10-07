import {
  createOutboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  createReceiveMessageUseCase,
  type ReceiveMessageInput,
} from "./ingest";
import { beforeEach, describe, expect, test, vi } from "vitest";

const NOW = "2026-08-23T00:00:00.000Z";
const T_ID = createDomainId("dom-t");
const M_ID = createDomainId("dom-m");

function activeDomain(id: string, name: string) {
  return verifyMailDomain(
    createMailDomain({
      id: createDomainId(id),
      name: createDomainName(name),
      catchAll: true,
      verificationToken: "tok",
      createdAt: NOW,
    }),
    NOW,
  );
}

function input(
  to: string,
  headers = new Map<string, string>(),
): ReceiveMessageInput {
  return {
    envelopeFrom: "sender@outside.example",
    envelopeTo: to,
    raw: new TextEncoder().encode("raw source"),
    rawSize: 10,
    headers,
  };
}

function tracedRaw(recipient: string, timestamp: string): Uint8Array {
  return new TextEncoder().encode(
    `Received: from mx.example by mx.cloudflare.net for <${recipient}>; Tue, 07 Oct 2026 10:00:00 +0000\r\nARC-Seal: i=1; t=${timestamp}; b=aaa\r\nFrom: sender@outside.example\r\nMessage-ID: <shared@outside.example>\r\nSubject: Hello\r\n\r\nHello\r\n`,
  );
}

function outbound(domainId: ReturnType<typeof createDomainId>, id: string) {
  return createOutboundMessage({
    id: createMessageId(`out-${id}`),
    domainId,
    threadId: createThreadId(`thread-${id}`),
    rfcMessageId: id,
    inReplyTo: null,
    references: [],
    subject: "Original",
    fromAddress: createEmailAddress("sender@tacoserve.online"),
    fromName: null,
    textBody: "body",
    htmlBody: null,
    rawKey: null,
    rawSize: 0,
    occurredAt: NOW,
    createdAt: NOW,
  });
}

describe("receiveMessage multi-domain behavior", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(
      activeDomain("dom-t", "tacoserve.online"),
    );
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      to: [{ address: "alice@tacoserve.online", name: null }],
      subject: "Hello",
      messageId: "shared@outside.example",
      text: "Hello",
    });
  });

  test("same-domain duplicate adds an envelope recipient after raw verification", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();

    const duplicate = await receive(
      input(
        "bob@tacoserve.online",
        new Map([["message-id", " <shared@outside.example> "]]),
      ),
    );

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    const envelopes = fake.messageStores.recipients
      .get(stored.id)
      ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
      .map((recipient) => recipient.address);
    expect(envelopes).toEqual([
      "alice@tacoserve.online",
      "bob@tacoserve.online",
    ]);
  });

  test("post-parse duplicate adds the envelope and deletes the raw blob", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();

    const duplicate = await receive(input("bob@tacoserve.online"));

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online", "bob@tacoserve.online"]);
  });

  test("post-parse duplicate merges deliveries with different leading trace headers", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const firstRaw = tracedRaw("alice@tacoserve.online", "1000");
    const first = await receive({
      ...input("alice@tacoserve.online"),
      raw: firstRaw,
      rawSize: firstRaw.length,
    });
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();

    const candidateRaw = tracedRaw("bob@tacoserve.online", "1001");
    const duplicate = await receive({
      ...input("bob@tacoserve.online"),
      raw: candidateRaw,
      rawSize: candidateRaw.length,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online", "bob@tacoserve.online"]);
  });

  test("does not merge an equal-length forged remainder with matching trace headers", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const originalRaw = tracedRaw("alice@tacoserve.online", "1000");
    const original = await receive({
      ...input("alice@tacoserve.online"),
      raw: originalRaw,
      rawSize: originalRaw.length,
    });
    expect(original.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    const forgedRaw = new TextEncoder().encode(
      new TextDecoder()
        .decode(originalRaw)
        .replace("Subject: Hello", "Subject: Jello"),
    );
    expect(forgedRaw.length).toBe(originalRaw.length);

    const duplicate = await receive({
      ...input("bob@tacoserve.online"),
      raw: forgedRaw,
      rawSize: forgedRaw.length,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("does not strip a Received field after the first non-trace header", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const originalRaw = new TextEncoder().encode(
      "From: sender@outside.example\r\nReceived: by mx1\r\nMessage-ID: <shared@outside.example>\r\nSubject: Hello\r\n\r\nHello\r\n",
    );
    const original = await receive({
      ...input("alice@tacoserve.online"),
      raw: originalRaw,
      rawSize: originalRaw.length,
    });
    expect(original.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    const forgedRaw = new TextEncoder().encode(
      "From: sender@outside.example\r\nReceived: by mx2\r\nMessage-ID: <shared@outside.example>\r\nSubject: Hello\r\n\r\nHello\r\n",
    );
    expect(forgedRaw.length).toBe(originalRaw.length);

    const duplicate = await receive({
      ...input("bob@tacoserve.online"),
      raw: forgedRaw,
      rawSize: forgedRaw.length,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("concurrent same-domain duplicate cleans this call's raw and attachment blobs", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      subject: "Hello",
      messageId: "shared@outside.example",
      to: [{ address: "alice@tacoserve.online", name: null }],
      text: "Hello",
      attachments: [
        {
          fileName: "race.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("attachment"),
          contentId: null,
          inline: false,
        },
      ],
    });
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    const repository = fake.deps.messageRepository;
    const findInbound = repository.findInboundByRfcMessageId.bind(repository);
    let lookups = 0;
    repository.findInboundByRfcMessageId = async (rfc, domainId) => {
      if (lookups < 2) {
        lookups += 1;
        return null;
      }
      return findInbound(rfc, domainId);
    };
    const duplicate = await receive(
      input(
        "bob@tacoserve.online",
        new Map([["message-id", "<shared@outside.example>"]]),
      ),
    );

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online", "bob@tacoserve.online"]);
  });

  test("duplicate-insert race merges deliveries with different leading trace headers", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      to: [{ address: "alice@tacoserve.online", name: null }],
      subject: "Hello",
      messageId: "shared@outside.example",
      text: "Hello",
      attachments: [
        {
          fileName: "trace-race.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("race attachment"),
          contentId: null,
          inline: false,
        },
      ],
    });
    const firstRaw = tracedRaw("alice@tacoserve.online", "1000");
    const first = await receive({
      ...input("alice@tacoserve.online"),
      raw: firstRaw,
      rawSize: firstRaw.length,
    });
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    const repository = fake.deps.messageRepository;
    const findInbound = repository.findInboundByRfcMessageId.bind(repository);
    let lookups = 0;
    repository.findInboundByRfcMessageId = async (rfc, domainId) => {
      if (lookups < 2) {
        lookups += 1;
        return null;
      }
      return findInbound(rfc, domainId);
    };

    const candidateRaw = tracedRaw("bob@tacoserve.online", "1001");
    const duplicate = await receive({
      ...input(
        "bob@tacoserve.online",
        new Map([["message-id", "<shared@outside.example>"]]),
      ),
      raw: candidateRaw,
      rawSize: candidateRaw.length,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online", "bob@tacoserve.online"]);
  });

  test("does not merge a forged header Message-ID with a different sender", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    fake.mimeParser.setResult({
      from: { address: "eve@evil.example", name: "Eve" },
      to: [{ address: "bob@tacoserve.online", name: null }],
      subject: "Hello",
      messageId: "shared@outside.example",
      text: "Hello",
    });

    const duplicate = await receive({
      ...input(
        "bob@tacoserve.online",
        new Map([["message-id", "<shared@outside.example>"]]),
      ),
      raw: new TextEncoder().encode("forged sender payload"),
      rawSize: 21,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("does not merge a header-absent forged Message-ID with a different subject", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      to: [{ address: "bob@tacoserve.online", name: null }],
      subject: "Forged subject",
      messageId: "shared@outside.example",
      text: "Hello",
    });

    const duplicate = await receive({
      ...input("bob@tacoserve.online"),
      raw: new TextEncoder().encode("forged subject payload"),
      rawSize: 22,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("does not merge matching parsed fields when raw attachments differ", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      to: [{ address: "bob@tacoserve.online", name: null }],
      subject: "Hello",
      messageId: "shared@outside.example",
      text: "Hello",
      attachments: [
        {
          fileName: "forged.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("different attachment"),
          contentId: null,
          inline: false,
        },
      ],
    });

    const duplicate = await receive({
      ...input("bob@tacoserve.online"),
      raw: new TextEncoder().encode("raw source with different attachment"),
      rawSize: 36,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("does not merge a forged Message-ID in the duplicate-insert race", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");
    const keysBefore = fake.blobs.keys();
    const repository = fake.deps.messageRepository;
    const findInbound = repository.findInboundByRfcMessageId.bind(repository);
    let lookups = 0;
    repository.findInboundByRfcMessageId = async (rfc, domainId) => {
      if (lookups < 2) {
        lookups += 1;
        return null;
      }
      return findInbound(rfc, domainId);
    };
    fake.mimeParser.setResult({
      from: { address: "sender@outside.example", name: "Sender" },
      to: [{ address: "bob@tacoserve.online", name: null }],
      subject: "Hello",
      messageId: "shared@outside.example",
      text: "Hello",
      attachments: [
        {
          fileName: "forged.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("different attachment"),
          contentId: null,
          inline: false,
        },
      ],
    });

    const duplicate = await receive({
      ...input(
        "bob@tacoserve.online",
        new Map([["message-id", "<shared@outside.example>"]]),
      ),
      raw: new TextEncoder().encode("raw source with different attachment"),
      rawSize: 36,
    });

    expect(duplicate.kind).toBe("DUPLICATE");
    expect(fake.messageStores.messages.size).toBe(1);
    expect(fake.blobs.keys()).toEqual(keysBefore);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("same-recipient retry exits before writing another raw blob", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const headers = new Map([["message-id", "<shared@outside.example>"]]);
    const first = await receive(input("alice@tacoserve.online", headers));
    expect(first.kind).toBe("STORED");
    const put = vi.spyOn(fake.blobs, "put");

    const retry = await receive(input("alice@tacoserve.online", headers));

    expect(retry.kind).toBe("DUPLICATE");
    expect(put).not.toHaveBeenCalled();
    expect(fake.messageStores.messages.size).toBe(1);
    const stored = [...fake.messageStores.messages.values()][0];
    if (stored === undefined) {
      throw new Error("expected the stored inbound message");
    }
    expect(
      fake.messageStores.recipients
        .get(stored.id)
        ?.filter((recipient) => recipient.kind === RecipientKind.Envelope)
        .map((recipient) => recipient.address),
    ).toEqual(["alice@tacoserve.online"]);
  });

  test("same Message-ID on another domain creates a domain row sharing its thread", async () => {
    await fake.deps.mailDomainRepository.save(
      activeDomain("dom-m", "mutvar-test.online"),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(input("alice@tacoserve.online"));
    expect(first.kind).toBe("STORED");

    const second = await receive(input("bob@mutvar-test.online"));

    expect(second.kind).toBe("STORED");
    if (second.kind !== "STORED" || first.kind !== "STORED") return;
    expect(fake.messageStores.messages.size).toBe(2);
    expect(second.message.domainId).toBe(M_ID);
    expect(second.message.threadId).toBe(first.message.threadId);
    expect(
      fake.messageStores.recipients
        .get(second.message.id)
        ?.map((r) => r.address),
    ).toContain("bob@mutvar-test.online");
  });

  test("an outbound row is not deduplicated and provides cross-domain threading", async () => {
    await fake.deps.mailDomainRepository.save(
      activeDomain("dom-m", "mutvar-test.online"),
    );
    const original = outbound(T_ID, "outbound@tacoserve.online");
    fake.messageStores.messages.set(original.id, original);
    fake.mimeParser.setResult({ messageId: original.rfcMessageId });

    const result = await createReceiveMessageUseCase(fake.deps)(
      input("bob@mutvar-test.online"),
    );

    expect(result.kind).toBe("STORED");
    if (result.kind !== "STORED") return;
    expect(result.message.direction).toBe("INBOUND");
    expect(result.message.domainId).toBe(M_ID);
    expect(result.message.threadId).toBe(original.threadId);
  });

  test("an outbound same-domain row does not suppress inbound delivery", async () => {
    const original = outbound(T_ID, "same-domain@tacoserve.online");
    fake.messageStores.messages.set(original.id, original);
    fake.mimeParser.setResult({ messageId: original.rfcMessageId });

    const result = await createReceiveMessageUseCase(fake.deps)(
      input("carol@tacoserve.online"),
    );

    expect(result.kind).toBe("STORED");
    expect(
      [...fake.messageStores.messages.values()].filter(
        (m) => m.rfcMessageId === original.rfcMessageId,
      ),
    ).toHaveLength(2);
  });

  test("messages without Message-ID are not deduplicated", async () => {
    fake.mimeParser.setResult({ messageId: null });
    const receive = createReceiveMessageUseCase(fake.deps);
    expect((await receive(input("alice@tacoserve.online"))).kind).toBe(
      "STORED",
    );
    expect((await receive(input("alice@tacoserve.online"))).kind).toBe(
      "STORED",
    );
    expect(fake.messageStores.messages.size).toBe(2);
  });

  test("stores the first valid Reply-To address", async () => {
    fake.mimeParser.setResult({
      replyTo: [
        { address: "not-an-address", name: null },
        { address: "reply@outside.example", name: "Reply" },
      ],
    });

    const result = await createReceiveMessageUseCase(fake.deps)(
      input("alice@tacoserve.online"),
    );

    expect(result.kind).toBe("STORED");
    if (result.kind === "STORED") {
      expect(result.message.replyTo).toBeNull();
    }
  });

  test("stores parsed Reply-To when the first address is valid", async () => {
    fake.mimeParser.setResult({
      replyTo: [{ address: "reply@outside.example", name: "Reply" }],
    });

    const result = await createReceiveMessageUseCase(fake.deps)(
      input("alice@tacoserve.online"),
    );

    expect(result.kind).toBe("STORED");
    if (result.kind === "STORED") {
      expect(result.message.replyTo).toBe("reply@outside.example");
    }
  });

  test("precheck dedup never matches an outbound row", async () => {
    const original = outbound(T_ID, "header-id@tacoserve.online");
    fake.messageStores.messages.set(original.id, original);
    fake.mimeParser.setResult({ messageId: null });

    const result = await createReceiveMessageUseCase(fake.deps)(
      input(
        "alice@tacoserve.online",
        new Map([["message-id", "<header-id@tacoserve.online>"]]),
      ),
    );

    expect(result.kind).toBe("STORED");
  });
});
