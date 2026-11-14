import {
  createMailDomain,
  DomainStatus,
  setMailDomainStatus,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import {
  createClassificationRule,
  RuleAction,
  RuleField,
  RuleMatcher,
} from "@mailcal/domain/entities/classification-rule";
import { SpamMarkedBy } from "@mailcal/domain/entities/spam-mark";
import { ForbiddenError } from "../errors";
import {
  adminViewer,
  mailboxAgentViewer,
} from "../test-support/viewer-fixtures";
import { createApplyClassificationRuleUseCase } from "./rules";
import { createUserTag } from "@mailcal/domain/entities/tag";
import {
  createMailAddress,
  MailAddressStatus,
  setMailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createClassificationRuleId,
  createTagId,
  createDomainId,
  createMailAddressId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  createReceiveMessageUseCase,
  limitAttachments,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_INBOUND_RAW_BYTES,
  MAX_STORED_BODY_LENGTH,
  type ReceiveMessageInput,
  type ReceiveMessageResult,
} from "./ingest";

/** Narrows a `ReceiveMessageResult` to its STORED variant, failing the test
 * with the actual variant when it is anything else. An assertion function
 * rather than an inline `if`, so the narrowing survives without an
 * unreachable `return` after `expect.fail`. */
function assertStored(
  result: ReceiveMessageResult,
): asserts result is Extract<ReceiveMessageResult, { kind: "STORED" }> {
  if (result.kind !== "STORED") {
    expect.fail(
      `expected the message to be stored, got ${result.kind}${
        result.kind === "REJECTED" ? `: ${result.reason}` : ""
      }`,
    );
  }
}

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

function activeDomain(catchAll = true) {
  return verifyMailDomain(
    createMailDomain({
      id: domainId,
      name: createDomainName("example.com"),
      catchAll,
      verificationToken: "tok",
      createdAt: NOW,
    }),
    NOW,
  );
}

function baseInput(
  overrides: Partial<ReceiveMessageInput> = {},
): ReceiveMessageInput {
  return {
    envelopeFrom: "sender@other.com",
    envelopeTo: "support@example.com",
    raw: new TextEncoder().encode("raw source"),
    rawSize: 10,
    headers: new Map(),
    ...overrides,
  };
}

describe("receiveMessage", () => {
  let fake: FakeDependencies;

  /** Provisions a mailbox on the test domain, bypassing the use case so a
   * delivery test does not depend on the authorization surface. */
  async function provision(
    localPart: string,
    status: MailAddressStatus = MailAddressStatus.Active,
  ) {
    const address = setMailAddressStatus(
      createMailAddress({
        id: createMailAddressId(`addr-${localPart}`),
        domainId,
        domainName: createDomainName("example.com"),
        localPart,
        createdByUserId: null,
        createdAt: NOW,
      }),
      status,
      NOW,
    );
    await fake.deps.mailAddressRepository.save(address);
    return address;
  }

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(activeDomain());
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: "Sender" },
      to: [{ address: "support@example.com", name: null }],
      subject: "Help please",
      messageId: "abc@other.com",
      text: "I need help.",
    });
  });

  test("stores a message with envelope and header recipients", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());

    assertStored(result);
    expect(result.message.subject).toBe("Help please");
    expect(result.message.fromAddress).toBe("sender@other.com");
    expect(result.message.fromName).toBe("Sender");
    expect(result.message.domainId).toBe(domainId);
    expect(result.message.rawKey).toBe(`raw/${result.message.id}.eml`);

    const recipients = fake.messageStores.recipients.get(result.message.id);
    expect(recipients?.map((entry) => entry.kind)).toEqual([
      RecipientKind.Envelope,
      RecipientKind.To,
    ]);
    expect(recipients?.[0]?.address).toBe("support@example.com");
  });

  test("stores the raw source before parsing", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(fake.blobs.keys()).toContain(`raw/${result.message.id}.eml`);
  });

  test("rejects an unknown domain", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({ envelopeTo: "someone@unknown.com" }),
    );
    expect(result).toEqual({
      kind: "REJECTED",
      reason: "Recipient address is not served here",
    });
  });

  test("rejects a disabled domain with the same reason as an unknown one", async () => {
    await fake.deps.mailDomainRepository.save(
      setMailDomainStatus(activeDomain(), DomainStatus.Disabled, NOW),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    expect(result).toEqual({
      kind: "REJECTED",
      reason: "Recipient address is not served here",
    });
  });

  test("rejects a pending (unverified) domain", async () => {
    await fake.deps.mailDomainRepository.save(
      createMailDomain({
        id: createDomainId("dom-2"),
        name: createDomainName("pending.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput({ envelopeTo: "a@pending.com" }));
    expect(result.kind).toBe("REJECTED");
  });

  test.each([
    ["malformed recipient", { envelopeTo: "not-an-address" }],
    ["malformed sender", { envelopeFrom: "not-an-address" }],
  ])("rejects a %s", async (_name, overrides) => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput(overrides));
    expect(result.kind).toBe("REJECTED");
  });

  test("rejects an oversized message before touching storage", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({ rawSize: MAX_INBOUND_RAW_BYTES + 1 }),
    );
    expect(result).toEqual({
      kind: "REJECTED",
      reason: "Message exceeds the maximum accepted size",
    });
    expect(fake.blobs.keys()).toHaveLength(0);
  });

  describe("non-catch-all domains", () => {
    beforeEach(async () => {
      await fake.deps.mailDomainRepository.save(activeDomain(false));
    });

    test("rejects an unknown local part", async () => {
      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      expect(result.kind).toBe("REJECTED");
    });

    test("accepts a known local part", async () => {
      fake.stores.knownAddresses.add("support@example.com");
      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      expect(result.kind).toBe("STORED");
    });

    test("accepts a provisioned address that has never received mail", async () => {
      // The whole point of provisioning: a mailbox is deliverable because
      // an operator said so, not because traffic already happened to it.
      await provision("support");
      const receive = createReceiveMessageUseCase(fake.deps);
      expect((await receive(baseInput())).kind).toBe("STORED");
    });

    test("still rejects a local part nobody provisioned", async () => {
      await provision("support");
      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(
        baseInput({ envelopeTo: "nobody@example.com" }),
      );
      expect(result.kind).toBe("REJECTED");
    });
  });

  describe("provisioned addresses", () => {
    test("a disabled address is refused even on a catch-all domain", async () => {
      // The only way to close one mailbox without closing the domain.
      await fake.deps.mailDomainRepository.save(activeDomain(true));
      await provision("support", MailAddressStatus.Disabled);
      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      expect(result).toMatchObject({
        kind: "REJECTED",
        reason: "Recipient address is not accepting mail",
      });
    });

    test("a disabled address reports differently from an unknown one", async () => {
      await fake.deps.mailDomainRepository.save(activeDomain(false));
      await provision("support", MailAddressStatus.Disabled);
      const receive = createReceiveMessageUseCase(fake.deps);
      const disabled = await receive(baseInput());
      const unknown = await receive(
        baseInput({ envelopeTo: "nobody@example.com" }),
      );
      expect(disabled.kind).toBe("REJECTED");
      expect(unknown.kind).toBe("REJECTED");
      expect(disabled.kind === "REJECTED" ? disabled.reason : "").not.toBe(
        unknown.kind === "REJECTED" ? unknown.reason : "",
      );
    });

    test("re-enabling restores delivery", async () => {
      await fake.deps.mailDomainRepository.save(activeDomain(false));
      const address = await provision("support", MailAddressStatus.Disabled);
      const receive = createReceiveMessageUseCase(fake.deps);
      expect((await receive(baseInput())).kind).toBe("REJECTED");

      await fake.deps.mailAddressRepository.save(
        setMailAddressStatus(address, MailAddressStatus.Active, NOW),
      );
      expect((await receive(baseInput())).kind).toBe("STORED");
    });
  });

  describe("threading", () => {
    test("joins the thread of an In-Reply-To parent", async () => {
      const parent = createInboundMessage({
        id: createMessageId("msg-parent"),
        domainId,
        threadId: createThreadId("thr-existing"),
        rfcMessageId: "parent@other.com",
        inReplyTo: null,
        references: [],
        subject: "Original",
        fromAddress: createEmailAddress("sender@other.com"),
        fromName: null,
        textBody: "first",
        htmlBody: null,
        rawKey: null,
        rawSize: 0,
        occurredAt: NOW,
        createdAt: NOW,
        spamScore: null,
      });
      fake.messageStores.messages.set(parent.id, parent);

      fake.mimeParser.setResult({
        from: { address: "sender@other.com", name: null },
        subject: "Re: Original",
        messageId: "reply@other.com",
        inReplyTo: "parent@other.com",
        text: "reply",
      });

      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      assertStored(result);
      expect(result.message.threadId).toBe("thr-existing");
    });

    test("falls back to a References match", async () => {
      const ancestor = createInboundMessage({
        id: createMessageId("msg-ancestor"),
        domainId,
        threadId: createThreadId("thr-refs"),
        rfcMessageId: "ancestor@other.com",
        inReplyTo: null,
        references: [],
        subject: "Original",
        fromAddress: createEmailAddress("sender@other.com"),
        fromName: null,
        textBody: "first",
        htmlBody: null,
        rawKey: null,
        rawSize: 0,
        occurredAt: NOW,
        createdAt: NOW,
        spamScore: null,
      });
      fake.messageStores.messages.set(ancestor.id, ancestor);

      fake.mimeParser.setResult({
        from: { address: "sender@other.com", name: null },
        subject: "Re: Original",
        messageId: "reply2@other.com",
        inReplyTo: "unknown@other.com",
        references: ["ancestor@other.com"],
        text: "reply",
      });

      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      assertStored(result);
      expect(result.message.threadId).toBe("thr-refs");
    });

    test("starts a new thread rooted at the message itself", async () => {
      const receive = createReceiveMessageUseCase(fake.deps);
      const result = await receive(baseInput());
      assertStored(result);
      expect(result.message.threadId).toBe(result.message.id);
    });
  });

  test("returns the existing message for a duplicate Message-ID", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const first = await receive(baseInput());
    const second = await receive(baseInput());

    assertStored(first);
    expect(second.kind).toBe("DUPLICATE");
    if (second.kind !== "DUPLICATE") {
      return;
    }
    expect(second.message.id).toBe(first.message.id);
    expect(fake.messageStores.messages.size).toBe(1);
  });

  test("skips a malformed Cc address without losing the message", async () => {
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      to: [{ address: "support@example.com", name: null }],
      cc: [
        { address: "not-an-address", name: null },
        { address: "cc@other.com", name: "Cc" },
      ],
      subject: "With bad cc",
      messageId: "cc@other.com",
      text: "body",
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    const recipients = fake.messageStores.recipients.get(result.message.id);
    const ccAddresses = recipients
      ?.filter((entry) => entry.kind === RecipientKind.Cc)
      .map((entry) => entry.address);
    expect(ccAddresses).toEqual(["cc@other.com"]);
  });

  test("truncates an oversized body and flags it", async () => {
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      subject: "Long",
      messageId: "long@other.com",
      text: "x".repeat(MAX_STORED_BODY_LENGTH + 100),
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(result.message.textBody).toHaveLength(MAX_STORED_BODY_LENGTH);
    expect(result.message.bodyTruncated).toBe(true);
  });

  test("stores attachment bodies and rows", async () => {
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      subject: "With attachment",
      messageId: "att@other.com",
      text: "see attached",
      attachments: [
        {
          fileName: "../report.pdf",
          contentType: "application/pdf",
          content: new Uint8Array([1, 2, 3]),
          contentId: null,
          inline: false,
        },
      ],
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    const attachments = [...fake.messageStores.attachments.values()];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fileName).toBe("report.pdf");
    expect(fake.blobs.keys()).toContain(attachments[0]?.blobKey);
  });

  test("applies the SPAM tag above the threshold", async () => {
    fake.mimeParser.setResult({
      from: { address: "spoofed@evil.com", name: null },
      subject: "Free money",
      messageId: "spam@evil.com",
      text: "click here",
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({
        headers: new Map([
          ["authentication-results", "spf=fail; dkim=fail; dmarc=fail"],
        ]),
      }),
    );
    assertStored(result);
    expect(result.message.spamScore).toBeGreaterThanOrEqual(0.6);
    const mark = fake.messageStores.spamMarks.get(result.message.id);
    expect(mark?.markedBy).toBe(SpamMarkedBy.System);
    expect(mark?.score).toBe(result.message.spamScore);
  });

  test("does not tag clean mail as spam", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({
        headers: new Map([["authentication-results", "spf=pass; dkim=pass"]]),
      }),
    );
    assertStored(result);
    expect(fake.messageStores.messageTags.get(result.message.id)?.size).toBe(0);
  });
});

