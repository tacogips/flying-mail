import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import {
  createAddressPattern,
  MATCH_ALL_ADDRESSES,
} from "../value-objects/address-pattern";
import { createEmailAddress } from "../value-objects/email-address";
import {
  createApiKeyId,
  createApiKeyScopeId,
  createDomainId,
} from "../value-objects/ids";
import {
  CALENDAR_CAPABILITIES,
  Capability,
  TEMPLATE_CAPABILITIES,
  createApiKey,
  createApiKeyScope,
  isApiKeyUsable,
  isCalendarCapability,
  isGlobalCapability,
  isTemplateCapability,
  recordApiKeyUsage,
  revokeApiKey,
  scopeMatches,
  scopesAuthorize,
  scopesAuthorizeGlobal,
  scopesForCapability,
} from "./api-key";

const keyId = createApiKeyId("key-1");
const domainA = createDomainId("dom-a");
const domainB = createDomainId("dom-b");

const key = () =>
  createApiKey({
    id: keyId,
    name: "  support agent  ",
    keyHash: "hash",
    keyPrefix: "ybm_abc123",
    createdByUserId: null,
    expiresAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
  });

const scope = (
  id: string,
  capability: Capability,
  domainId: ReturnType<typeof createDomainId> | null,
  pattern: string,
) =>
  createApiKeyScope({
    id: createApiKeyScopeId(id),
    apiKeyId: keyId,
    capability,
    domainId,
    addressPattern:
      pattern === "*" ? MATCH_ALL_ADDRESSES : createAddressPattern(pattern),
  });

describe("createApiKey", () => {
  test("trims the name and starts unused and unrevoked", () => {
    const created = key();
    expect(created.name).toBe("support agent");
    expect(created.lastUsedAt).toBeNull();
    expect(created.revokedAt).toBeNull();
  });

  test.each([
    ["blank name", { name: "   " }],
    ["blank hash", { keyHash: "  " }],
  ])("rejects a %s", (_label, overrides) => {
    expect(() =>
      createApiKey({ ...key(), ...overrides, createdAt: "x" }),
    ).toThrow(ValidationError);
  });

  test("rejects an over-long name", () => {
    expect(() =>
      createApiKey({ ...key(), name: "a".repeat(129), createdAt: "x" }),
    ).toThrow(ValidationError);
  });
});

describe("usability", () => {
  test("a fresh key is usable", () => {
    expect(isApiKeyUsable(key(), "2026-08-23T01:00:00.000Z")).toBe(true);
  });

  test("a revoked key is never usable", () => {
    const revoked = revokeApiKey(key(), "2026-08-23T01:00:00.000Z");
    expect(isApiKeyUsable(revoked, "2026-08-23T02:00:00.000Z")).toBe(false);
  });

  test("re-revoking keeps the original timestamp", () => {
    const first = revokeApiKey(key(), "2026-08-23T01:00:00.000Z");
    const second = revokeApiKey(first, "2026-08-24T01:00:00.000Z");
    expect(second.revokedAt).toBe("2026-08-23T01:00:00.000Z");
  });

  test("an expired key is not usable", () => {
    const expiring = { ...key(), expiresAt: "2026-08-23T01:00:00.000Z" };
    expect(isApiKeyUsable(expiring, "2026-08-23T00:30:00.000Z")).toBe(true);
    expect(isApiKeyUsable(expiring, "2026-08-23T01:00:00.000Z")).toBe(false);
    expect(isApiKeyUsable(expiring, "2026-08-23T02:00:00.000Z")).toBe(false);
  });

  test("usage is recorded without affecting usability", () => {
    const used = recordApiKeyUsage(key(), "2026-08-23T01:00:00.000Z");
    expect(used.lastUsedAt).toBe("2026-08-23T01:00:00.000Z");
    expect(isApiKeyUsable(used, "2026-08-23T02:00:00.000Z")).toBe(true);
  });
});

describe("createApiKeyScope", () => {
  test("normalizes a global capability to an unrestricted scope", () => {
    const created = scope("s1", Capability.KeyAdmin, domainA, "a@example.com");
    expect(created.domainId).toBeNull();
  });

  test("keeps the domain for a per-address capability", () => {
    const created = scope("s2", Capability.MailRead, domainA, "a@example.com");
    expect(created.domainId).toBe(domainA);
  });

  test("identifies global capabilities", () => {
    expect(isGlobalCapability(Capability.DomainAdmin)).toBe(true);
    expect(isGlobalCapability(Capability.KeyAdmin)).toBe(true);
    expect(isGlobalCapability(Capability.MailRead)).toBe(false);
  });
});

