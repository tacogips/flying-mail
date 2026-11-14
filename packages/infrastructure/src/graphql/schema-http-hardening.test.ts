import {
  createFakeDependencies,
  type FakeDependencies,
} from "@flying-mail/application/test-support/fakes";
import {
  adminViewer,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import { createMailDomain } from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createDomainId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

const NOW = "2026-10-07T00:00:00.000Z";
const SECRET_TOKEN = "super-secret-verification-token";
const DOMAIN_A = createDomainId("dom-a");
const DOMAIN_B = createDomainId("dom-b");

async function seedDomain(
  fake: FakeDependencies,
  id: ReturnType<typeof createDomainId>,
  name: string,
): Promise<void> {
  await fake.deps.mailDomainRepository.save(
    createMailDomain({
      id,
      name: createDomainName(name),
      catchAll: true,
      verificationToken: SECRET_TOKEN,
      createdAt: NOW,
    }),
  );
}

describe("MailDomain.dnsRecords", () => {
  let harness: GraphQLHarness;

  beforeEach(async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedDomain(fake, DOMAIN_A, "example.com");
    harness = createGraphQLHarness(fake);
  });

  const QUERY =
    "query { domains { verificationToken dnsRecords { type value } } }";

  test("a domain admin sees the verification token in the TXT record", async () => {
    const result = await harness.run(QUERY, adminViewer());
    expect(errorCodes(result)).toEqual([]);
    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain(`mailcal-verification=${SECRET_TOKEN}`);
  });

  test("a viewer without DOMAIN_ADMIN never receives the token anywhere", async () => {
    const result = await harness.run(QUERY, memberViewer());
    expect(errorCodes(result)).toEqual([]);
    expect(JSON.stringify(result.data)).not.toContain(SECRET_TOKEN);
    const domains = (
      result.data as {
        domains: {
          verificationToken: string | null;
          dnsRecords: { type: string; value: string }[];
        }[];
      }
    ).domains;
    expect(domains[0]?.verificationToken).toBeNull();
    const txt = domains[0]?.dnsRecords.find((record) => record.type === "TXT");
    expect(txt?.value).toBe("mailcal-verification=[redacted]");
    // The remaining records are untouched.
    expect(domains[0]?.dnsRecords.some((record) => record.type === "MX")).toBe(
      true,
    );
  });

  test("an unauthenticated viewer is denied before any record is read", async () => {
    const result = await harness.run(QUERY, null);
    expect(JSON.stringify(result.data ?? null)).not.toContain(SECRET_TOKEN);
  });
});

describe("MailDomain.messageCount", () => {
  test("repeated aliases cost one count per distinct domain", async () => {
    const fake = createFakeDependencies({ now: NOW });
    await seedDomain(fake, DOMAIN_A, "example.com");
    await seedDomain(fake, DOMAIN_B, "example.org");
    const harness = createGraphQLHarness(fake);
    const spy = vi.spyOn(fake.deps.mailDomainRepository, "countMessages");

    const result = await harness.run(
      "query { domains { a: messageCount b: messageCount c: messageCount } }",
      adminViewer(),
    );

    expect(errorCodes(result)).toEqual([]);
    expect(result.data).toEqual({
      domains: [
        { a: 0, b: 0, c: 0 },
        { a: 0, b: 0, c: 0 },
      ],
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new Set(spy.mock.calls.map(([id]) => id))).toEqual(
      new Set([DOMAIN_A, DOMAIN_B]),
    );
  });
});

describe("alias limit through the HTTP stack", () => {
  const harness = createGraphQLHarness(createFakeDependencies({ now: NOW }));

  function aliased(count: number): string {
    return `query { ${Array.from({ length: count }, (_v, i) => `a${i}: __typename`).join(" ")} }`;
  }

  test("a document with 50 aliases executes", async () => {
    const result = await harness.run(aliased(50), null);
    expect(errorCodes(result)).toEqual([]);
    expect(Object.keys(result.data ?? {})).toHaveLength(50);
  });

  test("a document with 51 aliases is rejected before execution", async () => {
    const result = await harness.run(aliased(51), null);
    expect(result.data ?? null).toBeNull();
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
    expect(result.errors?.[0]?.message).toContain("too many aliases");
  });
});
