import {
  createFakeDependencies,
  type FakeDependencies,
} from "@mailcal/application/test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  memberViewer,
} from "@mailcal/application/test-support/viewer-fixtures";
import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import { createDomainId } from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");
const ADMIN = adminViewer();

const FIELDS = `
  id
  localPart
  address
  displayName
  status
  createdByUserId
  domain { id name }
`;

const CREATE = `
  mutation Create($input: CreateMailAddressInput!) {
    createMailAddress(input: $input) { ${FIELDS} }
  }
`;

const LIST = `
  query List($domainId: ID) {
    mailAddresses(domainId: $domainId) { ${FIELDS} }
  }
`;

describe("mail address graphql surface", () => {
  let fake: FakeDependencies;
  let harness: GraphQLHarness;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    harness = createGraphQLHarness(fake);
    await fake.deps.mailDomainRepository.save(
      verifyMailDomain(
        createMailDomain({
          id: domainId,
          name: createDomainName("example.com"),
          catchAll: false,
          verificationToken: "tok",
          createdAt: NOW,
        }),
        NOW,
      ),
    );
  });

  async function create(
    localPart: string,
    displayName: string | null = null,
  ): Promise<Record<string, unknown>> {
    const result = await harness.run(CREATE, ADMIN, {
      input: { domainId, localPart, displayName },
    });
    expect(result.errors).toBeUndefined();
    return result.data?.["createMailAddress"] as Record<string, unknown>;
  }

  test("creates a mailbox and resolves its domain", async () => {
    const created = await create("support", "Support desk");
    expect(created).toMatchObject({
      localPart: "support",
      address: "support@example.com",
      displayName: "Support desk",
      status: "ACTIVE",
      domain: { id: domainId, name: "example.com" },
    });
  });

  test("lists per domain and across all domains", async () => {
    await create("support");
    await create("billing");
    const scoped = await harness.run(LIST, ADMIN, { domainId });
    expect(scoped.data?.["mailAddresses"]).toHaveLength(2);
    const all = await harness.run(LIST, ADMIN, {});
    expect(all.data?.["mailAddresses"]).toHaveLength(2);
  });

  test("rejects a malformed local part with BAD_USER_INPUT", async () => {
    const result = await harness.run(CREATE, ADMIN, {
      input: { domainId, localPart: "not valid" },
    });
    expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"]);
  });

  test("rejects a duplicate with CONFLICT", async () => {
    await create("support");
    const result = await harness.run(CREATE, ADMIN, {
      input: { domainId, localPart: "SUPPORT" },
    });
    expect(errorCodes(result)).toEqual(["CONFLICT"]);
  });

  test("renames the label without changing the address", async () => {
    const created = await create("support");
    const result = await harness.run(
      `mutation R($id: ID!, $displayName: String) {
         renameMailAddress(id: $id, displayName: $displayName) { ${FIELDS} }
       }`,
      ADMIN,
      { id: created["id"], displayName: "Help desk" },
    );
    expect(result.data?.["renameMailAddress"]).toMatchObject({
      displayName: "Help desk",
      address: "support@example.com",
    });
  });

  test("disables and re-enables", async () => {
    const created = await create("support");
    const setStatus = (status: string) =>
      harness.run(
        `mutation S($id: ID!, $status: MailAddressStatus!) {
           setMailAddressStatus(id: $id, status: $status) { status }
         }`,
        ADMIN,
        { id: created["id"], status },
      );
    expect(
      (await setStatus("DISABLED")).data?.["setMailAddressStatus"],
    ).toEqual({ status: "DISABLED" });
    expect((await setStatus("ACTIVE")).data?.["setMailAddressStatus"]).toEqual({
      status: "ACTIVE",
    });
  });

  test("deletes an unused mailbox", async () => {
    const created = await create("support");
    const result = await harness.run(
      `mutation D($id: ID!) { deleteMailAddress(id: $id) }`,
      ADMIN,
      { id: created["id"] },
    );
    expect(result.data?.["deleteMailAddress"]).toBe(true);
  });

  test("requires DOMAIN_ADMIN", async () => {
    const refused = await harness.run(CREATE, memberViewer(), {
      input: { domainId, localPart: "support" },
    });
    expect(errorCodes(refused)).toEqual(["FORBIDDEN"]);

    const mailOnly = apiKeyViewer([
      { capability: Capability.MailManage, domainId },
    ]);
    expect(errorCodes(await harness.run(LIST, mailOnly, {}))).toEqual([
      "FORBIDDEN",
    ]);

    const domainAdmin = apiKeyViewer([
      { capability: Capability.DomainAdmin, domainId: null },
    ]);
    expect((await harness.run(LIST, domainAdmin, {})).errors).toBeUndefined();
  });

  test("an unauthenticated caller is refused", async () => {
    expect(errorCodes(await harness.run(LIST, null, {}))).toEqual([
      "UNAUTHENTICATED",
    ]);
  });
});