describe("scopeMatches", () => {
  const support = createEmailAddress("support@example.com");
  const billing = createEmailAddress("billing@example.com");

  test("requires an exact capability, never a hierarchy", () => {
    const readScope = scope("s", Capability.MailRead, domainA, "*");
    expect(
      scopeMatches(readScope, {
        capability: Capability.MailRead,
        domainId: domainA,
        address: support,
      }),
    ).toBe(true);
    expect(
      scopeMatches(readScope, {
        capability: Capability.MailManage,
        domainId: domainA,
        address: support,
      }),
    ).toBe(false);
  });

  test("a null domain matches every domain", () => {
    const anyDomain = scope("s", Capability.MailRead, null, "*");
    for (const domainId of [domainA, domainB]) {
      expect(
        scopeMatches(anyDomain, {
          capability: Capability.MailRead,
          domainId,
          address: support,
        }),
      ).toBe(true);
    }
  });

  test("a set domain does not match another domain", () => {
    const onlyA = scope("s", Capability.MailRead, domainA, "*");
    expect(
      scopeMatches(onlyA, {
        capability: Capability.MailRead,
        domainId: domainB,
        address: support,
      }),
    ).toBe(false);
  });

  test("the address pattern is applied", () => {
    const onlySupport = scope(
      "s",
      Capability.MailRead,
      domainA,
      "support@example.com",
    );
    expect(
      scopeMatches(onlySupport, {
        capability: Capability.MailRead,
        domainId: domainA,
        address: support,
      }),
    ).toBe(true);
    expect(
      scopeMatches(onlySupport, {
        capability: Capability.MailRead,
        domainId: domainA,
        address: billing,
      }),
    ).toBe(false);
  });
});

describe("scope lists", () => {
  const support = createEmailAddress("support@example.com");
  const billing = createEmailAddress("billing@example.com");
  const scopes = [
    scope("s1", Capability.MailRead, domainA, "support@example.com"),
    scope("s2", Capability.MailSend, domainA, "support@example.com"),
    scope("s3", Capability.KeyAdmin, null, "*"),
  ];

  test("scopesAuthorize passes when any scope matches", () => {
    expect(
      scopesAuthorize(scopes, {
        capability: Capability.MailRead,
        domainId: domainA,
        address: support,
      }),
    ).toBe(true);
    expect(
      scopesAuthorize(scopes, {
        capability: Capability.MailRead,
        domainId: domainA,
        address: billing,
      }),
    ).toBe(false);
  });

  test("scopesAuthorizeGlobal ignores domain and address", () => {
    expect(scopesAuthorizeGlobal(scopes, Capability.KeyAdmin)).toBe(true);
    expect(scopesAuthorizeGlobal(scopes, Capability.DomainAdmin)).toBe(false);
  });

  test("scopesForCapability filters", () => {
    expect(scopesForCapability(scopes, Capability.MailRead)).toHaveLength(1);
    expect(scopesForCapability(scopes, Capability.MailManage)).toHaveLength(0);
  });

  test("an empty scope list authorizes nothing", () => {
    expect(
      scopesAuthorize([], {
        capability: Capability.MailRead,
        domainId: domainA,
        address: support,
      }),
    ).toBe(false);
    expect(scopesAuthorizeGlobal([], Capability.KeyAdmin)).toBe(false);
  });
});

describe("calendar and template capabilities", () => {
  test("the enum carries every capability the migrations admit", () => {
    // Kept in step with the CHECK constraints in 0006 and 0007: a value in
    // one and not the other is a row the database refuses to store.
    expect(new Set(Object.values(Capability))).toEqual(
      new Set([
        "MAIL_READ",
        "MAIL_SEND",
        "MAIL_MANAGE",
        "FILE_LINK",
        "DOMAIN_ADMIN",
        "KEY_ADMIN",
        "TEMPLATE_READ",
        "TEMPLATE_CREATE",
        "TEMPLATE_UPDATE",
        "TEMPLATE_DELETE",
        "CALENDAR_READ",
        "CALENDAR_WRITE",
      ]),
    );
  });

  test("narrows the calendar capabilities and nothing else", () => {
    expect(isCalendarCapability(Capability.CalendarRead)).toBe(true);
    expect(isCalendarCapability(Capability.CalendarWrite)).toBe(true);
    expect(isCalendarCapability(Capability.MailRead)).toBe(false);
    expect(isCalendarCapability(Capability.TemplateRead)).toBe(false);
    expect(CALENDAR_CAPABILITIES).toHaveLength(2);
  });

  test("narrows the template capabilities and nothing else", () => {
    for (const capability of TEMPLATE_CAPABILITIES) {
      expect(isTemplateCapability(capability)).toBe(true);
    }
    expect(isTemplateCapability(Capability.CalendarRead)).toBe(false);
    expect(isTemplateCapability(Capability.MailSend)).toBe(false);
    expect(TEMPLATE_CAPABILITIES).toHaveLength(4);
  });

  test("calendar capabilities are per-address, template ones instance-wide", () => {
    // A calendar scope is matched against the owner's account address, so it
    // must not be global; a template belongs to no mailbox, so it must be.
    expect(isGlobalCapability(Capability.CalendarRead)).toBe(false);
    expect(isGlobalCapability(Capability.CalendarWrite)).toBe(false);
    for (const capability of TEMPLATE_CAPABILITIES) {
      expect(isGlobalCapability(capability)).toBe(true);
    }
  });
});
