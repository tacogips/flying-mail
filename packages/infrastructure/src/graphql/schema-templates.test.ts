import {
  createFakeDependencies,
  type FakeDependencies,
} from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createUser, UserRole } from "@mailcal/domain/entities/user";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createEmailAddress } from "@mailcal/domain/value-objects/email-address";
import {
  createDomainId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const ADMIN = adminViewer();

const TEMPLATE_FIELDS = `
  id
  name
  description
  subject
  textBody
  htmlBody
  from
  to
  cc
  bcc
  variables { key label type required defaultValue description }
  referencedVariableKeys
  createdByUserId
  createdAt
  updatedAt
`;

const CREATE = `
  mutation Create($input: MailTemplateInput!) {
    createMailTemplate(input: $input) { ${TEMPLATE_FIELDS} }
  }
`;

const TEMPLATES = `query Templates { mailTemplates { ${TEMPLATE_FIELDS} } }`;

const VALIDATION = `
  query Validate($id: ID!, $values: [TemplateValueInput!]!) {
    mailTemplateValidation(id: $id, values: $values) {
      valid
      missing
      invalid { key reason }
      unknown
    }
  }
`;

const PREVIEW = `
  query Preview($id: ID!, $values: [TemplateValueInput!]!) {
    previewMailTemplate(id: $id, values: $values) {
      subject
      text
      html
      from
      to
      cc
      bcc
      validation { valid missing }
    }
  }
`;

const SEND = `
  mutation Send($input: SendTemplatedMessageInput!) {
    sendTemplatedMessage(input: $input) {
      id
      subject
      deliveryStatus
      from { address }
      recipients { address kind }
    }
  }
`;

function templateInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Invoice reminder",
    subject: "Invoice <%= it.invoiceNumber %> is due",
    textBody: "Hello <%= it.customerName %>",
    from: "billing@example.com",
    to: ["<%= it.customerEmail %>"],
    variables: [
      { key: "invoiceNumber", type: "TEXT" },
      { key: "customerName", type: "TEXT", label: "Customer" },
      { key: "customerEmail", type: "EMAIL" },
    ],
    ...overrides,
  };
}

const FILLED = [
  { key: "invoiceNumber", value: "INV-42" },
  { key: "customerName", value: "Ada" },
  { key: "customerEmail", value: "ada@other.com" },
];