describe("limitAttachments", () => {
  const attachment = (bytes: number) => ({
    fileName: "f.bin",
    contentType: "application/octet-stream",
    content: new Uint8Array(bytes),
    contentId: null,
    inline: false,
  });

  test("keeps everything under the caps", () => {
    const input = [attachment(10), attachment(20)];
    expect(limitAttachments(input)).toHaveLength(2);
  });

  test("caps the attachment count", () => {
    const input = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 5 }, () =>
      attachment(1),
    );
    expect(limitAttachments(input)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  test("caps the total byte size", () => {
    const input = [attachment(20 * 1024 * 1024), attachment(20 * 1024 * 1024)];
    expect(limitAttachments(input)).toHaveLength(1);
  });
});

describe("spam signals from the raw message", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(activeDomain());
  });

  test("falls back to the parsed Authentication-Results header", async () => {
    // The transport supplied no headers -- as the local dev ingest route
    // does -- so the signal has to come from the message itself.
    fake.mimeParser.setResult({
      from: { address: "spoofed@evil.com", name: null },
      subject: "Urgent",
      messageId: "spam-parsed@evil.com",
      text: "click here",
      headers: new Map([
        ["authentication-results", "mx1; spf=fail; dkim=fail; dmarc=fail"],
      ]),
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput({ headers: new Map() }));
    assertStored(result);
    expect(result.message.spamScore).toBeGreaterThanOrEqual(0.6);

    expect(fake.messageStores.spamMarks.get(result.message.id)?.markedBy).toBe(
      SpamMarkedBy.System,
    );
  });

  test("the transport's headers win over the parsed ones", async () => {
    // Cloudflare's own headers are authoritative: a message that forged a
    // passing Authentication-Results into its body must not override them.
    fake.mimeParser.setResult({
      from: { address: "spoofed@evil.com", name: null },
      subject: "Urgent",
      messageId: "spam-forged@evil.com",
      text: "click here",
      headers: new Map([["authentication-results", "spf=pass; dkim=pass"]]),
    });

    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({
        headers: new Map([
          ["authentication-results", "spf=fail; dkim=fail; dmarc=fail"],
        ]),
      }),
    );
    assertStored(result);
    expect(result.message.spamScore).toBeGreaterThanOrEqual(0.6);
  });
});

