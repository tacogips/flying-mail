import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createMailTemplateId, createUserId } from "../value-objects/ids";
import {
  createMailTemplate,
  MAX_TEMPLATE_VARIABLES,
  type MailTemplateContentInput,
  templateSources,
  TemplateVariableType,
  updateMailTemplate,
} from "./mail-template";

const ID = createMailTemplateId("tpl-1");
const AUTHOR = createUserId("user-1");
const NOW = "2026-08-24T00:00:00.000Z";

function content(
  overrides: Partial<MailTemplateContentInput> = {},
): MailTemplateContentInput {
  return {
    name: "Invoice reminder",
    subject: "Invoice <%= it.invoiceNumber %> is due",
    textBody: "Hello <%= it.customerName %>",
    variables: [
      { key: "invoiceNumber", type: TemplateVariableType.Text },
      { key: "customerName", type: TemplateVariableType.Text },
    ],
    ...overrides,
  };
}

function create(overrides: Partial<MailTemplateContentInput> = {}) {
  return createMailTemplate({
    id: ID,
    createdByUserId: AUTHOR,
    createdAt: NOW,
    ...content(overrides),
  });
}

describe("createMailTemplate", () => {
  it("trims the name and keeps both timestamps equal on creation", () => {
    const template = create({ name: "  Invoice reminder  " });
    expect(template.name).toBe("Invoice reminder");
    expect(template.createdAt).toBe(NOW);
    expect(template.updatedAt).toBe(NOW);
  });

  it("defaults a variable's label to its key and required to true", () => {
    const template = create();
    expect(template.variables[0]).toMatchObject({
      key: "invoiceNumber",
      label: "invoiceNumber",
      required: true,
      defaultValue: null,
    });
  });

  it("rejects a template with neither body", () => {
    expect(() => create({ textBody: null, htmlBody: null })).toThrow(
      ValidationError,
    );
  });

  it("treats a whitespace-only body as absent", () => {
    expect(() => create({ textBody: "   \n  ", htmlBody: null })).toThrow(
      /text or html body/,
    );
  });

  it("accepts an html-only template", () => {
    const template = create({
      textBody: null,
      htmlBody: "<p>Hello <%= it.customerName %></p>",
    });
    expect(template.textBody).toBeNull();
    expect(template.htmlBody).toContain("customerName");
  });

  it("rejects a blank name and a blank subject", () => {
    expect(() => create({ name: "   " })).toThrow(/name must not be empty/);
    expect(() => create({ subject: "" })).toThrow(/subject must not be empty/);
  });

  it("rejects a duplicate variable key", () => {
    expect(() =>
      create({
        variables: [
          { key: "a", type: TemplateVariableType.Text },
          { key: "a", type: TemplateVariableType.Number },
        ],
      }),
    ).toThrow(/declared more than once/);
  });

  it("rejects a variable key that is not identifier-shaped", () => {
    expect(() =>
      create({
        variables: [{ key: "my-var", type: TemplateVariableType.Text }],
      }),
    ).toThrow(/must start with a letter or underscore/);
  });

  it("rejects more variables than the cap", () => {
    const variables = Array.from(
      { length: MAX_TEMPLATE_VARIABLES + 1 },
      (_unused, index) => ({
        key: `v${index}`,
        type: TemplateVariableType.Text,
      }),
    );
    expect(() => create({ variables })).toThrow(/at most/);
  });

  it("drops blank recipient entries", () => {
    const template = create({ to: ["  ", "a@example.com", ""] });
    expect(template.to).toEqual(["a@example.com"]);
  });
});

describe("updateMailTemplate", () => {
  it("replaces content and the variable set while preserving identity", () => {
    const original = create();
    const updated = updateMailTemplate(
      original,
      content({
        name: "Renamed",
        variables: [{ key: "only", type: TemplateVariableType.Number }],
        subject: "Hi <%= it.only %>",
        textBody: "body",
      }),
      "2026-08-25T00:00:00.000Z",
    );
    expect(updated.id).toBe(original.id);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.createdByUserId).toBe(original.createdByUserId);
    expect(updated.updatedAt).toBe("2026-08-25T00:00:00.000Z");
    expect(updated.name).toBe("Renamed");
    expect(updated.variables).toHaveLength(1);
  });
});

describe("templateSources", () => {
  it("enumerates every Eta source with the field an error should name", () => {
    const template = create({
      htmlBody: "<p><%= it.customerName %></p>",
      from: "billing@example.com",
      to: ["<%= it.customerEmail %>", "copy@example.com"],
      cc: ["cc@example.com"],
      variables: [
        { key: "invoiceNumber", type: TemplateVariableType.Text },
        { key: "customerName", type: TemplateVariableType.Text },
        { key: "customerEmail", type: TemplateVariableType.Email },
      ],
    });
    expect(templateSources(template).map((entry) => entry.field)).toEqual([
      "subject",
      "textBody",
      "htmlBody",
      "from",
      "to[0]",
      "to[1]",
      "cc[0]",
    ]);
  });

  it("omits absent optional sources", () => {
    const template = create({ htmlBody: null, from: null });
    expect(templateSources(template).map((entry) => entry.field)).toEqual([
      "subject",
      "textBody",
    ]);
  });
});
