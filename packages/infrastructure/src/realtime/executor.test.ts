import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import {
  buildMailPermissions,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import { createUseCases } from "@flying-mail/application/usecases";
import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import {
  createInboundMessage,
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
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { buildSchema, GraphQLObjectType } from "graphql";
import { describe, expect, test } from "vitest";
import type { GraphQLContext } from "../graphql/context";
import { mailEventResolvers } from "../graphql/resolvers/realtime";
import { coerceScope } from "./drain-helpers";
import type { MailEventPayload } from "./mail-event-payload";
import { createSubscriptionExecutor } from "./executor";

const DOMAIN_ID = createDomainId("dom-realtime");
const MESSAGE_ID = createMessageId("msg-realtime");
const NOW = "2026-08-23T00:00:00.000Z";
const SUBSCRIPTION = `subscription ($scope: MailEventScope, $showCursor: Boolean!, $showType: Boolean!) {
  mailEvents(scope: $scope) {
    cursor @include(if: $showCursor)
    type @include(if: $showType)
  }
}`;

function event(overrides: Partial<MailEventPayload> = {}): MailEventPayload {
  return {
    cursor: "0123456789abcdef.1",
    type: MailEventType.MessageReceived,
    messageId: MESSAGE_ID,
    domainId: DOMAIN_ID,
    addresses: [
      "sender@other.test",
      "support@example.com",
      "private@example.com",
    ],
    occurredAt: NOW,
    ...overrides,
  };
}

function createExecutor() {
  const fake = createFakeDependencies({ now: NOW });
  const usecases = createUseCases(fake.deps);
  const schema = buildSchema(`
    type Query { noop: String }
    enum MailEventType {
      MESSAGE_RECEIVED
      MESSAGE_SENT
      MESSAGE_UPDATED
      MESSAGE_DELETED
      DRAFT_SAVED
      DRAFT_DELETED
      LIVE
    }
    input MailEventScope { domainId: ID, address: String, types: [MailEventType!] }
    type Message { id: ID! }
    type MailEvent {
      cursor: String!
      type: MailEventType!
      messageId: ID
      domainId: ID
      addresses: [String!]!
      occurredAt: String!
      message: Message
    }
    type Subscription { mailEvents(scope: MailEventScope, after: String): MailEvent! }
  `);
  const eventType = schema.getType("MailEvent");
  if (!(eventType instanceof GraphQLObjectType)) {
    throw new Error("MailEvent type was not built");
  }
  const fields = eventType.getFields();
  const addressesField = fields["addresses"];
  const messageField = fields["message"];
  if (addressesField === undefined || messageField === undefined) {
    throw new Error("MailEvent resolver fields were not built");
  }
  addressesField.resolve = (payload, args, context) =>
    mailEventResolvers.addresses(
      payload as MailEventPayload,
      args,
      context as GraphQLContext,
    );
  messageField.resolve = (payload, args, context) =>
    mailEventResolvers.message(
      payload as MailEventPayload,
      args,
      context as GraphQLContext,
    );
  const executor = createSubscriptionExecutor({
    schema,
    deps: fake.deps,
    usecases,
    publicOrigin: "https://mail.example.com",
  });
  return { fake, usecases, executor };
}

async function seedReadableMessage(
  fake: ReturnType<typeof createFakeDependencies>,
): Promise<void> {
  fake.messageStores.messages.set(
    MESSAGE_ID,
    createInboundMessage({
      id: MESSAGE_ID,
      domainId: DOMAIN_ID,
      threadId: createThreadId("thr-realtime"),
      rfcMessageId: "realtime@other.test",
      inReplyTo: null,
      references: [],
      subject: "Readable message",
      fromAddress: createEmailAddress("sender@other.test"),
      fromName: "Sender",
      textBody: "Body",
      htmlBody: null,
      rawKey: "raw/realtime.eml",
      rawSize: 4,
      occurredAt: NOW,
      createdAt: NOW,
      spamScore: 0,
    }),
  );
  fake.messageStores.recipients.set(MESSAGE_ID, [
    {
      kind: RecipientKind.Envelope,
      address: createEmailAddress("support@example.com"),
      name: null,
      position: 0,
    },
  ]);
  fake.messageStores.messageTags.set(MESSAGE_ID, new Set());
  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: DOMAIN_ID,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "verification",
        createdAt: NOW,
      }),
      NOW,
    ),
  );
}