describe("mailing-list detection and classification rules", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(activeDomain());
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: "Sender" },
      to: [{ address: "support@example.com", name: null }],
      subject: "Weekly digest",
      messageId: "list1@other.com",
      text: "content",
    });
  });

  test("a List-Id header marks the message and stores the identifier", async () => {
    fake.mimeParser.setResult({
      from: { address: "sender@other.com", name: null },
      to: [{ address: "support@example.com", name: null }],
      subject: "Weekly digest",
      messageId: "list1@other.com",
      text: "content",
      headers: new Map([["list-id", "Dev Chat <dev.lists.other.com>"]]),
    });
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(result.message.isMailingList).toBe(true);
    expect(result.message.listId).toBe("dev.lists.other.com");
  });

  test("List-Unsubscribe or bulk precedence flags without a list id", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(
      baseInput({
        headers: new Map([["list-unsubscribe", "<mailto:u@other.com>"]]),
      }),
    );
    assertStored(result);
    expect(result.message.isMailingList).toBe(true);
    expect(result.message.listId).toBeNull();
  });

  test("ordinary mail is not flagged", async () => {
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(result.message.isMailingList).toBe(false);
  });

  test("a sender-domain SPAM rule marks the message, attributed to RULE", async () => {
    fake.ruleStores.rules.set(
      "rule-1",
      createClassificationRule({
        id: createClassificationRuleId("rule-1"),
        domainId: null,
        field: RuleField.SenderDomain,
        matcher: RuleMatcher.Exact,
        pattern: "other.com",
        action: RuleAction.Spam,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(fake.messageStores.spamMarks.get(result.message.id)?.markedBy).toBe(
      SpamMarkedBy.Rule,
    );
  });

  test("a TAG rule applies its tag at receive time", async () => {
    const tagId = createTagId("tag-newsletter");
    fake.stores.tags.set(
      tagId,
      createUserTag({
        id: tagId,
        name: "Newsletters",
        color: null,
        createdAt: NOW,
      }),
    );
    fake.ruleStores.rules.set(
      "rule-2",
      createClassificationRule({
        id: createClassificationRuleId("rule-2"),
        domainId: null,
        field: RuleField.Subject,
        matcher: RuleMatcher.Contains,
        pattern: "digest",
        action: RuleAction.Tag,
        tagId,
        description: null,
        createdAt: NOW,
      }),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(
      fake.messageStores.messageTags.get(result.message.id)?.has(tagId),
    ).toBe(true);
  });

  test("a MAILING_LIST rule flags list traffic that lacks list headers", async () => {
    fake.ruleStores.rules.set(
      "rule-3",
      createClassificationRule({
        id: createClassificationRuleId("rule-3"),
        domainId: null,
        field: RuleField.SenderAddress,
        matcher: RuleMatcher.Regex,
        pattern: "^sender@",
        action: RuleAction.MailingList,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(result.message.isMailingList).toBe(true);
  });

  test("a rule scoped to a different domain does not fire", async () => {
    fake.ruleStores.rules.set(
      "rule-4",
      createClassificationRule({
        id: createClassificationRuleId("rule-4"),
        domainId: createDomainId("dom-other"),
        field: RuleField.SenderDomain,
        matcher: RuleMatcher.Exact,
        pattern: "other.com",
        action: RuleAction.Spam,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );
    const receive = createReceiveMessageUseCase(fake.deps);
    const result = await receive(baseInput());
    assertStored(result);
    expect(fake.messageStores.spamMarks.has(result.message.id)).toBe(false);
  });
});

describe("applyClassificationRule (retroactive)", () => {
  test("marks matching stored mail and leaves the rest alone", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await fake.deps.mailDomainRepository.save(activeDomain());
    fake.mimeParser.setResult({
      from: { address: "noreply@shop.example", name: null },
      to: [{ address: "support@example.com", name: null }],
      subject: "Sale",
      messageId: "old1@shop.example",
      text: "buy",
    });
    const receive = createReceiveMessageUseCase(fake.deps);
    const stored = await receive(
      baseInput({ envelopeFrom: "noreply@shop.example" }),
    );
    assertStored(stored);
    fake.mimeParser.setResult({
      from: { address: "friend@other.com", name: null },
      to: [{ address: "support@example.com", name: null }],
      subject: "Hi",
      messageId: "old2@other.com",
      text: "hello",
    });
    const kept = await receive(baseInput());
    assertStored(kept);

    // The rule arrives AFTER both messages did.
    const ruleId = createClassificationRuleId("rule-late");
    fake.ruleStores.rules.set(
      ruleId,
      createClassificationRule({
        id: ruleId,
        domainId: null,
        field: RuleField.SenderDomain,
        matcher: RuleMatcher.Exact,
        pattern: "shop.example",
        action: RuleAction.Spam,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );

    const apply = createApplyClassificationRuleUseCase(fake.deps);
    const outcome = await apply(adminViewer(), ruleId);
    expect(outcome.examined).toBe(2);
    expect(outcome.matched).toBe(1);
    expect(fake.messageStores.spamMarks.get(stored.message.id)?.markedBy).toBe(
      SpamMarkedBy.Rule,
    );
    expect(fake.messageStores.spamMarks.has(kept.message.id)).toBe(false);
  });

  test("requires DOMAIN_ADMIN", async () => {
    const fake = createFakeDependencies({ now: NOW });
    const ruleId = createClassificationRuleId("rule-x");
    fake.ruleStores.rules.set(
      ruleId,
      createClassificationRule({
        id: ruleId,
        domainId: null,
        field: RuleField.Subject,
        matcher: RuleMatcher.Contains,
        pattern: "x",
        action: RuleAction.Spam,
        tagId: null,
        description: null,
        createdAt: NOW,
      }),
    );
    const apply = createApplyClassificationRuleUseCase(fake.deps);
    await expect(
      apply(mailboxAgentViewer(domainId, "support@example.com"), ruleId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
