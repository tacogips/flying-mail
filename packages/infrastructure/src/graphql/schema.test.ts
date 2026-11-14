import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  mailboxAgentViewer,
  memberViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { createAttachment } from "@mailcal/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  createInboundMessage,
  RecipientKind,
} from "@mailcal/domain/entities/message";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness as Harness,
} from "./graphql-test-support";
import { buildGraphQLSchema } from "./schema";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

async function createHarness(): Promise<Harness> {
  const fake = createFakeDependencies({ now: NOW });

  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "secret-token",
        createdAt: NOW,
      }),
      NOW,
    ),
  );

  return createGraphQLHarness(fake);
}

function seedMessage(
  fake: FakeDependencies,
  options: { readonly id: string; readonly to: string },
): void {
  const messageId = createMessageId(options.id);
  fake.messageStores.messages.set(
    messageId,
    createInboundMessage({
      id: messageId,
      domainId,
      threadId: createThreadId("thr-1"),
      rfcMessageId: `${options.id}@other.com`,
      inReplyTo: null,
      references: [],
      subject: `Subject ${options.id}`,
      fromAddress: createEmailAddress("sender@other.com"),
      fromName: "Sender",
      textBody: "body text",
      htmlBody: null,
      rawKey: `raw/${options.id}.eml`,
      rawSize: 100,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: 0.1,
    }),
  );
  fake.messageStores.recipients.set(messageId, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress(options.to),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(messageId, new Set());
  fake.messageStores.attachments.set(
    createAttachmentId(`att-${options.id}`),
    createAttachment({
      id: createAttachmentId(`att-${options.id}`),
      messageId,
      fileName: "report.pdf",
      contentType: "application/pdf",
      size: 3,
      blobKey: `att/att-${options.id}/report.pdf`,
      contentId: null,
      inline: false,
      createdAt: NOW,
    }),
  );
}

describe("graphql schema", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  test("builds without SDL/resolver drift", () => {
    const schema = buildGraphQLSchema();
    expect(schema.getQueryType()).toBeDefined();
    expect(schema.getMutationType()).toBeDefined();
  });

  test("viewer is null when unauthenticated", async () => {
    const result = await harness.run("{ viewer { capabilities } }", null);
    expect(result.errors).toBeUndefined();
    expect(result.data?.["viewer"]).toBeNull();
  });

  test("viewer reports capabilities and sendable addresses", async () => {
    const result = await harness.run(
      "{ viewer { capabilities sendableAddresses } }",
      adminViewer(),
    );
    expect(result.errors).toBeUndefined();
    const viewer = result.data?.["viewer"] as {
      capabilities: string[];
      sendableAddresses: string[];
    };
    expect(viewer.capabilities).toContain("DOMAIN_ADMIN");
    expect(viewer.sendableAddresses).toEqual(["*@example.com"]);
  });

  test("a member's capabilities exclude instance administration", async () => {
    const result = await harness.run(
      "{ viewer { capabilities } }",
      memberViewer(),
    );
    const viewer = result.data?.["viewer"] as { capabilities: string[] };
    expect(viewer.capabilities).toContain("MAIL_READ");
    expect(viewer.capabilities).not.toContain("KEY_ADMIN");
  });

  test("protected queries reject an unauthenticated caller", async () => {
    const result = await harness.run("{ domains { id } }", null);
    expect(errorCodes(result)).toEqual(["UNAUTHENTICATED"]);
  });

  test("verificationToken is hidden from a non-admin", async () => {
    const asAdmin = await harness.run(
      "{ domains { name verificationToken } }",
      adminViewer(),
    );
    const adminDomains = asAdmin.data?.["domains"] as {
      verificationToken: string | null;
    }[];
    expect(adminDomains[0]?.verificationToken).toBe("secret-token");

    const asMember = await harness.run(
      "{ domains { name verificationToken } }",
      memberViewer(),
    );
    const memberDomains = asMember.data?.["domains"] as {
      verificationToken: string | null;
    }[];
    expect(memberDomains[0]?.verificationToken).toBeNull();
  });

  test("domain exposes the DNS records an operator must publish", async () => {
    const result = await harness.run(
      "{ domains { dnsRecords { type name value priority purpose } } }",
      adminViewer(),
    );
    expect(result.errors).toBeUndefined();
    const domains = result.data?.["domains"] as {
      dnsRecords: { type: string }[];
    }[];
    expect(domains[0]?.dnsRecords.some((record) => record.type === "MX")).toBe(
      true,
    );
  });

  test("messages resolves nested fields through loaders", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    const result = await harness.run(
      `{
         messages(first: 10) {
           totalCount
           nodes {
             id
             subject
             from { address name kind }
             recipients { address kind }
             attachments { id fileName url }
             tags { name }
             isSpam
             fetchStatus
             domain { name }
           }
         }
       }`,
      adminViewer(),
    );
    expect(result.errors).toBeUndefined();
    const page = result.data?.["messages"] as {
      totalCount: number;
      nodes: {
        id: string;
        from: { address: string; kind: string };
        recipients: { address: string }[];
        attachments: { url: string }[];
        isSpam: boolean;
        fetchStatus: string;
        domain: { name: string };
      }[];
    };
    expect(page.totalCount).toBe(1);
    const node = page.nodes[0];
    expect(node?.from.address).toBe("sender@other.com");
    expect(node?.recipients[0]?.address).toBe("support@example.com");
    expect(node?.attachments[0]?.url).toBe("/api/attachments/att-msg-1");
    expect(node?.isSpam).toBe(false);
    expect(node?.domain.name).toBe("example.com");
  });

  test("filters by attachment kind, presence, cc-recipient and body text", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    // msg-1's seeded attachment is an application/pdf named report.pdf.
    const byKind = await harness.run(
      `{ messages(filter: { attachmentKinds: [PDF] }) { totalCount nodes { attachments { kind } } } }`,
      adminViewer(),
    );
    expect(byKind.errors).toBeUndefined();
    const kindPage = byKind.data?.["messages"] as {
      totalCount: number;
      nodes: { attachments: { kind: string }[] }[];
    };
    expect(kindPage.totalCount).toBe(1);
    expect(kindPage.nodes[0]?.attachments[0]?.kind).toBe("PDF");

    const totalCount = async (query: string): Promise<number | undefined> => {
      const result = await harness.run(query, adminViewer());
      const page = result.data?.["messages"] as
        | { totalCount: number }
        | undefined;
      return page?.totalCount;
    };

    await expect(
      totalCount(
        `{ messages(filter: { attachmentKinds: [IMAGE] }) { totalCount } }`,
      ),
    ).resolves.toBe(0);
    await expect(
      totalCount(
        `{ messages(filter: { hasAttachment: true }) { totalCount } }`,
      ),
    ).resolves.toBe(1);
    await expect(
      totalCount(
        `{ messages(filter: { search: "body text" }) { totalCount } }`,
      ),
    ).resolves.toBe(1);
    await expect(
      totalCount(
        `{ messages(filter: { recipientAddress: "support@example.com" }) { totalCount } }`,
      ),
    ).resolves.toBe(1);
  });

  test("recipients can be filtered by kind", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    const result = await harness.run(
      `{ messages { nodes { recipients(kind: CC) { address } } } }`,
      adminViewer(),
    );
    const page = result.data?.["messages"] as {
      nodes: { recipients: unknown[] }[];
    };
    expect(page.nodes[0]?.recipients).toEqual([]);
  });

  test("a user session always reads FETCHED", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    const result = await harness.run(
      "{ messages { nodes { fetchStatus fetchedAt } } }",
      adminViewer(),
    );
    const page = result.data?.["messages"] as {
      nodes: { fetchStatus: string; fetchedAt: string | null }[];
    };
    expect(page.nodes[0]?.fetchStatus).toBe("FETCHED");
    expect(page.nodes[0]?.fetchedAt).toBeNull();
  });

  test("an api key sees NOT_FETCHED until it acknowledges", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    const agent = mailboxAgentViewer(domainId, "support@example.com");

    const before = await harness.run(
      `{ messages(filter: { fetchStatus: NOT_FETCHED }) { nodes { id fetchStatus } } }`,
      agent,
    );
    const beforePage = before.data?.["messages"] as {
      nodes: { id: string; fetchStatus: string }[];
    };
    expect(beforePage.nodes[0]?.fetchStatus).toBe("NOT_FETCHED");

    const ack = await harness.run(
      `mutation { markMessagesFetched(messageIds: ["msg-1"]) { id fetchStatus fetchedAt } }`,
      agent,
    );
    expect(ack.errors).toBeUndefined();
    const acked = ack.data?.["markMessagesFetched"] as {
      fetchStatus: string;
      fetchedAt: string;
    }[];
    expect(acked[0]?.fetchStatus).toBe("FETCHED");
    expect(acked[0]?.fetchedAt).toBe(NOW);

    const after = await harness.run(
      `{ messages(filter: { fetchStatus: NOT_FETCHED }) { totalCount } }`,
      agent,
    );
    const afterPage = after.data?.["messages"] as { totalCount: number };
    expect(afterPage.totalCount).toBe(0);
  });

  test("fetchStatus filtering is rejected for a user session", async () => {
    const result = await harness.run(
      `{ messages(filter: { fetchStatus: NOT_FETCHED }) { totalCount } }`,
      adminViewer(),
    );
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
  });

  test("a scoped key sees only its own mailbox", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    seedMessage(harness.fake, { id: "msg-2", to: "billing@example.com" });
    const result = await harness.run(
      "{ messages { nodes { id } totalCount } }",
      mailboxAgentViewer(domainId, "support@example.com"),
    );
    const page = result.data?.["messages"] as {
      nodes: { id: string }[];
      totalCount: number;
    };
    expect(page.nodes.map((node) => node.id)).toEqual(["msg-1"]);
  });

  test("an out-of-scope message reads as null, not forbidden", async () => {
    seedMessage(harness.fake, { id: "msg-2", to: "billing@example.com" });
    const result = await harness.run(
      `{ message(id: "msg-2") { id } }`,
      mailboxAgentViewer(domainId, "support@example.com"),
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.["message"]).toBeNull();
  });

  test("sendMessage delivers and returns the stored message", async () => {
    const result = await harness.run(
      `mutation Send($input: SendMessageInput!) {
         sendMessage(input: $input) {
           id direction deliveryStatus subject from { address }
         }
       }`,
      adminViewer(),
      {
        input: {
          from: "support@example.com",
          to: ["customer@other.com"],
          subject: "Re: your ticket",
          text: "Thanks!",
        },
      },
    );
    expect(result.errors).toBeUndefined();
    const message = result.data?.["sendMessage"] as {
      direction: string;
      deliveryStatus: string;
    };
    expect(message.direction).toBe("OUTBOUND");
    expect(message.deliveryStatus).toBe("SENT");
    expect(harness.fake.mailSender.sent).toHaveLength(1);
  });

  test("a header-injection attempt is a BAD_USER_INPUT", async () => {
    const result = await harness.run(
      `mutation Send($input: SendMessageInput!) {
         sendMessage(input: $input) { id }
       }`,
      adminViewer(),
      {
        input: {
          from: "support@example.com",
          to: ["customer@other.com"],
          subject: "Hi",
          text: "Body",
          headers: [{ name: "X-Note", value: "ok\r\nBcc: attacker@evil.com" }],
        },
      },
    );
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
  });

  test("createApiKey returns the secret exactly once", async () => {
    const result = await harness.run(
      `mutation Create($input: CreateApiKeyInput!) {
         createApiKey(input: $input) {
           secret
           apiKey { id name keyPrefix scopes { capability addressPattern domain { name } } }
         }
       }`,
      adminViewer(),
      {
        input: {
          name: "support agent",
          scopes: [
            {
              capability: "MAIL_READ",
              domainId,
              addressPattern: "support@example.com",
            },
          ],
        },
      },
    );
    expect(result.errors).toBeUndefined();
    const created = result.data?.["createApiKey"] as {
      secret: string;
      apiKey: {
        keyPrefix: string;
        scopes: { capability: string; domain: { name: string } }[];
      };
    };
    expect(created.secret.startsWith(created.apiKey.keyPrefix)).toBe(true);
    expect(created.apiKey.scopes[0]?.capability).toBe("MAIL_READ");
    expect(created.apiKey.scopes[0]?.domain.name).toBe("example.com");

    // Reading the key back never yields the secret again -- there is no
    // field on `ApiKey` that could return it.
    const listed = await harness.run(
      "{ apiKeys { id keyPrefix } }",
      adminViewer(),
    );
    expect(JSON.stringify(listed.data)).not.toContain(created.secret);
  });

  test("createApiKey is forbidden for a member", async () => {
    const result = await harness.run(
      `mutation Create($input: CreateApiKeyInput!) {
         createApiKey(input: $input) { secret }
       }`,
      memberViewer(),
      {
        input: {
          name: "x",
          scopes: [{ capability: "MAIL_READ", addressPattern: "*" }],
        },
      },
    );
    expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
  });

  test("tagging and spam round-trip through the API", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });

    const created = await harness.run(
      `mutation { createTag(name: "Invoices", color: "#aabbcc") { id name } }`,
      adminViewer(),
    );
    const tag = created.data?.["createTag"] as { id: string };

    const tagged = await harness.run(
      `mutation Tag($tagIds: [ID!]!) {
         tagMessages(messageIds: ["msg-1"], tagIds: $tagIds) { id tags { name } }
       }`,
      adminViewer(),
      { tagIds: [tag.id] },
    );
    expect(tagged.errors).toBeUndefined();

    const spam = await harness.run(
      `mutation { markSpam(messageIds: ["msg-1"]) { id isSpam } }`,
      adminViewer(),
    );
    const marked = spam.data?.["markSpam"] as { isSpam: boolean }[];
    expect(marked[0]?.isSpam).toBe(true);

    // Spam is hidden from the default listing.
    const listed = await harness.run(
      "{ messages { totalCount } }",
      adminViewer(),
    );
    const listedPage = listed.data?.["messages"] as { totalCount: number };
    expect(listedPage.totalCount).toBe(0);
  });

  test("a duplicate tag name is a CONFLICT", async () => {
    await harness.run(
      `mutation { createTag(name: "Invoices") { id } }`,
      adminViewer(),
    );
    const again = await harness.run(
      `mutation { createTag(name: "invoices") { id } }`,
      adminViewer(),
    );
    expect(errorCodes(again)).toEqual(["CONFLICT"]);
  });

  test("createAttachmentLink returns a one-time url", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    await harness.deps.blobs.put(
      "att/att-msg-1/report.pdf",
      new Uint8Array([1, 2, 3]),
    );

    const result = await harness.run(
      `mutation {
         createAttachmentLink(attachmentId: "att-msg-1", ttlSeconds: 900, maxDownloads: 2) {
           token
           url
           link { target maxDownloads downloadCount expiresAt }
         }
       }`,
      adminViewer(),
    );
    expect(result.errors).toBeUndefined();
    const created = result.data?.["createAttachmentLink"] as {
      token: string;
      url: string;
      link: { target: string; maxDownloads: number };
    };
    expect(created.url).toBe(`https://mail.example.com/files/${created.token}`);
    expect(created.link.target).toBe("ATTACHMENT");
    expect(created.link.maxDownloads).toBe(2);
  });

  test("an unknown message id is NOT_FOUND on a mutation", async () => {
    const result = await harness.run(
      `mutation { createRawMessageLink(messageId: "nope") { token } }`,
      adminViewer(),
    );
    expect(errorCodes(result)).toEqual(["NOT_FOUND"]);
  });

  test("thread aggregates participants and message count", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    seedMessage(harness.fake, { id: "msg-2", to: "billing@example.com" });
    const result = await harness.run(
      `{ thread(id: "thr-1") { messageCount participants { address } } }`,
      adminViewer(),
    );
    expect(result.errors).toBeUndefined();
    const thread = result.data?.["thread"] as {
      messageCount: number;
      participants: { address: string }[];
    };
    expect(thread.messageCount).toBe(2);
    expect(thread.participants.map((entry) => entry.address).sort()).toEqual([
      "billing@example.com",
      "sender@other.com",
      "support@example.com",
    ]);
  });

  describe("bootstrapAdmin", () => {
    test("creates the first admin and hands back a usable root key", async () => {
      const result = await harness.run(
        `mutation {
           bootstrapAdmin(email: "first@example.com", name: "First") {
             user { email role }
             apiKey { keyPrefix scopes { capability } }
             secret
           }
         }`,
        null,
      );
      expect(result.errors).toBeUndefined();
      const payload = result.data?.["bootstrapAdmin"] as {
        user: { email: string; role: string };
        apiKey: { keyPrefix: string; scopes: { capability: string }[] };
        secret: string;
      };
      expect(payload.user.email).toBe("first@example.com");
      expect(payload.user.role).toBe("ADMIN");
      // Without this credential a deployed instance would be unreachable:
      // login needs a verified sending domain that only an admin can add.
      expect(payload.secret.startsWith(payload.apiKey.keyPrefix)).toBe(true);
      // One scope per capability: mail, templates and calendars alike.
      expect(payload.apiKey.scopes).toHaveLength(
        Object.values(Capability).length,
      );
    });

    test("the door closes permanently after the first admin exists", async () => {
      await harness.run(
        `mutation { bootstrapAdmin(email: "first@example.com", name: "First") { secret } }`,
        null,
      );
      const second = await harness.run(
        `mutation { bootstrapAdmin(email: "second@example.com", name: "Second") { secret } }`,
        null,
      );
      expect(errorCodes(second)).toEqual(["CONFLICT"]);
    });
  });
});

