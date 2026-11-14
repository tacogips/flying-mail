import { createAttachment } from "@flying-mail/domain/entities/attachment";
import { MailAddressStatus } from "@flying-mail/domain/entities/mail-address";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
} from "@flying-mail/domain/value-objects/ids";
import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import {
  adminViewer,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
  type ExecutionResult,
} from "./graphql-test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-compose-graphql");
const ADMIN = adminViewer("usr-compose-graphql");

const PREFILL = `
  query Prefill($messageId: ID!, $mode: ComposeMode!) {
    composeFromMessage(messageId: $messageId, mode: $mode) {
      from to cc subject inReplyToMessageId forwardedFromMessageId quotedText
      forwardAttachments { id fileName }
    }
  }
`;

function savedDraftId(result: ExecutionResult): string {
  const draft = result.data?.["saveDraft"];
  if (
    typeof draft !== "object" ||
    draft === null ||
    !("id" in draft) ||
    typeof draft.id !== "string"
  ) {
    throw new Error("saveDraft did not return a draft id");
  }
  return draft.id;
}

describe("compose graphql surface", () => {
  let harness: GraphQLHarness;

  beforeEach(async () => {
    const dependencies = createFakeDependencies({ now: NOW });
    await dependencies.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: DOMAIN_ID,
          name: createDomainName("example.com"),
          catchAll: true,
          verificationToken: "compose-token",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
    harness = createGraphQLHarness(dependencies);
  });

  function seedInbound(
    id: string,
    options: { readonly to?: string; readonly cc?: string } = {},
  ): { readonly id: string; readonly attachmentId: string } {
    const messageId = createMessageId(id);
    const attachmentId = createAttachmentId(`att-${id}`);
    harness.fake.messageStores.messages.set(
      messageId,
      createInboundMessage({
        id: messageId,
        domainId: DOMAIN_ID,
        threadId: createThreadId(`thr-${id}`),
        rfcMessageId: `${id}@other.com`,
        inReplyTo: null,
        replyTo: createEmailAddress("reply@other.com"),
        references: [],
        subject: "Status update",
        fromAddress: createEmailAddress("sender@other.com"),
        fromName: "Sender",
        textBody: "Original body",
        htmlBody: "<p>Original body</p>",
        rawKey: `raw/${id}.eml`,
        rawSize: 100,
        occurredAt: NOW,
        createdAt: NOW,
        spamScore: 0.1,
      }),
    );
    harness.fake.messageStores.recipients.set(messageId, [
      {
        kind: RecipientKind.Envelope,
        address: createEmailAddress(options.to ?? "support@example.com"),
        name: null,
        position: 0,
      },
      {
        kind: RecipientKind.To,
        address: createEmailAddress(options.to ?? "support@example.com"),
        name: null,
        position: 0,
      },
      ...(options.cc === undefined
        ? []
        : [
            {
              kind: RecipientKind.Cc,
              address: createEmailAddress(options.cc),
              name: null,
              position: 0,
            },
          ]),
    ]);
    harness.fake.messageStores.messageTags.set(messageId, new Set());
    harness.fake.messageStores.attachments.set(
      attachmentId,
      createAttachment({
        id: attachmentId,
        messageId,
        fileName: "source.pdf",
        contentType: "application/pdf",
        size: 3,
        blobKey: `att/${id}/source.pdf`,
        contentId: null,
        inline: false,
        createdAt: NOW,
      }),
    );
    return { id, attachmentId };
  }

  test("computes reply-all recipients and threads to the readable source", async () => {
    const source = seedInbound("reply-all", { cc: "colleague@other.com" });
    const result = await harness.run(PREFILL, ADMIN, {
      messageId: source.id,
      mode: "REPLY_ALL",
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.["composeFromMessage"]).toMatchObject({
      from: "support@example.com",
      to: ["reply@other.com"],
      cc: ["colleague@other.com"],
      subject: "Re: Status update",
      inReplyToMessageId: source.id,
    });
  });

  test("returns NOT_FOUND for an unreadable source id", async () => {
    seedInbound("private-source");
    const result = await harness.run(PREFILL, memberViewer("usr-no-mail"), {
      messageId: "private-source",
      mode: "REPLY",
    });
    expect(errorCodes(result)).toEqual(["NOT_FOUND"]);
  });

  test("forwards source attachments and returns stable mail limits", async () => {
    const source = seedInbound("forward-source");
    const result = await harness.run(PREFILL, ADMIN, {
      messageId: source.id,
      mode: "FORWARD",
    });
    expect(result.data?.["composeFromMessage"]).toMatchObject({
      forwardedFromMessageId: source.id,
      forwardAttachments: [{ id: source.attachmentId, fileName: "source.pdf" }],
    });

    const limits = await harness.run(
      `{ mailLimits { maxAttachmentBytes maxOutboundTotalBytes maxAttachmentsPerMessage maxRecipientsPerMessage } }`,
      ADMIN,
    );
    expect(limits.data?.["mailLimits"]).toEqual({
      maxAttachmentBytes: 5_242_880,
      maxOutboundTotalBytes: 5_242_880,
      maxAttachmentsPerMessage: 32,
      maxRecipientsPerMessage: 50,
    });
  });

  test("lists active readable provisioned addresses", async () => {
    await harness.usecases.createMailAddress(ADMIN, {
      domainId: DOMAIN_ID,
      localPart: "support",
    });
    await harness.usecases.createMailAddress(ADMIN, {
      domainId: DOMAIN_ID,
      localPart: "disabled",
    });
    const addresses = await harness.deps.mailAddressRepository.list();
    const disabled = addresses.find(
      (address) => address.localPart === "disabled",
    );
    if (disabled !== undefined) {
      await harness.usecases.setMailAddressStatus(
        ADMIN,
        disabled.id,
        MailAddressStatus.Disabled,
      );
    }
    const result = await harness.run(
      `{ viewer { readableAddresses addressActivity { address domainId lastActivityAt unreadCount } } }`,
      ADMIN,
    );
    expect(result.data?.["viewer"]).toMatchObject({
      readableAddresses: ["support@example.com"],
      addressActivity: [
        {
          address: "support@example.com",
          domainId: DOMAIN_ID,
          lastActivityAt: null,
          unreadCount: 0,
        },
      ],
    });
  });

  test("passes draft forwarding and reply fields through to stored Message", async () => {
    const source = seedInbound("draft-forward-source");
    const result = await harness.run(
      `mutation Save($input: SaveDraftInput!) {
        saveDraft(input: $input) {
          id replyTo forwardedFromMessageId attachments { id fileName }
        }
      }`,
      ADMIN,
      {
        input: {
          from: "support@example.com",
          replyTo: "reply@example.net",
          forwardedFromMessageId: source.id,
          forwardAttachmentIds: [source.attachmentId],
        },
      },
    );
    expect(result.errors).toBeUndefined();
    const draft = result.data?.["saveDraft"] as {
      id: string;
      attachments: readonly { id: string; fileName: string }[];
    };
    expect(result.data?.["saveDraft"]).toMatchObject({
      replyTo: "reply@example.net",
      forwardedFromMessageId: source.id,
      attachments: [{ fileName: "source.pdf" }],
    });
    expect(draft.attachments[0]?.id).not.toBe(source.attachmentId);
  });

  test("sendMessage forwards bcc, html and replyTo to the sender", async () => {
    const result = await harness.run(
      `mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { id } }`,
      ADMIN,
      {
        input: {
          from: "support@example.com",
          to: ["to@other.com"],
          bcc: ["blind@other.com"],
          subject: "Hello",
          html: "<p>Hello</p>",
          replyTo: "reply@example.com",
        },
      },
    );
    expect(result.errors).toBeUndefined();
    expect(harness.fake.mailSender.sent[0]).toMatchObject({
      bcc: ["blind@other.com"],
      replyTo: "reply@example.com",
      html: "<p>Hello</p>",
    });
  });

  test("deletes a draft and hides the deleted message", async () => {
    const saved = await harness.run(
      `mutation { saveDraft(input: { from: "support@example.com" to: ["to@other.com"] text: "body" }) { id } }`,
      ADMIN,
    );
    const id = savedDraftId(saved);
    const deleted = await harness.run(
      `mutation Delete($id: ID!) { deleteDraft(id: $id) }`,
      ADMIN,
      { id },
    );
    expect(deleted.data?.["deleteDraft"]).toBe(true);
    const message = await harness.run(`{ message(id: "${id}") { id } }`, ADMIN);
    expect(message.data?.["message"]).toBeNull();
  });

  test("rejects deleting a sent message and updating a sent draft", async () => {
    const saved = await harness.run(
      `mutation { saveDraft(input: { from: "support@example.com" to: ["to@other.com"] text: "body" }) { id } }`,
      ADMIN,
    );
    const id = savedDraftId(saved);
    await harness.run(`mutation { sendDraft(id: "${id}") { id } }`, ADMIN);
    const deleted = await harness.run(
      `mutation { deleteDraft(id: "${id}") }`,
      ADMIN,
    );
    expect(errorCodes(deleted)).toEqual(["NOT_FOUND"]);
    const updated = await harness.run(
      `mutation { saveDraft(input: { draftId: "${id}" from: "support@example.com" }) { id } }`,
      ADMIN,
    );
    expect(errorCodes(updated)).toEqual(["NOT_FOUND"]);
  });

  test("does not allow sending an attachment owned by another message", async () => {
    const source = seedInbound("foreign-attachment");
    const result = await harness.run(
      `mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { id } }`,
      ADMIN,
      {
        input: {
          from: "support@example.com",
          to: ["to@other.com"],
          subject: "No move",
          text: "body",
          attachmentIds: [source.attachmentId],
        },
      },
    );
    expect(errorCodes(result)).toEqual(["NOT_FOUND"]);
  });
});
