import type { MailTemplate } from "@mailcal/domain/entities/mail-template";
import type { UserTemplatePermission } from "@mailcal/domain/entities/user-template-permission";
import type { MailTemplateRepository } from "../ports/mail-template-repository";
import {
  TemplateSyntaxError,
  type TemplateRenderer,
} from "../ports/template-renderer";
import type { UserTemplatePermissionRepository } from "../ports/user-template-permission-repository";

export interface FakeTemplateStores {
  readonly mailTemplates: Map<string, MailTemplate>;
  readonly userTemplatePermissions: Map<string, UserTemplatePermission>;
}

export function createFakeTemplateStores(): FakeTemplateStores {
  return {
    mailTemplates: new Map(),
    userTemplatePermissions: new Map(),
  };
}

export function fakeMailTemplateRepository(
  stores: FakeTemplateStores,
): MailTemplateRepository {
  return {
    async findById(id) {
      return stores.mailTemplates.get(id) ?? null;
    },
    async findByName(name) {
      const needle = name.trim().toLowerCase();
      return (
        [...stores.mailTemplates.values()].find(
          (template) => template.name.toLowerCase() === needle,
        ) ?? null
      );
    },
    async list() {
      return [...stores.mailTemplates.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    },
    async save(template) {
      stores.mailTemplates.set(template.id, template);
    },
    async delete(id) {
      stores.mailTemplates.delete(id);
    },
  };
}

export function fakeUserTemplatePermissionRepository(
  stores: FakeTemplateStores,
): UserTemplatePermissionRepository {
  const forUser = (userId: string): readonly UserTemplatePermission[] =>
    [...stores.userTemplatePermissions.values()].filter(
      (permission) => permission.userId === userId,
    );
  return {
    async findById(id) {
      return stores.userTemplatePermissions.get(id) ?? null;
    },
    async listByUserId(userId) {
      return forUser(userId);
    },
    async listByUserIds(userIds) {
      return new Map(
        userIds.map((userId) => [userId as string, forUser(userId)]),
      );
    },
    async findByUserAndCapability(userId, capability) {
      return (
        forUser(userId).find(
          (permission) => permission.capability === capability,
        ) ?? null
      );
    },
    async save(permission) {
      stores.userTemplatePermissions.set(permission.id, permission);
    },
    async delete(id) {
      stores.userTemplatePermissions.delete(id);
    },
  };
}

/** Matches an Eta tag: the prefix (`=`, `~`, or nothing) plus its body. */
const TAG_PATTERN = /<%(=|~)?([\s\S]*?)%>/g;
const SIMPLE_PATH = /^it(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/** A stand-in for the Eta adapter, understanding only `<%= it.key %>` and
 * `<%~ it.key %>`.
 *
 * Use case tests are about authorization, validation and the send path, not
 * about template syntax -- the real grammar is exercised against the real
 * parser in `@mailcal/adapter`'s `eta-renderer.test.ts`. Keeping this fake
 * deliberately dumb means an application test cannot accidentally start
 * depending on parser behavior it does not control. */
export function fakeTemplateRenderer(): TemplateRenderer {
  function scan(
    source: string,
    field: string,
  ): readonly {
    readonly raw: string;
    readonly key: string;
    readonly escapable: boolean;
  }[] {
    const tags: { raw: string; key: string; escapable: boolean }[] = [];
    for (const match of source.matchAll(TAG_PATTERN)) {
      const prefix = match[1] ?? "";
      const body = (match[2] ?? "").trim();
      if (prefix === "") {
        throw new TemplateSyntaxError(
          `"<% ${body} %>" is not supported`,
          field,
        );
      }
      if (!SIMPLE_PATH.test(body)) {
        throw new TemplateSyntaxError(`"${body}" is not supported`, field);
      }
      tags.push({
        raw: match[0],
        key: body.slice("it.".length),
        escapable: prefix === "=",
      });
    }
    return tags;
  }

  return {
    referencedVariables(source, field) {
      const keys: string[] = [];
      for (const tag of scan(source, field)) {
        const top = tag.key.split(".")[0] as string;
        if (!keys.includes(top)) {
          keys.push(top);
        }
      }
      return keys;
    },

    render(source, data, options, field) {
      let out = source;
      for (const tag of scan(source, field)) {
        const value = data[tag.key];
        const text = value === undefined || value === null ? "" : String(value);
        const inserted =
          options.escape === "html" && tag.escapable
            ? text
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
            : text;
        out = out.replace(tag.raw, () => inserted);
      }
      return out;
    },
  };
}
