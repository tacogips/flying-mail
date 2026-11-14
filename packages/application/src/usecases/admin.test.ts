import { Capability } from "@flying-mail/domain/entities/api-key";
import {
  createMailDomain,
  DomainStatus,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { SystemTagSlug } from "@flying-mail/domain/entities/tag";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createApiKeyId,
  createDomainId,
  createTagId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "../test-support/viewer-fixtures";
import {
  createAddApiKeyScopeUseCase,
  createCreateApiKeyUseCase,
  createListApiKeysUseCase,
  createRevokeApiKeyUseCase,
} from "./api-keys";
import {
  buildDomainDnsRecords,
  createCreateDomainUseCase,
  createDeleteDomainUseCase,
  createListDomainsUseCase,
  createSetDomainStatusUseCase,
  createVerifyDomainUseCase,
} from "./domains";
import {
  createCreateTagUseCase,
  createDeleteTagUseCase,
  createEnsureSystemTagsUseCase,
  createRenameTagUseCase,
} from "./tags";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

describe("domains", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("an admin creates a pending domain with a verification token", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "Example.com", true);
    expect(domain.name).toBe("example.com");
    expect(domain.status).toBe(DomainStatus.Pending);
    expect(domain.verificationToken).toMatch(/^[0-9a-f]{48}$/);
  });

  test("a member may not create a domain", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    await expect(
      create(memberViewer(), "example.com", true),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a key without DOMAIN_ADMIN may not create a domain", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const viewer = apiKeyViewer([{ capability: Capability.MailRead }]);
    await expect(create(viewer, "example.com", true)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("a key with DOMAIN_ADMIN may create a domain", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const viewer = apiKeyViewer([{ capability: Capability.DomainAdmin }]);
    await expect(create(viewer, "example.com", true)).resolves.toMatchObject({
      name: "example.com",
    });
  });

  test("rejects a duplicate domain name", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    await create(adminViewer(), "example.com", true);
    await expect(
      create(adminViewer(), "EXAMPLE.com", true),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects a malformed domain name", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    await expect(
      create(adminViewer(), "localhost", true),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("verification checks the ownership TXT record and activates", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.dns.setTxt(`_mailcal.example.com`, [
      `mailcal-verification=${domain.verificationToken}`,
    ]);
    const verify = createVerifyDomainUseCase(fake.deps);
    const verified = await verify(adminViewer(), domain.id);
    expect(verified.status).toBe(DomainStatus.Active);
    expect(verified.verifiedAt).toBe(NOW);
  });

  test.each([
    ["an MX host below the configured suffix", "route1.mx.cloudflare.net"],
    [
      "an uppercase MX host with a trailing root dot",
      "ROUTE1.MX.CLOUDFLARE.NET.",
    ],
    ["the configured suffix itself", "mx.cloudflare.net"],
  ])("verification accepts %s", async (_label, exchange) => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.dns.setTxt("_mailcal.example.com", [
      `mailcal-verification=${domain.verificationToken}`,
    ]);
    fake.dns.setMx("example.com", [{ priority: 10, exchange }]);
    await expect(
      createVerifyDomainUseCase(fake.deps)(adminViewer(), domain.id),
    ).resolves.toMatchObject({ status: DomainStatus.Active });
  });

  test.each([
    [
      "a non-Cloudflare exchange",
      [{ priority: 1, exchange: "aspmx.l.google.com" }],
    ],
    [
      "a Cloudflare suffix with an attacker domain appended",
      [{ priority: 1, exchange: "evil-mx.cloudflare.net.attacker.com" }],
    ],
    [
      "a fake Cloudflare MX name",
      [{ priority: 1, exchange: "fakemx.cloudflare.net" }],
    ],
    ["no MX records", []],
  ])("verification keeps a domain pending with %s", async (_label, records) => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.dns.setTxt("_mailcal.example.com", [
      `mailcal-verification=${domain.verificationToken}`,
    ]);
    fake.dns.setMx("example.com", records);
    await expect(
      createVerifyDomainUseCase(fake.deps)(adminViewer(), domain.id),
    ).rejects.toMatchObject({
      name: "ConflictError",
      message: expect.stringContaining(
        records.length === 0
          ? "Current MX: none"
          : `Current MX: ${records.map(({ exchange }) => exchange).join(", ")}`,
      ),
    });
    await expect(
      fake.deps.mailDomainRepository.findById(domain.id),
    ).resolves.toMatchObject({
      status: DomainStatus.Pending,
      verifiedAt: null,
    });
  });

  test("verification reports MX lookup failures as SERVICE_UNAVAILABLE", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.dns.setTxt("_mailcal.example.com", [
      `mailcal-verification=${domain.verificationToken}`,
    ]);
    fake.dns.failNextMxLookup(new Error("resolver down"));
    await expect(
      createVerifyDomainUseCase(fake.deps)(adminViewer(), domain.id),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(
      fake.deps.mailDomainRepository.findById(domain.id),
    ).resolves.toMatchObject({
      status: DomainStatus.Pending,
      verifiedAt: null,
    });
  });

  test("empty inbound suffix disables the MX gate", async () => {
    fake = createFakeDependencies({
      now: NOW,
      instanceConfig: { inboundMxSuffix: null },
    });
    const domain = await createCreateDomainUseCase(fake.deps)(
      adminViewer(),
      "example.com",
      true,
    );
    fake.dns.setTxt("_mailcal.example.com", [
      `mailcal-verification=${domain.verificationToken}`,
    ]);
    fake.dns.setMx("example.com", []);
    await expect(
      createVerifyDomainUseCase(fake.deps)(adminViewer(), domain.id),
    ).resolves.toMatchObject({ status: DomainStatus.Active });
  });

  test("already verified domains return before DNS lookups", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const pending = await create(adminViewer(), "example.com", true);
    const verified = verifyMailDomain(pending, NOW);
    await fake.deps.mailDomainRepository.save(verified);
    fake.dns.failNextLookup(new Error("must not look up TXT"));
    fake.dns.failNextMxLookup(new Error("must not look up MX"));
    await expect(
      createVerifyDomainUseCase(fake.deps)(adminViewer(), pending.id),
    ).resolves.toEqual(verified);
  });

  test("verification fails while the TXT record is absent or wrong", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    const verify = createVerifyDomainUseCase(fake.deps);
    // No record staged at all.
    await expect(verify(adminViewer(), domain.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // A record with the wrong token proves nothing.
    fake.dns.setTxt("_mailcal.example.com", ["mailcal-verification=stolen"]);
    await expect(verify(adminViewer(), domain.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("a broken DNS lookup is SERVICE_UNAVAILABLE, not a denial", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.dns.failNextLookup(new Error("resolver down"));
    const verify = createVerifyDomainUseCase(fake.deps);
    await expect(verify(adminViewer(), domain.id)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  test("activating an unverified domain is a conflict", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    const setStatus = createSetDomainStatusUseCase(fake.deps);
    await expect(
      setStatus(adminViewer(), domain.id, DomainStatus.Active),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("verifying an unknown domain is not found", async () => {
    const verify = createVerifyDomainUseCase(fake.deps);
    await expect(
      verify(adminViewer(), createDomainId("nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("refuses to delete a domain that still holds mail", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    fake.stores.domainMessageCounts.set(domain.id, 3);

    const remove = createDeleteDomainUseCase(fake.deps);
    await expect(remove(adminViewer(), domain.id)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("deletes an empty domain", async () => {
    const create = createCreateDomainUseCase(fake.deps);
    const domain = await create(adminViewer(), "example.com", true);
    const remove = createDeleteDomainUseCase(fake.deps);
    await expect(remove(adminViewer(), domain.id)).resolves.toBe(true);
    expect(await fake.deps.mailDomainRepository.findById(domain.id)).toBeNull();
  });

  test("a scoped key sees only its own domains", async () => {
    await fake.deps.mailDomainRepository.save(
      createMailDomain({
        id: domainId,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
    );
    await fake.deps.mailDomainRepository.save(
      createMailDomain({
        id: createDomainId("dom-2"),
        name: createDomainName("other.com"),
        catchAll: true,
        verificationToken: "tok",
        createdAt: NOW,
      }),
    );
    const list = createListDomainsUseCase(fake.deps);
    const viewer = apiKeyViewer([
      { capability: Capability.MailRead, domainId },
    ]);
    expect((await list(viewer)).map((domain) => domain.name)).toEqual([
      "example.com",
    ]);
    expect((await list(adminViewer())).length).toBe(2);
  });

  test("dns records include ownership, MX and SPF entries", () => {
    const domain = createMailDomain({
      id: domainId,
      name: createDomainName("example.com"),
      catchAll: true,
      verificationToken: "abc",
      createdAt: NOW,
    });
    const records = buildDomainDnsRecords(domain);
    expect(records.some((record) => record.type === "MX")).toBe(true);
    expect(
      records.some((record) =>
        record.value.includes("mailcal-verification=abc"),
      ),
    ).toBe(true);
    expect(records.some((record) => record.value.startsWith("v=spf1"))).toBe(
      true,
    );
  });
});

describe("api keys", () => {
  let fake: FakeDependencies;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
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

  test("issues a key whose secret is returned exactly once", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "support agent",
      scopes: [
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "support@example.com",
        },
      ],
      expiresAt: null,
    });

    expect(issued.secret.startsWith(`${issued.apiKey.keyPrefix}_`)).toBe(true);
    expect(issued.scopes).toHaveLength(1);

    // The stored record holds the hash and the non-secret prefix, and no
    // field carries the plaintext itself. (The test hasher is deliberately
    // reversible, so `keyHash` is excluded from this check -- a real
    // SHA-256 hasher makes it one-way.)
    const stored = fake.stores.apiKeys.get(issued.apiKey.id);
    expect(stored?.keyHash).toBe(`hash(${issued.secret})`);
    expect(stored?.keyPrefix).toBe(issued.apiKey.keyPrefix);
    const nonHashValues = Object.entries(stored ?? {})
      .filter(([key]) => key !== "keyHash")
      .map(([, value]) => value);
    expect(nonHashValues).not.toContain(issued.secret);
  });

  test("rejects an unscoped key", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    await expect(
      create(adminViewer(), { name: "useless", scopes: [], expiresAt: null }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects a malformed address pattern", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    await expect(
      create(adminViewer(), {
        name: "bad",
        scopes: [
          {
            capability: Capability.MailRead,
            domainId,
            addressPattern: "a*b*c@example.com",
          },
        ],
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects an unknown domain in a scope", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    await expect(
      create(adminViewer(), {
        name: "bad",
        scopes: [
          {
            capability: Capability.MailRead,
            domainId: createDomainId("nope"),
            addressPattern: "*",
          },
        ],
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a member user may not issue keys", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    await expect(
      create(memberViewer(), {
        name: "x",
        scopes: [
          { capability: Capability.MailRead, domainId, addressPattern: "*" },
        ],
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe("privilege escalation guard", () => {
    test("a key cannot grant a capability it does not hold", async () => {
      const create = createCreateApiKeyUseCase(fake.deps);
      const issuer = apiKeyViewer([
        { capability: Capability.KeyAdmin },
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "support@example.com",
        },
      ]);
      await expect(
        create(issuer, {
          name: "escalated",
          scopes: [
            {
              capability: Capability.MailSend,
              domainId,
              addressPattern: "support@example.com",
            },
          ],
          expiresAt: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a key cannot widen an address pattern it holds", async () => {
      const create = createCreateApiKeyUseCase(fake.deps);
      const issuer = apiKeyViewer([
        { capability: Capability.KeyAdmin },
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "support@example.com",
        },
      ]);
      await expect(
        create(issuer, {
          name: "widened",
          scopes: [
            {
              capability: Capability.MailRead,
              domainId,
              addressPattern: "*@example.com",
            },
          ],
          expiresAt: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a key may grant a narrower scope it already covers", async () => {
      const create = createCreateApiKeyUseCase(fake.deps);
      const issuer = apiKeyViewer([
        { capability: Capability.KeyAdmin },
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "*@example.com",
        },
      ]);
      const issued = await create(issuer, {
        name: "narrowed",
        scopes: [
          {
            capability: Capability.MailRead,
            domainId,
            addressPattern: "support@example.com",
          },
        ],
        expiresAt: null,
      });
      expect(issued.scopes).toHaveLength(1);
    });
  });

  test("revocation is recorded and repeated revocation is stable", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "temp",
      scopes: [
        { capability: Capability.MailRead, domainId, addressPattern: "*" },
      ],
      expiresAt: null,
    });

    const revoke = createRevokeApiKeyUseCase(fake.deps);
    const revoked = await revoke(adminViewer(), issued.apiKey.id);
    expect(revoked.revokedAt).toBe(NOW);

    fake.clock.set("2026-08-24T00:00:00.000Z");
    const again = await revoke(adminViewer(), issued.apiKey.id);
    expect(again.revokedAt).toBe(NOW);
  });

  test("revoking an unknown key is not found", async () => {
    const revoke = createRevokeApiKeyUseCase(fake.deps);
    await expect(
      revoke(adminViewer(), createApiKeyId("nope")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("scopes can be added to an existing key", async () => {
    const create = createCreateApiKeyUseCase(fake.deps);
    const issued = await create(adminViewer(), {
      name: "growing",
      scopes: [
        {
          capability: Capability.MailRead,
          domainId,
          addressPattern: "support@example.com",
        },
      ],
      expiresAt: null,
    });
    const addScope = createAddApiKeyScopeUseCase(fake.deps);
    const scopes = await addScope(adminViewer(), issued.apiKey.id, {
      capability: Capability.MailSend,
      domainId,
      addressPattern: "support@example.com",
    });
    expect(scopes).toHaveLength(2);
  });

  test("listing requires KEY_ADMIN", async () => {
    const list = createListApiKeysUseCase(fake.deps);
    await expect(list(memberViewer())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(list(adminViewer())).resolves.toEqual([]);
  });
});

describe("tags", () => {
  let fake: FakeDependencies;

  beforeEach(() => {
    fake = createFakeDependencies({ now: NOW });
  });

  test("creates a user tag", async () => {
    const create = createCreateTagUseCase(fake.deps);
    const tag = await create(adminViewer(), " Invoices ", "#AABBCC");
    expect(tag.name).toBe("Invoices");
    expect(tag.color).toBe("#aabbcc");
  });

  test("rejects a duplicate name", async () => {
    const create = createCreateTagUseCase(fake.deps);
    await create(adminViewer(), "Invoices", null);
    await expect(
      create(adminViewer(), "invoices", null),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects a reserved system name", async () => {
    const create = createCreateTagUseCase(fake.deps);
    await expect(create(adminViewer(), "Trash", null)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("a key without MAIL_MANAGE may not create tags", async () => {
    const create = createCreateTagUseCase(fake.deps);
    const viewer = apiKeyViewer([{ capability: Capability.MailRead }]);
    await expect(create(viewer, "Ideas", null)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("system tags cannot be renamed or deleted", async () => {
    const trash = await fake.deps.tagRepository.findBySystemSlug(
      SystemTagSlug.Trash,
    );
    expect(trash).not.toBeNull();
    const rename = createRenameTagUseCase(fake.deps);
    const remove = createDeleteTagUseCase(fake.deps);
    await expect(
      rename(adminViewer(), trash?.id ?? createTagId("x"), "Junk", null),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      remove(adminViewer(), trash?.id ?? createTagId("x")),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("user tags can be renamed and deleted", async () => {
    const create = createCreateTagUseCase(fake.deps);
    const tag = await create(adminViewer(), "Later", null);
    const rename = createRenameTagUseCase(fake.deps);
    const renamed = await rename(adminViewer(), tag.id, "Someday", "#123456");
    expect(renamed.name).toBe("Someday");

    const remove = createDeleteTagUseCase(fake.deps);
    await expect(remove(adminViewer(), tag.id)).resolves.toBe(true);
  });

  test("seeding system tags is idempotent", async () => {
    const empty = createFakeDependencies({ now: NOW, seedSystemTags: false });
    const ensure = createEnsureSystemTagsUseCase(empty.deps);
    const first = await ensure();
    const second = await ensure();
    expect(first).toHaveLength(3);
    expect(second.map((tag) => tag.id)).toEqual(first.map((tag) => tag.id));
    expect(empty.stores.tags.size).toBe(3);
  });
});