describe("spam verdicts, drafts, events and rules", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  /** Narrows a result field, failing the test on a missing payload
   * instead of tripping optional chaining on undefined. */
  function field<T>(
    result: { data?: Record<string, unknown> | null },
    name: string,
  ): T {
    const value = result.data?.[name];
    expect(value).toBeDefined();
    return value as T;
  }

  test("isSpam and spam come from the verdict table; spamOnly filters", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    seedMessage(harness.fake, { id: "msg-2", to: "support@example.com" });
    const mark = await harness.run(
      `mutation { markSpam(messageIds: ["msg-2"]) { id isSpam spam { markedBy score } } }`,
      adminViewer(),
    );
    expect(mark.errors).toBeUndefined();
    const marked = field<
      { isSpam: boolean; spam: { markedBy: string; score: number | null } }[]
    >(mark, "markSpam")[0];
    expect(marked?.isSpam).toBe(true);
    expect(marked?.spam.markedBy).toBe("USER");
    expect(marked?.spam.score).toBeNull();

    const spamFolder = await harness.run(
      `{ messages(filter: { spamOnly: true }) { totalCount nodes { id } } }`,
      adminViewer(),
    );
    const page = field<{ totalCount: number; nodes: { id: string }[] }>(
      spamFolder,
      "messages",
    );
    expect(page.totalCount).toBe(1);
    expect(page.nodes[0]?.id).toBe("msg-2");

    // The default listing excludes it again.
    const inbox = await harness.run(
      `{ messages { nodes { id } } }`,
      adminViewer(),
    );
    expect(
      field<{ nodes: { id: string }[] }>(inbox, "messages").nodes.map(
        (node) => node.id,
      ),
    ).toEqual(["msg-1"]);
  });

  test("saveDraft, statuses filter and sendDraft over GraphQL", async () => {
    const saved = await harness.run(
      `mutation {
         saveDraft(input: {
           from: "support@example.com"
           to: ["customer@other.com"]
           subject: "WIP"
           text: "draft body"
         }) { id status deliveryStatus }
       }`,
      adminViewer(),
    );
    expect(saved.errors).toBeUndefined();
    const draft = field<{ id: string; status: string }>(saved, "saveDraft");
    expect(draft.status).toBe("DRAFT");

    const drafts = await harness.run(
      `{ messages(filter: { statuses: [DRAFT] }) { totalCount } }`,
      adminViewer(),
    );
    expect(field<{ totalCount: number }>(drafts, "messages").totalCount).toBe(
      1,
    );

    const sent = await harness.run(
      `mutation { sendDraft(id: "${draft.id}") { id status deliveryStatus } }`,
      adminViewer(),
    );
    expect(sent.errors).toBeUndefined();
    expect(sent.data?.["sendDraft"]).toMatchObject({
      id: draft.id,
      status: "SENT",
      deliveryStatus: "SENT",
    });
  });

  test("event lifecycle over GraphQL: the 10/1 reply deadline", async () => {
    seedMessage(harness.fake, { id: "msg-1", to: "support@example.com" });
    const created = await harness.run(
      `mutation {
         createMessageEvent(input: {
           messageId: "msg-1"
           kind: DEADLINE
           dueAt: "2026-10-01T00:00:00.000Z"
           title: "reply"
         }) { id kind dueAt title completedAt }
       }`,
      adminViewer(),
    );
    expect(created.errors).toBeUndefined();
    const event = field<{ id: string }>(created, "createMessageEvent");

    const viaMessage = await harness.run(
      `{ message(id: "msg-1") { events { id title dueAt } } }`,
      adminViewer(),
    );
    expect(
      field<{ events: { id: string }[] }>(viaMessage, "message").events,
    ).toHaveLength(1);

    const agenda = await harness.run(
      `{ messageEvents(dueBefore: "2026-11-01T00:00:00.000Z") { id title } }`,
      adminViewer(),
    );
    expect(agenda.data?.["messageEvents"]).toHaveLength(1);

    const completed = await harness.run(
      `mutation { updateMessageEvent(id: "${event.id}", input: { completed: true }) { completedAt } }`,
      adminViewer(),
    );
    expect(
      field<{ completedAt: string | null }>(completed, "updateMessageEvent")
        .completedAt,
    ).not.toBeNull();
  });

  test("classification rules are DOMAIN_ADMIN territory", async () => {
    const created = await harness.run(
      `mutation {
         createClassificationRule(input: {
           field: SENDER_DOMAIN
           matcher: EXACT
           pattern: "spam.example"
           action: SPAM
         }) { id enabled action pattern }
       }`,
      adminViewer(),
    );
    expect(created.errors).toBeUndefined();
    const rule = field<{ id: string }>(created, "createClassificationRule");

    const listed = await harness.run(
      `{ classificationRules { id } }`,
      adminViewer(),
    );
    expect(listed.data?.["classificationRules"]).toHaveLength(1);

    // A mail-scoped key can neither list nor create rules.
    const denied = await harness.run(
      `{ classificationRules { id } }`,
      mailboxAgentViewer(domainId, "support@example.com"),
    );
    expect(denied.errors?.[0]?.extensions?.["code"]).toBe("FORBIDDEN");

    const disabled = await harness.run(
      `mutation { setClassificationRuleEnabled(id: "${rule.id}", enabled: false) { enabled } }`,
      adminViewer(),
    );
    expect(
      field<{ enabled: boolean }>(disabled, "setClassificationRuleEnabled")
        .enabled,
    ).toBe(false);

    const deleted = await harness.run(
      `mutation { deleteClassificationRule(id: "${rule.id}") }`,
      adminViewer(),
    );
    expect(deleted.data?.["deleteClassificationRule"]).toBe(true);
  });
});
