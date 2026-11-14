import {
  createMailTemplate,
  type MailTemplateContentInput,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import type { TemplateValueEntry } from "@mailcal/domain/entities/template-values";
import {
  createMailTemplateId,
  createUserId,
} from "@mailcal/domain/value-objects/ids";
import { describe, expect, test } from "vitest";
import { BadUserInputError } from "../errors";
import { fakeTemplateRenderer } from "../test-support/template-fakes";
import {
  renderTemplate,
  type TemplateRenderDependencies,
} from "./mail-template-send";

const ID = createMailTemplateId("tpl-1");
const AUTHOR = createUserId("user-1");
const NOW = "2026-08-24T00:00:00.000Z";

function deps(): TemplateRenderDependencies {
  return { templateRenderer: fakeTemplateRenderer() };
}

function content(
  overrides: Partial<MailTemplateContentInput> = {},
): MailTemplateContentInput {
  return {
    name: "Invoice reminder",
    subject: "Invoice <%= it.invoiceNumber %> is due",
    textBody: "Hello <%= it.customerName %>",
    htmlBody: "<p>Hello <%= it.customerName %></p>",
    from: "  <%= it.senderAddress %>  ",
    to: ["<%= it.customerEmail %>"],
    cc: ["<%= it.ccList %>"],
    bcc: ["<%= it.bccList %>"],
    variables: [
      { key: "invoiceNumber", type: TemplateVariableType.Text },
      { key: "customerName", type: TemplateVariableType.Text },
      { key: "senderAddress", type: TemplateVariableType.Text },
      { key: "customerEmail", type: TemplateVariableType.Text },
      { key: "ccList", type: TemplateVariableType.Text },
      { key: "bccList", type: TemplateVariableType.Text },
    ],
    ...overrides,
  };
}

function template(overrides: Partial<MailTemplateContentInput> = {}) {
  return createMailTemplate({
    id: ID,
    createdByUserId: AUTHOR,
    createdAt: NOW,
    ...content(overrides),
  });
}

const FILLED: readonly TemplateValueEntry[] = [
  { key: "invoiceNumber", value: "INV-42" },
  { key: "customerName", value: "Ada" },
  { key: "senderAddress", value: "billing@example.com" },
  { key: "customerEmail", value: "ada@other.com" },
  { key: "ccList", value: "cc@other.com" },
  { key: "bccList", value: "bcc@other.com" },
];

describe("renderTemplate", () => {
  test("renders subject, both bodies, from and every recipient slot with interpolation", () => {
    const rendered = renderTemplate(deps(), template(), FILLED);

    expect(rendered.subject).toBe("Invoice INV-42 is due");
    expect(rendered.text).toBe("Hello Ada");
    expect(rendered.html).toBe("<p>Hello Ada</p>");
    expect(rendered.from).toBe("billing@example.com");
    expect(rendered.to).toEqual(["ada@other.com"]);
    expect(rendered.cc).toEqual(["cc@other.com"]);
    expect(rendered.bcc).toEqual(["bcc@other.com"]);
    expect(rendered.validation.valid).toBe(true);
  });

  test("escapes interpolations in the html body only", () => {
    const rendered = renderTemplate(deps(), template(), [
      ...FILLED.slice(0, 1),
      { key: "customerName", value: "A & B <ok>" },
      ...FILLED.slice(2),
    ]);

    expect(rendered.subject).toBe("Invoice INV-42 is due");
    expect(rendered.text).toBe("Hello A & B <ok>");
    expect(rendered.html).toBe("<p>Hello A &amp; B &lt;ok&gt;</p>");
  });

  test("splits a rendered recipient slot on commas, semicolons and newlines, dropping empty fragments", () => {
    const rendered = renderTemplate(deps(), template(), [
      ...FILLED.slice(0, 4),
      {
        key: "ccList",
        value: "a@other.com, b@other.com;; c@other.com\nd@other.com",
      },
      { key: "bccList", value: "bcc@other.com" },
    ]);

    expect(rendered.cc).toEqual([
      "a@other.com",
      "b@other.com",
      "c@other.com",
      "d@other.com",
    ]);
  });

  test("keeps textBody, htmlBody and from null when the template declares none", () => {
    const rendered = renderTemplate(
      deps(),
      template({ textBody: null, htmlBody: "<p>Hello</p>", from: null }),
      FILLED,
    );

    expect(rendered.text).toBeNull();
    expect(rendered.html).toBe("<p>Hello</p>");
    expect(rendered.from).toBeNull();
  });

  test("keeps htmlBody null when the template declares none", () => {
    const rendered = renderTemplate(
      deps(),
      template({ htmlBody: null }),
      FILLED,
    );

    expect(rendered.html).toBeNull();
  });

  test("reports an invalid validation and renders absent keys as empty strings, without throwing", () => {
    const rendered = renderTemplate(deps(), template(), [
      { key: "invoiceNumber", value: "INV-42" },
    ]);

    expect(rendered.validation.valid).toBe(false);
    expect(rendered.validation.missing).toEqual([
      "customerName",
      "senderAddress",
      "customerEmail",
      "ccList",
      "bccList",
    ]);
    expect(rendered.subject).toBe("Invoice INV-42 is due");
    expect(rendered.text).toBe("Hello ");
    expect(rendered.from).toBe("");
    expect(rendered.to).toEqual([]);
  });

  test("surfaces a renderer syntax error in the subject as BadUserInputError naming the subject field", () => {
    let thrown: unknown;
    try {
      renderTemplate(
        deps(),
        template({ subject: "<% doSomething() %>" }),
        FILLED,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadUserInputError);
    expect((thrown as BadUserInputError).field).toBe("subject");
  });

  test("surfaces a renderer syntax error in a recipient slot as BadUserInputError naming to[0]", () => {
    let thrown: unknown;
    try {
      renderTemplate(deps(), template({ to: ["<% doSomething() %>"] }), FILLED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadUserInputError);
    expect((thrown as BadUserInputError).field).toBe("to[0]");
  });

  test("trims the rendered from address, even when the interpolated value carries surrounding whitespace", () => {
    const rendered = renderTemplate(deps(), template(), [
      ...FILLED.slice(0, 2),
      { key: "senderAddress", value: "  billing@example.com  " },
      ...FILLED.slice(3),
    ]);

    expect(rendered.from).toBe("billing@example.com");
  });
});
