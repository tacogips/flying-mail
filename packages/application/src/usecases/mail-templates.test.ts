import {
  Capability,
  createApiKeyScope,
} from "@mailcal/domain/entities/api-key";
import {
  type MailTemplateContentInput,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { MATCH_ALL_ADDRESSES } from "@mailcal/domain/value-objects/address-pattern";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createMailTemplateId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import type { Viewer } from "../policies/viewer";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  buildTemplatePermissions,
  memberViewer,
  viewerViewer,
} from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

const ADMIN = adminViewer();

function keyViewer(...capabilities: readonly Capability[]): Viewer {
  const apiKeyId = createApiKeyId("key-1");
  return {
    kind: "API_KEY",
    apiKeyId,
    scopes: capabilities.map((capability, index) =>
      createApiKeyScope({
        id: createApiKeyScopeId(`scope-${index}`),
        apiKeyId,
        capability,
        domainId: null,
        addressPattern: MATCH_ALL_ADDRESSES,
      }),
    ),
  };
}

function content(
  overrides: Partial<MailTemplateContentInput> = {},
): MailTemplateContentInput {
  return {
    name: "Invoice reminder",
    subject: "Invoice <%= it.invoiceNumber %>",
    textBody: "Hello <%= it.customerName %>",
    variables: [
      { key: "invoiceNumber", type: TemplateVariableType.Text },
      { key: "customerName", type: TemplateVariableType.Text },
    ],
    ...overrides,
  };
}

describe("mail template use cases", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(() => {
    fake = createFakeDependencies();
    usecases = createUseCases(fake.deps);
  });

  describe("create", () => {
    test("stores a template authored by the calling user", async () => {
      const template = await usecases.createMailTemplate(ADMIN, content());
      expect(template.name).toBe("Invoice reminder");
      expect(template.createdByUserId).toBe(
        (ADMIN as Extract<Viewer, { kind: "USER" }>).userId,
      );
      expect(fake.templateStores.mailTemplates.size).toBe(1);
    });

    test("rejects a body that reads an undeclared variable", async () => {
      await expect(
        usecases.createMailTemplate(
          ADMIN,
          content({ textBody: "Hi <%= it.nobody %>" }),
        ),
      ).rejects.toThrow(/it\.nobody/);
      expect(fake.templateStores.mailTemplates.size).toBe(0);
    });

    test("allows a declared variable nothing reads", async () => {
      const template = await usecases.createMailTemplate(
        ADMIN,
        content({
          variables: [
            { key: "invoiceNumber", type: TemplateVariableType.Text },
            { key: "customerName", type: TemplateVariableType.Text },
            { key: "stagedForLater", type: TemplateVariableType.Text },
          ],
        }),
      );
      expect(template.variables).toHaveLength(3);
    });

    test("rejects an execution tag at write time, not at send time", async () => {
      await expect(
        usecases.createMailTemplate(
          ADMIN,
          content({ textBody: "<% doSomething() %>" }),
        ),
      ).rejects.toBeInstanceOf(BadUserInputError);
    });

    test("rejects a duplicate name, case-insensitively", async () => {
      await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.createMailTemplate(
          ADMIN,
          content({ name: "INVOICE REMINDER" }),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });

  describe("authorization", () => {
    test("a member cannot create, update or delete by default", async () => {
      const member = memberViewer();
      await expect(
        usecases.createMailTemplate(member, content()),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const stored = await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.updateMailTemplate(member, stored.id, content()),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        usecases.deleteMailTemplate(member, stored.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a member can list templates without any grant", async () => {
      await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.listMailTemplates(memberViewer()),
      ).resolves.toHaveLength(1);
    });

    test("an explicit grant lets a member create, and only create", async () => {
      const userId = (memberViewer() as Extract<Viewer, { kind: "USER" }>)
        .userId;
      const granted = memberViewer(
        userId,
        [],
        buildTemplatePermissions(userId, [
          {
            capability: Capability.TemplateCreate,
            effect: UserPermissionEffect.Allow,
          },
        ]),
      );
      const created = await usecases.createMailTemplate(granted, content());
      expect(created.id).toBeDefined();
      await expect(
        usecases.deleteMailTemplate(granted, created.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a deny revokes an admin's own default", async () => {
      const userId = (adminViewer() as Extract<Viewer, { kind: "USER" }>)
        .userId;
      const denied = adminViewer(
        userId,
        [],
        buildTemplatePermissions(userId, [
          {
            capability: Capability.TemplateDelete,
            effect: UserPermissionEffect.Deny,
          },
        ]),
      );
      const stored = await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.deleteMailTemplate(denied, stored.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a viewer role can read but never mutate", async () => {
      await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.listMailTemplates(viewerViewer()),
      ).resolves.toHaveLength(1);
      await expect(
        usecases.createMailTemplate(viewerViewer(), content({ name: "Other" })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("an api key needs the matching scope for each operation", async () => {
      const readOnly = keyViewer(Capability.TemplateRead);
      await expect(
        usecases.createMailTemplate(readOnly, content()),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const creator = keyViewer(Capability.TemplateCreate);
      const created = await usecases.createMailTemplate(creator, content());
      // TEMPLATE_CREATE implies nothing about reading.
      await expect(usecases.listMailTemplates(creator)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(usecases.listMailTemplates(readOnly)).resolves.toHaveLength(
        1,
      );
      expect(created.createdByUserId).toBeNull();
    });

    test("a key holding only mail scopes reaches no template operation", async () => {
      const mailOnly = keyViewer(Capability.MailSend, Capability.MailRead);
      await expect(usecases.listMailTemplates(mailOnly)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe("update and delete", () => {
    test("update replaces the variable set as a unit", async () => {
      const stored = await usecases.createMailTemplate(ADMIN, content());
      const updated = await usecases.updateMailTemplate(
        ADMIN,
        stored.id,
        content({
          subject: "Hi <%= it.only %>",
          textBody: "body",
          variables: [{ key: "only", type: TemplateVariableType.Text }],
        }),
      );
      expect(updated.variables.map((v) => v.key)).toEqual(["only"]);
    });

    test("update rejects a variable removal the body still reads", async () => {
      const stored = await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.updateMailTemplate(
          ADMIN,
          stored.id,
          content({
            variables: [
              { key: "invoiceNumber", type: TemplateVariableType.Text },
            ],
          }),
        ),
      ).rejects.toThrow(/it\.customerName/);
    });

    test("update keeps a template's own name available to itself", async () => {
      const stored = await usecases.createMailTemplate(ADMIN, content());
      await expect(
        usecases.updateMailTemplate(ADMIN, stored.id, content()),
      ).resolves.toMatchObject({ name: "Invoice reminder" });
    });

    test("delete removes it and reports a missing one", async () => {
      const stored = await usecases.createMailTemplate(ADMIN, content());
      await expect(usecases.deleteMailTemplate(ADMIN, stored.id)).resolves.toBe(
        true,
      );
      await expect(
        usecases.deleteMailTemplate(ADMIN, createMailTemplateId("nope")),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("referencedVariableKeys", () => {
    test("reports only the variables the sources actually read", async () => {
      const stored = await usecases.createMailTemplate(
        ADMIN,
        content({
          variables: [
            { key: "invoiceNumber", type: TemplateVariableType.Text },
            { key: "customerName", type: TemplateVariableType.Text },
            { key: "unused", type: TemplateVariableType.Text },
          ],
        }),
      );
      expect(usecases.mailTemplateReferences(stored)).toEqual([
        "invoiceNumber",
        "customerName",
      ]);
    });
  });
});
