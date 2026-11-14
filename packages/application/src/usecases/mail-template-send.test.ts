import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import {
  type MailTemplateContentInput,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import { DeliveryStatus } from "@mailcal/domain/entities/message";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createDomainId } from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { BadUserInputError, ForbiddenError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, apiKeyViewer } from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const ADMIN = adminViewer();

function content(
  overrides: Partial<MailTemplateContentInput> = {},
): MailTemplateContentInput {
  return {
    name: "Invoice reminder",
    subject: "Invoice <%= it.invoiceNumber %> is due",
    textBody: "Hello <%= it.customerName %>,\nplease pay.",
    from: "billing@example.com",
    to: ["<%= it.customerEmail %>"],
    variables: [
      { key: "invoiceNumber", type: TemplateVariableType.Text },
      { key: "customerName", type: TemplateVariableType.Text },
      { key: "customerEmail", type: TemplateVariableType.Email },
    ],
    ...overrides,
  };
}

const FILLED = [
  { key: "invoiceNumber", value: "INV-42" },
  { key: "customerName", value: "Ada" },
  { key: "customerEmail", value: "ada@other.com" },
];

describe("template preview and send", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    usecases = createUseCases(fake.deps);
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

  async function storeTemplate(
    overrides: Partial<MailTemplateContentInput> = {},
  ) {
    return usecases.createMailTemplate(ADMIN, content(overrides));
  }

  describe("validateMailTemplateValues", () => {
    test("reports what is still missing without rendering", async () => {
      const template = await storeTemplate();
      const validation = await usecases.validateMailTemplateValues(
        ADMIN,
        template.id,
        [{ key: "invoiceNumber", value: "INV-42" }],
      );
      expect(validation.valid).toBe(false);
      expect(validation.missing).toEqual(["customerName", "customerEmail"]);
    });

    test("passes once every required variable is filled", async () => {
      const template = await storeTemplate();
      await expect(
        usecases.validateMailTemplateValues(ADMIN, template.id, FILLED),
      ).resolves.toMatchObject({ valid: true });
    });

    test("rejects a value that fails its declared type", async () => {
      const template = await storeTemplate();
      const validation = await usecases.validateMailTemplateValues(
        ADMIN,
        template.id,
        [...FILLED.slice(0, 2), { key: "customerEmail", value: "not-mail" }],
      );
      expect(validation.invalid).toEqual([
        { key: "customerEmail", reason: "must be a valid email address" },
      ]);
    });
  });

  describe("previewMailTemplate", () => {
    test("renders the exact mail that would be sent", async () => {
      const template = await storeTemplate();
      const preview = await usecases.previewMailTemplate(
        ADMIN,
        template.id,
        FILLED,
      );
      expect(preview.subject).toBe("Invoice INV-42 is due");
      expect(preview.text).toBe("Hello Ada,\nplease pay.");
      expect(preview.from).toBe("billing@example.com");
      expect(preview.to).toEqual(["ada@other.com"]);
      expect(preview.validation.valid).toBe(true);
    });

    test("sends nothing", async () => {
      const template = await storeTemplate();
      await usecases.previewMailTemplate(ADMIN, template.id, FILLED);
      expect(fake.mailSender.sent).toHaveLength(0);
    });

    test("refuses to render an incomplete value set", async () => {
      const template = await storeTemplate();
      await expect(
        usecases.previewMailTemplate(ADMIN, template.id, []),
      ).rejects.toBeInstanceOf(BadUserInputError);
    });

    test("escapes interpolations in the html body only", async () => {
      const template = await storeTemplate({
        textBody: "text <%= it.customerName %>",
        htmlBody: "<p><%= it.customerName %></p>",
      });
      const preview = await usecases.previewMailTemplate(ADMIN, template.id, [
        ...FILLED.slice(0, 1),
        { key: "customerName", value: "A & B" },
        ...FILLED.slice(2),
      ]);
      expect(preview.text).toBe("text A & B");
      expect(preview.html).toBe("<p>A &amp; B</p>");
    });

    test("splits one recipient variable into several addresses", async () => {
      const template = await storeTemplate({
        to: ["<%= it.customerEmail %>", "archive@example.com"],
        variables: [
          { key: "invoiceNumber", type: TemplateVariableType.Text },
          { key: "customerName", type: TemplateVariableType.Text },
          { key: "customerEmail", type: TemplateVariableType.Text },
        ],
      });
      const preview = await usecases.previewMailTemplate(ADMIN, template.id, [
        ...FILLED.slice(0, 2),
        { key: "customerEmail", value: "a@other.com, b@other.com" },
      ]);
      expect(preview.to).toEqual([
        "a@other.com",
        "b@other.com",
        "archive@example.com",
      ]);
    });

    test("needs TEMPLATE_READ and nothing else", async () => {
      const template = await storeTemplate();
      const sendOnly = apiKeyViewer([
        { capability: Capability.MailSend, domainId, addressPattern: "*" },
      ]);
      await expect(
        usecases.previewMailTemplate(sendOnly, template.id, FILLED),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("sendTemplatedMessage", () => {
    test("delivers the rendered mail through the ordinary send path", async () => {
      const template = await storeTemplate();
      const message = await usecases.sendTemplatedMessage(ADMIN, {
        templateId: template.id,
        values: FILLED,
      });
      expect(message.deliveryStatus).toBe(DeliveryStatus.Sent);
      expect(message.subject).toBe("Invoice INV-42 is due");
      expect(message.fromAddress).toBe("billing@example.com");
      expect(fake.mailSender.sent[0]?.to).toEqual(["ada@other.com"]);
    });

    test("refuses an incomplete value set", async () => {
      const template = await storeTemplate();
      await expect(
        usecases.sendTemplatedMessage(ADMIN, {
          templateId: template.id,
          values: [{ key: "invoiceNumber", value: "INV-42" }],
        }),
      ).rejects.toThrow(/missing values for customerName/);
      expect(fake.mailSender.sent).toHaveLength(0);
    });

    test("lets the caller override sender and recipients", async () => {
      const template = await storeTemplate();
      const message = await usecases.sendTemplatedMessage(ADMIN, {
        templateId: template.id,
        values: FILLED,
        from: "support@example.com",
        to: ["someone-else@other.com"],
        cc: ["cc@other.com"],
      });
      expect(message.fromAddress).toBe("support@example.com");
      expect(fake.mailSender.sent[0]?.to).toEqual(["someone-else@other.com"]);
      expect(fake.mailSender.sent[0]?.cc).toEqual(["cc@other.com"]);
    });

    test("requires a sender when neither template nor input has one", async () => {
      const template = await storeTemplate({ from: null });
      await expect(
        usecases.sendTemplatedMessage(ADMIN, {
          templateId: template.id,
          values: FILLED,
        }),
      ).rejects.toThrow(/declares no sender/);
    });

    test("still enforces the managed-domain rule on the rendered sender", async () => {
      const template = await storeTemplate({ from: "billing@unmanaged.test" });
      await expect(
        usecases.sendTemplatedMessage(ADMIN, {
          templateId: template.id,
          values: FILLED,
        }),
      ).rejects.toThrow(/not on a managed domain/);
    });

    test("still enforces MAIL_SEND on the rendered sender", async () => {
      const template = await storeTemplate();
      // Holds every template capability but may only send as support@.
      const key = apiKeyViewer([
        { capability: Capability.TemplateRead, domainId: null },
        {
          capability: Capability.MailSend,
          domainId,
          addressPattern: "support@example.com",
        },
      ]);
      await expect(
        usecases.sendTemplatedMessage(key, {
          templateId: template.id,
          values: FILLED,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        usecases.sendTemplatedMessage(key, {
          templateId: template.id,
          values: FILLED,
          from: "support@example.com",
        }),
      ).resolves.toMatchObject({ deliveryStatus: DeliveryStatus.Sent });
    });

    test("requires TEMPLATE_READ even for a key that may send anywhere", async () => {
      const template = await storeTemplate();
      const sendOnly = apiKeyViewer([
        { capability: Capability.MailSend, domainId, addressPattern: "*" },
      ]);
      await expect(
        usecases.sendTemplatedMessage(sendOnly, {
          templateId: template.id,
          values: FILLED,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("ignores an undeclared value rather than letting it reach the mail", async () => {
      const template = await storeTemplate();
      const message = await usecases.sendTemplatedMessage(ADMIN, {
        templateId: template.id,
        values: [...FILLED, { key: "invoiceNumber2", value: "INJECTED" }],
      });
      expect(message.subject).toBe("Invoice INV-42 is due");
      expect(message.textBody).not.toContain("INJECTED");
    });
  });
});
