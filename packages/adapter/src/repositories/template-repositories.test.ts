import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  Capability,
  type TemplateCapability,
} from "@mailcal/domain/entities/api-key";
import {
  createMailTemplate,
  type MailTemplate,
  type MailTemplateContentInput,
  TemplateVariableType,
} from "@mailcal/domain/entities/mail-template";
import { UserPermissionEffect } from "@mailcal/domain/entities/user-mail-permission";
import { createUserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import {
  createMailTemplateId,
  createUserId,
  createUserTemplatePermissionId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMailTemplateRepository } from "./mail-template-repository";
import { createMigratedDatabase, seedUser } from "./test-support";
import { createUserTemplatePermissionRepository } from "./user-template-permission-repository";

const TS = "2026-08-23T00:00:00.000Z";
const AUTHOR = createUserId("usr-1");

function template(
  id: string,
  overrides: Partial<MailTemplateContentInput> = {},
): MailTemplate {
  return createMailTemplate({
    id: createMailTemplateId(id),
    createdByUserId: AUTHOR,
    createdAt: TS,
    name: id,
    subject: "Invoice <%= it.invoiceNumber %>",
    textBody: "Hello <%= it.customerName %>",
    to: ["<%= it.customerEmail %>"],
    variables: [
      { key: "invoiceNumber", type: TemplateVariableType.Text },
      {
        key: "customerName",
        label: "Customer name",
        type: TemplateVariableType.Text,
        required: false,
        defaultValue: "there",
        description: "Shown in the greeting",
      },
      { key: "customerEmail", type: TemplateVariableType.Email },
    ],
    ...overrides,
  });
}

describe("mail template repository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMailTemplateRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedUser(db, { id: AUTHOR, email: "author@example.com" });
    repository = createMailTemplateRepository(db);
  });

  test("round-trips a template with its whole variable set", async () => {
    const stored = template("tpl-1");
    await repository.save(stored);
    expect(await repository.findById(stored.id)).toEqual(stored);
  });

  test("preserves variable order and every per-variable field", async () => {
    const stored = template("tpl-1");
    await repository.save(stored);
    const loaded = await repository.findById(stored.id);
    expect(loaded?.variables.map((variable) => variable.key)).toEqual([
      "invoiceNumber",
      "customerName",
      "customerEmail",
    ]);
    expect(loaded?.variables[1]).toEqual({
      key: "customerName",
      label: "Customer name",
      type: TemplateVariableType.Text,
      required: false,
      defaultValue: "there",
      description: "Shown in the greeting",
    });
  });

  test("replaces the variable set on save rather than merging it", async () => {
    const stored = template("tpl-1");
    await repository.save(stored);
    await repository.save({
      ...stored,
      subject: "Hi <%= it.only %>",
      textBody: "body",
      to: [],
      variables: [
        {
          key: "only",
          label: "Only",
          type: TemplateVariableType.Text,
          required: true,
          defaultValue: null,
          description: null,
        },
      ],
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    const loaded = await repository.findById(stored.id);
    expect(loaded?.variables.map((variable) => variable.key)).toEqual(["only"]);
    expect(loaded?.updatedAt).toBe("2026-08-24T00:00:00.000Z");
    expect(loaded?.createdAt).toBe(TS);
  });

  test("finds by name case-insensitively", async () => {
    await repository.save(template("Invoice reminder"));
    expect(await repository.findByName("  invoice REMINDER ")).not.toBeNull();
    expect(await repository.findByName("something else")).toBeNull();
  });

  test("lists templates by name and hydrates each one's variables", async () => {
    await repository.save(template("beta"));
    await repository.save(template("alpha"));
    const listed = await repository.list();
    expect(listed.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
    expect(listed[0]?.variables).toHaveLength(3);
  });

  test("delete removes the template and its variables", async () => {
    const stored = template("tpl-1");
    await repository.save(stored);
    await repository.delete(stored.id);
    expect(await repository.findById(stored.id)).toBeNull();
    const rows = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM mail_template_variables",
    );
    expect(rows[0]?.count).toBe(0);
  });

  test("keeps an html-only template's null text body null", async () => {
    const stored = template("tpl-html", {
      textBody: null,
      htmlBody: "<p><%= it.customerName %></p>",
    });
    await repository.save(stored);
    const loaded = await repository.findById(stored.id);
    expect(loaded?.textBody).toBeNull();
    expect(loaded?.htmlBody).toBe("<p><%= it.customerName %></p>");
  });

  test("survives an unparseable recipient JSON column", async () => {
    const stored = template("tpl-1");
    await repository.save(stored);
    await db.execute(
      "UPDATE mail_templates SET cc_addresses_json = 'not json' WHERE id = ?",
      [stored.id],
    );
    // A hand-edited row degrades to an empty list rather than failing the
    // whole read and taking the catalogue down with it.
    expect((await repository.findById(stored.id))?.cc).toEqual([]);
  });
});

describe("user template permission repository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createUserTemplatePermissionRepository>;

  const rule = (
    id: string,
    userId = AUTHOR,
    capability: TemplateCapability = Capability.TemplateCreate,
    effect = UserPermissionEffect.Allow,
  ) =>
    createUserTemplatePermission({
      id: createUserTemplatePermissionId(id),
      userId,
      capability,
      effect,
      createdByUserId: AUTHOR,
      createdAt: TS,
    });

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedUser(db, { id: AUTHOR, email: "author@example.com" });
    repository = createUserTemplatePermissionRepository(db);
  });

  test("round-trips a rule", async () => {
    const stored = rule("rule-1");
    await repository.save(stored);
    expect(await repository.findById(stored.id)).toEqual(stored);
  });

  test("re-saving the same (user, capability) replaces the effect", async () => {
    await repository.save(rule("rule-1"));
    await repository.save(
      rule(
        "rule-1",
        AUTHOR,
        Capability.TemplateCreate,
        UserPermissionEffect.Deny,
      ),
    );
    const listed = await repository.listByUserId(AUTHOR);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.effect).toBe(UserPermissionEffect.Deny);
  });

  test("finds by user and capability", async () => {
    await repository.save(rule("rule-1"));
    expect(
      await repository.findByUserAndCapability(
        AUTHOR,
        Capability.TemplateCreate,
      ),
    ).not.toBeNull();
    expect(
      await repository.findByUserAndCapability(
        AUTHOR,
        Capability.TemplateDelete,
      ),
    ).toBeNull();
  });

  test("groups a multi-user lookup, including users with no rules", async () => {
    const other = createUserId("usr-2");
    await seedUser(db, { id: other, email: "other@example.com" });
    await repository.save(rule("rule-1"));
    const grouped = await repository.listByUserIds([AUTHOR, other]);
    expect(grouped.get(AUTHOR)).toHaveLength(1);
    expect(grouped.get(other)).toEqual([]);
  });

  test("delete removes only the named rule", async () => {
    await repository.save(rule("rule-1"));
    await repository.save(
      rule(
        "rule-2",
        AUTHOR,
        Capability.TemplateDelete,
        UserPermissionEffect.Deny,
      ),
    );
    await repository.delete(createUserTemplatePermissionId("rule-1"));
    const remaining = await repository.listByUserId(AUTHOR);
    expect(remaining.map((entry) => entry.capability)).toEqual([
      Capability.TemplateDelete,
    ]);
  });

  test("cascades when the user is deleted", async () => {
    await repository.save(rule("rule-1"));
    await db.execute("DELETE FROM users WHERE id = ?", [AUTHOR]);
    expect(await repository.listByUserId(AUTHOR)).toEqual([]);
  });
});