describe("mail template graphql surface", () => {
  let fake: FakeDependencies;
  let harness: GraphQLHarness;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    harness = createGraphQLHarness(fake);
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

  async function createTemplate(
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const result = await harness.run(CREATE, ADMIN, {
      input: templateInput(overrides),
    });
    expect(result.errors).toBeUndefined();
    return result.data?.["createMailTemplate"] as Record<string, unknown>;
  }

  test("creates and lists a template with its variables", async () => {
    const created = await createTemplate();
    expect(created).toMatchObject({
      name: "Invoice reminder",
      from: "billing@example.com",
      to: ["<%= it.customerEmail %>"],
      cc: [],
      referencedVariableKeys: [
        "invoiceNumber",
        "customerName",
        "customerEmail",
      ],
    });
    expect(created["variables"]).toHaveLength(3);

    const listed = await harness.run(TEMPLATES, ADMIN);
    expect(listed.data?.["mailTemplates"]).toHaveLength(1);
  });

  test("defaults a variable's label to its key and required to true", async () => {
    const created = await createTemplate();
    const variables = created["variables"] as readonly Record<
      string,
      unknown
    >[];
    expect(variables[0]).toMatchObject({
      key: "invoiceNumber",
      label: "invoiceNumber",
      required: true,
      defaultValue: null,
    });
  });

  test("rejects an undeclared reference with BAD_USER_INPUT", async () => {
    const result = await harness.run(CREATE, ADMIN, {
      input: templateInput({ textBody: "Hi <%= it.nobody %>" }),
    });
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
  });

  test("validation reports what is still missing", async () => {
    const created = await createTemplate();
    const result = await harness.run(VALIDATION, ADMIN, {
      id: created["id"],
      values: [{ key: "invoiceNumber", value: "INV-42" }],
    });
    expect(result.data?.["mailTemplateValidation"]).toEqual({
      valid: false,
      missing: ["customerName", "customerEmail"],
      invalid: [],
      unknown: [],
    });
  });

  test("validation flags a value that fails its declared type", async () => {
    const created = await createTemplate();
    const result = await harness.run(VALIDATION, ADMIN, {
      id: created["id"],
      values: [...FILLED.slice(0, 2), { key: "customerEmail", value: "nope" }],
    });
    expect(result.data?.["mailTemplateValidation"]).toMatchObject({
      valid: false,
      invalid: [
        { key: "customerEmail", reason: "must be a valid email address" },
      ],
    });
  });

  test("preview renders the mail and sends nothing", async () => {
    const created = await createTemplate();
    const result = await harness.run(PREVIEW, ADMIN, {
      id: created["id"],
      values: FILLED,
    });
    expect(result.data?.["previewMailTemplate"]).toEqual({
      subject: "Invoice INV-42 is due",
      text: "Hello Ada",
      html: null,
      from: "billing@example.com",
      to: ["ada@other.com"],
      cc: [],
      bcc: [],
      validation: { valid: true, missing: [] },
    });
    expect(fake.mailSender.sent).toHaveLength(0);
  });

  test("preview refuses an incomplete value set", async () => {
    const created = await createTemplate();
    const result = await harness.run(PREVIEW, ADMIN, {
      id: created["id"],
      values: [],
    });
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
  });

  test("sends the rendered mail", async () => {
    const created = await createTemplate();
    const result = await harness.run(SEND, ADMIN, {
      input: { templateId: created["id"], values: FILLED },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.["sendTemplatedMessage"]).toMatchObject({
      subject: "Invoice INV-42 is due",
      deliveryStatus: "SENT",
      from: { address: "billing@example.com" },
    });
    expect(fake.mailSender.sent[0]?.to).toEqual(["ada@other.com"]);
  });

  test("honours a sender override on the send", async () => {
    const created = await createTemplate();
    const result = await harness.run(SEND, ADMIN, {
      input: {
        templateId: created["id"],
        values: FILLED,
        from: "support@example.com",
        to: ["other@other.com"],
      },
    });
    expect(result.data?.["sendTemplatedMessage"]).toMatchObject({
      from: { address: "support@example.com" },
    });
    expect(fake.mailSender.sent[0]?.to).toEqual(["other@other.com"]);
  });

  test("a member is refused create but allowed list", async () => {
    await createTemplate();
    const denied = await harness.run(CREATE, memberViewer(), {
      input: templateInput({ name: "Another" }),
    });
    expect(errorCodes(denied)).toEqual(["FORBIDDEN"]);

    const listed = await harness.run(TEMPLATES, memberViewer());
    expect(listed.errors).toBeUndefined();
    expect(listed.data?.["mailTemplates"]).toHaveLength(1);
  });

  test("an unauthenticated caller is refused", async () => {
    const result = await harness.run(TEMPLATES, null);
    expect(errorCodes(result)).toEqual(["UNAUTHENTICATED"]);
  });

  test("an api key needs TEMPLATE_READ to send from a template", async () => {
    const created = await createTemplate();
    const sendOnly = apiKeyViewer([
      { capability: Capability.MailSend, domainId, addressPattern: "*" },
    ]);
    const refused = await harness.run(SEND, sendOnly, {
      input: { templateId: created["id"], values: FILLED },
    });
    expect(errorCodes(refused)).toEqual(["FORBIDDEN"]);

    const bothScopes = apiKeyViewer([
      { capability: Capability.MailSend, domainId, addressPattern: "*" },
      { capability: Capability.TemplateRead, domainId: null },
    ]);
    const allowed = await harness.run(SEND, bothScopes, {
      input: { templateId: created["id"], values: FILLED },
    });
    expect(allowed.errors).toBeUndefined();
  });

  test("Viewer.capabilities advertises the template capabilities held", async () => {
    const query = `query V { viewer { capabilities } }`;
    const asAdmin = await harness.run(query, ADMIN);
    expect(asAdmin.data?.["viewer"]).toMatchObject({
      capabilities: expect.arrayContaining([
        "TEMPLATE_READ",
        "TEMPLATE_CREATE",
        "TEMPLATE_UPDATE",
        "TEMPLATE_DELETE",
      ]),
    });

    const asMember = (await harness.run(query, memberViewer())).data?.[
      "viewer"
    ] as { capabilities: readonly string[] };
    expect(asMember.capabilities).toContain("TEMPLATE_READ");
    expect(asMember.capabilities).not.toContain("TEMPLATE_CREATE");
  });

  describe("per-user template permissions", () => {
    const targetId = createUserId("usr-target");
    const ADD = `
      mutation Add($userId: ID!, $input: UserTemplatePermissionInput!) {
        addUserTemplatePermission(userId: $userId, input: $input) {
          id
          capability
          effect
          createdByUserId
        }
      }
    `;
    const USERS = `
      query Users {
        users { id templatePermissions { id capability effect } }
      }
    `;

    beforeEach(async () => {
      await fake.deps.userRepository.save(
        createUser({
          id: targetId,
          email: createEmailAddress("member@example.com"),
          name: "Member",
          role: UserRole.Member,
          createdAt: NOW,
        }),
      );
    });

    test("an admin grants a capability and it shows on the user", async () => {
      const added = await harness.run(ADD, ADMIN, {
        userId: targetId,
        input: { capability: "TEMPLATE_CREATE", effect: "ALLOW" },
      });
      expect(added.errors).toBeUndefined();
      expect(added.data?.["addUserTemplatePermission"]).toMatchObject({
        capability: "TEMPLATE_CREATE",
        effect: "ALLOW",
      });

      const users = await harness.run(USERS, ADMIN);
      const rows = users.data?.["users"] as readonly {
        id: string;
        templatePermissions: readonly { capability: string }[];
      }[];
      const target = rows.find((row) => row.id === targetId);
      expect(target?.templatePermissions).toEqual([
        expect.objectContaining({ capability: "TEMPLATE_CREATE" }),
      ]);
    });

    test("the granted member can then create a template", async () => {
      await harness.run(ADD, ADMIN, {
        userId: targetId,
        input: { capability: "TEMPLATE_CREATE", effect: "ALLOW" },
      });
      const permissions =
        await fake.deps.userTemplatePermissionRepository.listByUserId(targetId);
      const granted = memberViewer(targetId, [], permissions);
      const created = await harness.run(CREATE, granted, {
        input: templateInput(),
      });
      expect(created.errors).toBeUndefined();
    });

    test("a member cannot grant itself a capability", async () => {
      const result = await harness.run(ADD, memberViewer(), {
        userId: targetId,
        input: { capability: "TEMPLATE_CREATE", effect: "ALLOW" },
      });
      expect(errorCodes(result)).toEqual(["FORBIDDEN"]);
    });

    test("an admin grants a calendar rule and it shows on the user", async () => {
      const ADD_CALENDAR = `
        mutation AddCal($userId: ID!, $input: UserCalendarPermissionInput!) {
          addUserCalendarPermission(userId: $userId, input: $input) {
            id
            capability
            effect
            ownerUserId
          }
        }
      `;
      const added = await harness.run(ADD_CALENDAR, ADMIN, {
        userId: targetId,
        input: { capability: "CALENDAR_READ", effect: "DENY" },
      });
      expect(added.errors).toBeUndefined();
      expect(added.data?.["addUserCalendarPermission"]).toMatchObject({
        capability: "CALENDAR_READ",
        effect: "DENY",
        // Absent owner is the all-owners rule.
        ownerUserId: null,
      });

      const users = await harness.run(
        `query U { users { id calendarPermissions { capability effect ownerUserId } } }`,
        ADMIN,
      );
      const rows = users.data?.["users"] as readonly {
        id: string;
        calendarPermissions: readonly { capability: string }[];
      }[];
      expect(
        rows.find((row) => row.id === targetId)?.calendarPermissions,
      ).toEqual([
        expect.objectContaining({
          capability: "CALENDAR_READ",
          effect: "DENY",
        }),
      ]);
    });

    test("the calendar permission input cannot name a mail capability", async () => {
      const result = await harness.run(
        `mutation A($userId: ID!, $input: UserCalendarPermissionInput!) {
           addUserCalendarPermission(userId: $userId, input: $input) { id }
         }`,
        ADMIN,
        {
          userId: targetId,
          input: { capability: "MAIL_READ", effect: "ALLOW" },
        },
      );
      // Rejected by the schema's narrower CalendarCapability enum.
      expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    });

    test("the permission input cannot name a mail capability", async () => {
      const result = await harness.run(ADD, ADMIN, {
        userId: targetId,
        input: { capability: "MAIL_SEND", effect: "ALLOW" },
      });
      // Rejected by the schema's narrower TemplateCapability enum, before a
      // resolver ever runs.
      expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    });
  });
});