describe("createSubscriptionExecutor", () => {
  test("normalizes optional event types and rejects invalid type filters", () => {
    const { executor } = createExecutor();
    const omitted = executor.prepare(
      { query: "subscription { mailEvents { cursor } }" },
      memberViewer(),
    );
    const explicitNull = executor.prepare(
      {
        query: "subscription { mailEvents(scope: { types: null }) { cursor } }",
      },
      memberViewer(),
    );
    expect(omitted.ok && omitted.prepared.scope.types).toBeNull();
    expect(explicitNull.ok && explicitNull.prepared.scope.types).toBeNull();

    const normalized = executor.prepare(
      {
        query:
          "subscription { mailEvents(scope: { types: [MESSAGE_SENT, MESSAGE_RECEIVED, MESSAGE_SENT] }) { cursor } }",
      },
      memberViewer(),
    );
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.prepared.scope.types).toEqual([
        MailEventType.MessageReceived,
        MailEventType.MessageSent,
      ]);
    }

    for (const types of ["MESSAGE_SENT", ["NOT_AN_EVENT"]]) {
      const invalid = coerceScope({ types });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.field).toBe("scope.types");
      }
    }

    for (const [types, message] of [
      ["[]", "scope.types must list at least one event type"],
      ["[LIVE]", "scope.types cannot include LIVE; it is always delivered"],
    ] as const) {
      const invalid = executor.prepare(
        {
          query: `subscription { mailEvents(scope: { types: ${types} }) { cursor } }`,
        },
        memberViewer(),
      );
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.errors[0]?.extensions?.["code"]).toBe("BAD_USER_INPUT");
        expect(invalid.errors[0]?.extensions?.["field"]).toBe("scope.types");
        expect(invalid.errors[0]?.message).toBe(message);
      }
    }
  });

  test("normalizes scope address and rejects over-depth or invalid addresses", () => {
    const { executor } = createExecutor();
    const valid = executor.prepare(
      {
        query: `subscription { mailEvents(scope: { address: " Support@X.com " }) { cursor } }`,
      },
      memberViewer(),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.prepared.scope.address).toBe("support@x.com");
    }

    const deepSelection = `${"mailEvents { ".repeat(13)}cursor${" }".repeat(13)}`;
    const tooDeep = executor.prepare(
      { query: `subscription { ${deepSelection} }` },
      memberViewer(),
    );
    expect(tooDeep.ok).toBe(false);
    if (!tooDeep.ok) {
      expect(tooDeep.errors[0]?.extensions?.["code"]).toBe("BAD_USER_INPUT");
    }

    const invalidAddress = executor.prepare(
      {
        query: `subscription { mailEvents(scope: { address: "not-an-address" }) { cursor } }`,
      },
      memberViewer(),
    );
    expect(invalidAddress.ok).toBe(false);
    if (!invalidAddress.ok) {
      expect(invalidAddress.errors[0]?.extensions?.["code"]).toBe(
        "BAD_USER_INPUT",
      );
      expect(invalidAddress.errors[0]?.extensions?.["field"]).toBe(
        "scope.address",
      );
      expect(invalidAddress.errors[0]?.message).toBe(
        "scope.address is not a valid email address",
      );
    }
  });

  test("accepts only a single direct mailEvents subscription root", () => {
    const { executor } = createExecutor();
    const invalidQueries = [
      "subscription { mailEvents { cursor } mailEvents { type } }",
      "query { messages { nodes { id } } }",
      "subscription { unknownField }",
    ];
    for (const query of invalidQueries) {
      expect(executor.prepare({ query }, memberViewer()).ok).toBe(false);
    }
  });

  test("keeps identical query subscriptions independent across variables and events", async () => {
    const { executor } = createExecutor();
    const first = executor.prepare(
      {
        query: SUBSCRIPTION,
        variables: {
          scope: { domainId: "A" },
          showCursor: true,
          showType: false,
        },
      },
      memberViewer(),
    );
    const second = executor.prepare(
      {
        query: SUBSCRIPTION,
        variables: {
          scope: { domainId: "B" },
          showCursor: false,
          showType: true,
        },
      },
      memberViewer(),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.prepared.scope.domainId).toBe("A");
    expect(second.prepared.scope.domainId).toBe("B");
    const firstResult = await executor.execute(
      first.prepared,
      event(),
      memberViewer(),
    );
    const secondResult = await executor.execute(
      second.prepared,
      event(),
      memberViewer(),
    );
    expect(firstResult.data).toEqual({
      mailEvents: { cursor: "0123456789abcdef.1" },
    });
    expect(secondResult.data).toEqual({
      mailEvents: { type: "MESSAGE_RECEIVED" },
    });
  });

  test("filters addresses for the viewer and returns null message for deleted and LIVE payloads", async () => {
    const { fake, executor } = createExecutor();
    await seedReadableMessage(fake);
    const viewer = memberViewer(
      "usr-realtime",
      buildMailPermissions(createUserId("usr-realtime"), [
        {
          effect: "ALLOW",
          domainId: DOMAIN_ID,
          addressPattern: "support@example.com",
        },
      ]),
    );
    const prepared = executor.prepare(
      {
        query:
          "subscription { mailEvents { cursor type messageId addresses message { id } } }",
      },
      viewer,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const readable = await executor.execute(prepared.prepared, event(), viewer);
    expect(readable.errors).toBeUndefined();
    expect(readable.data).toMatchObject({
      mailEvents: {
        addresses: ["support@example.com"],
        message: { id: MESSAGE_ID },
      },
    });

    const deleted = await executor.execute(
      prepared.prepared,
      event({
        type: MailEventType.MessageDeleted,
        messageId: "missing-message",
      }),
      viewer,
    );
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data).toMatchObject({ mailEvents: { message: null } });

    const live = await executor.execute(
      prepared.prepared,
      event({
        type: "LIVE",
        messageId: null,
        domainId: null,
        addresses: [],
      }),
      viewer,
    );
    expect(live.errors).toBeUndefined();
    expect(live.data).toMatchObject({
      mailEvents: { messageId: null, addresses: [], message: null },
    });
  });
});
