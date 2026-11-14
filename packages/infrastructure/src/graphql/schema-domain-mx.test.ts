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
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

const NOW = "2026-10-07T00:00:00.000Z";
const DOMAIN_ID = createDomainId("mx-domain");
const DOMAIN_QUERY = "query { domains { id name inboundMx } }";

async function setupFake(
  inboundMxSuffix: string | null = "mx.cloudflare.net",
): Promise<FakeDependencies> {
  const fake = createFakeDependencies({
    now: NOW,
    instanceConfig: { inboundMxSuffix },
  });
  await fake.deps.mailDomainRepository.save(
    createMailDomain({
      id: DOMAIN_ID,
      name: createDomainName("example.com"),
      catchAll: true,
      verificationToken: "token",
      createdAt: NOW,
    }),
  );
  return fake;
}

describe("MailDomain.inboundMx", () => {
  let fake: FakeDependencies;
  let harness: GraphQLHarness;

  beforeEach(async () => {
    fake = await setupFake();
    harness = createGraphQLHarness(fake);
  });

  test("resolves Cloudflare, non-Cloudflare, no-record and failure states", async () => {
    fake.dns.setMx("example.com", [
      { priority: 10, exchange: "route1.mx.cloudflare.net" },
    ]);
    expect((await harness.run(DOMAIN_QUERY, adminViewer())).data).toEqual({
      domains: [{ id: DOMAIN_ID, name: "example.com", inboundMx: "READY" }],
    });

    fake.dns.setMx("example.com", [
      { priority: 10, exchange: "aspmx.l.google.com" },
    ]);
    expect((await harness.run(DOMAIN_QUERY, adminViewer())).data).toEqual({
      domains: [
        {
          id: DOMAIN_ID,
          name: "example.com",
          inboundMx: "NOT_CLOUDFLARE",
        },
      ],
    });

    fake.dns.setMx("example.com", []);
    expect((await harness.run(DOMAIN_QUERY, adminViewer())).data).toEqual({
      domains: [{ id: DOMAIN_ID, name: "example.com", inboundMx: "NONE" }],
    });

    fake.dns.failNextMxLookup(new Error("resolver down"));
    expect((await harness.run(DOMAIN_QUERY, adminViewer())).data).toEqual({
      domains: [{ id: DOMAIN_ID, name: "example.com", inboundMx: "UNKNOWN" }],
    });
  });

  test("disabled gate resolves as UNKNOWN", async () => {
    fake = await setupFake(null);
    harness = createGraphQLHarness(fake);
    expect((await harness.run(DOMAIN_QUERY, adminViewer())).data).toEqual({
      domains: [{ id: DOMAIN_ID, name: "example.com", inboundMx: "UNKNOWN" }],
    });
  });

  test("returns UNKNOWN to members while preserving domain data", async () => {
    const result = await harness.run(DOMAIN_QUERY, memberViewer());
    expect(errorCodes(result)).toEqual([]);
    expect(result.data).toEqual({
      domains: [{ id: DOMAIN_ID, name: "example.com", inboundMx: "UNKNOWN" }],
    });
  });
});
