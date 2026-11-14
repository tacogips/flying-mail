import {
  BILLING_ADDRESS,
  contactKeyViewer,
  mailOnlyKeyViewer,
  NOW,
  seedContactFixture,
  SUPPORT_ADDRESS,
  type ContactFixture,
} from "@flying-mail/application/test-support/contact-fixtures";
import { createFakeDependencies } from "@flying-mail/application/test-support/fakes";
import {
  adminViewer,
  memberViewer,
} from "@flying-mail/application/test-support/viewer-fixtures";
import { Capability } from "@flying-mail/domain/entities/api-key";
import { verifyMailDomain } from "@flying-mail/domain/entities/mail-domain";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createGraphQLHarness,
  errorCodes,
  type GraphQLHarness,
} from "./graphql-test-support";

/** End-to-end operation tests for the external-mail SDL module, mirroring
 * `schema-contacts.test.ts`'s style: real yoga requests over in-memory
 * fakes. Authorization itself (admin-only CRUD, MAIL_READ-gated fetch) is
 * already exhaustively covered at the use-case layer in
 * `external-accounts.test.ts`/`external-fetch.test.ts`; this file's job is
 * to prove the GraphQL wiring plumbs viewer/errors through correctly and
 * that no secret ever crosses the wire. */

const ADMIN = adminViewer();
const JMAP_PASSWORD = "app-password-jmap";
const SMTP_PASSWORD = "app-password-smtp";

const CREATE_ACCOUNT = `
  mutation Create($input: CreateExternalMailAccountInput!) {
    createExternalMailAccount(input: $input) {
      id mailAddressId mailAddress externalAddress displayName
      fetchKind smtpConfigured status lastFetchedAt createdAt updatedAt
    }
  }
`;

const UPDATE_ACCOUNT = `
  mutation Update($id: ID!, $input: UpdateExternalMailAccountInput!) {
    updateExternalMailAccount(id: $id, input: $input) {
      id displayName fetchKind smtpConfigured status
    }
  }
`;

function jmapCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    mailAddressId: "",
    externalAddress: "me@gmail.com",
    displayName: "Gmail",
    fetch: {
      kind: "JMAP",
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "me@gmail.com",
      password: JMAP_PASSWORD,
    },
    ...overrides,
  };
}

function field<T>(
  result: { readonly data?: Record<string, unknown> | null },
  name: string,
): T {
  const value = result.data?.[name];
  if (value === undefined || value === null) {
    throw new Error(`expected ${name} in the result`);
  }
  return value as T;
}

let harness: GraphQLHarness;
let fixture: ContactFixture;

beforeEach(async () => {
  harness = createGraphQLHarness(createFakeDependencies({ now: NOW }));
  fixture = await seedContactFixture(harness.fake);
});

describe("external mail account lifecycle", () => {
  test("creates, reads, updates and deletes an account, never echoing a password", async () => {
    const created = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    expect(created.errors).toBeUndefined();
    expect(JSON.stringify(created.data)).not.toContain(JMAP_PASSWORD);
    const account = field<{
      id: string;
      mailAddress: string;
      fetchKind: string;
      smtpConfigured: boolean;
      status: string;
    }>(created, "createExternalMailAccount");
    expect(account).toMatchObject({
      mailAddress: SUPPORT_ADDRESS,
      fetchKind: "JMAP",
      smtpConfigured: false,
      status: "ACTIVE",
    });

    const listed = await harness.run(
      `query { externalMailAccounts { id mailAddress } }`,
      ADMIN,
    );
    expect(listed.data?.["externalMailAccounts"]).toEqual([
      { id: account.id, mailAddress: SUPPORT_ADDRESS },
    ]);

    // Adding SMTP for the first time, renaming, and disabling all in one
    // patch; `fetch` is omitted entirely, proving a partial update leaves
    // the existing fetch config untouched.
    const updated = await harness.run(UPDATE_ACCOUNT, ADMIN, {
      id: account.id,
      input: {
        displayName: "Gmail (personal)",
        smtp: {
          host: "smtp.fastmail.com",
          port: 587,
          security: "STARTTLS",
          username: "me@gmail.com",
          password: SMTP_PASSWORD,
        },
        status: "DISABLED",
      },
    });
    expect(updated.errors).toBeUndefined();
    expect(JSON.stringify(updated.data)).not.toContain(SMTP_PASSWORD);
    expect(
      field<{ smtpConfigured: boolean; status: string }>(
        updated,
        "updateExternalMailAccount",
      ),
    ).toMatchObject({
      displayName: "Gmail (personal)",
      fetchKind: "JMAP",
      smtpConfigured: true,
      status: "DISABLED",
    });

    // `smtp: null` clears the relay just configured above -- distinct from
    // omitting the field, which would have left it untouched.
    const cleared = await harness.run(UPDATE_ACCOUNT, ADMIN, {
      id: account.id,
      input: { smtp: null },
    });
    expect(
      field<{ smtpConfigured: boolean }>(cleared, "updateExternalMailAccount")
        .smtpConfigured,
    ).toBe(false);

    const deleted = await harness.run(
      `mutation Delete($id: ID!) { deleteExternalMailAccount(id: $id) }`,
      ADMIN,
      { id: account.id },
    );
    expect(deleted.data?.["deleteExternalMailAccount"]).toBe(true);
    const afterDelete = await harness.run(
      `query { externalMailAccounts { id } }`,
      ADMIN,
    );
    expect(afterDelete.data?.["externalMailAccounts"]).toEqual([]);
  });

  test("rejects a second account on the same mail address with CONFLICT", async () => {
    const input = jmapCreateInput({
      mailAddressId: fixture.supportMailAddressId,
    });
    const first = await harness.run(CREATE_ACCOUNT, ADMIN, { input });
    expect(first.errors).toBeUndefined();
    const second = await harness.run(CREATE_ACCOUNT, ADMIN, { input });
    expect(errorCodes(second)).toEqual(["CONFLICT"]);
  });

  test("reports SERVICE_UNAVAILABLE with no FLYING_MAIL_CREDENTIAL_KEY configured", async () => {
    harness = createGraphQLHarness(
      createFakeDependencies({ now: NOW, credentialCipherAvailable: false }),
    );
    fixture = await seedContactFixture(harness.fake);
    const result = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    expect(errorCodes(result)).toEqual(["SERVICE_UNAVAILABLE"]);
  });

  test("a non-admin is forbidden from every mutation but fetchExternalMail", async () => {
    const created = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    const accountId = field<{ id: string }>(
      created,
      "createExternalMailAccount",
    ).id;
    const member = memberViewer();

    expect(
      errorCodes(
        await harness.run(CREATE_ACCOUNT, member, {
          input: jmapCreateInput({
            mailAddressId: fixture.billingMailAddressId,
          }),
        }),
      ),
    ).toEqual(["FORBIDDEN"]);

    expect(
      errorCodes(
        await harness.run(UPDATE_ACCOUNT, member, {
          id: accountId,
          input: { displayName: "Stolen" },
        }),
      ),
    ).toEqual(["FORBIDDEN"]);

    expect(
      errorCodes(
        await harness.run(
          `mutation Delete($id: ID!) { deleteExternalMailAccount(id: $id) }`,
          member,
          { id: accountId },
        ),
      ),
    ).toEqual(["FORBIDDEN"]);

    expect(
      errorCodes(
        await harness.run(
          `mutation Test($id: ID!) {
             testExternalMailAccount(id: $id) { fetchOk }
           }`,
          member,
          { id: accountId },
        ),
      ),
    ).toEqual(["FORBIDDEN"]);

    expect(
      errorCodes(
        await harness.run(`query { externalMailAccounts { id } }`, member),
      ),
    ).toEqual(["FORBIDDEN"]);
  });
});

describe("fetchExternalMail", () => {
  test("any MAIL_READ-authorized viewer may fetch, not only an admin", async () => {
    harness = createGraphQLHarness(
      createFakeDependencies({
        now: NOW,
        jmap: {
          fetchSinceResult: {
            messages: [
              {
                remoteId: "jmap-1",
                raw: new TextEncoder().encode(
                  "From: sender@gmail.com\r\nTo: support@example.com\r\nSubject: Hi\r\n\r\nBody",
                ),
              },
            ],
            hasMore: false,
          },
        },
      }),
    );
    fixture = await seedContactFixture(harness.fake);
    // `seedContactFixture` leaves the domain unverified -- fine for
    // contacts, but `receiveMessage` rejects mail to an unverified domain
    // (`REJECT_UNKNOWN_RECIPIENT`), which this test's real ingest pass
    // needs to succeed.
    const domain = await harness.fake.deps.mailDomainRepository.findByName(
      createDomainName("example.com"),
    );
    if (domain === null) {
      throw new Error("expected seedContactFixture's domain to exist");
    }
    await harness.fake.deps.mailDomainRepository.save(
      verifyMailDomain(domain, NOW),
    );

    const created = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    const accountId = field<{ id: string }>(
      created,
      "createExternalMailAccount",
    ).id;

    const result = await harness.run(
      `mutation Fetch($id: ID!) {
         fetchExternalMail(id: $id) { fetched skipped hasMore }
       }`,
      mailOnlyKeyViewer(),
      { id: accountId },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data?.["fetchExternalMail"]).toEqual({
      fetched: 1,
      skipped: 0,
      hasMore: false,
    });
  });

  test("an account outside a scoped viewer's reach is reported absent, not forbidden", async () => {
    const created = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    const accountId = field<{ id: string }>(
      created,
      "createExternalMailAccount",
    ).id;
    // Scoped to billing@, not support@ -- MAIL_READ over an unrelated
    // address does not authorize this account.
    const key = contactKeyViewer([Capability.MailRead], BILLING_ADDRESS);

    const result = await harness.run(
      `mutation Fetch($id: ID!) { fetchExternalMail(id: $id) { fetched } }`,
      key,
      { id: accountId },
    );
    expect(errorCodes(result)).toEqual(["NOT_FOUND"]);
  });

  test("a disabled account refuses fetch with CONFLICT", async () => {
    const created = await harness.run(CREATE_ACCOUNT, ADMIN, {
      input: jmapCreateInput({ mailAddressId: fixture.supportMailAddressId }),
    });
    const accountId = field<{ id: string }>(
      created,
      "createExternalMailAccount",
    ).id;
    await harness.run(UPDATE_ACCOUNT, ADMIN, {
      id: accountId,
      input: { status: "DISABLED" },
    });

    const result = await harness.run(
      `mutation Fetch($id: ID!) { fetchExternalMail(id: $id) { fetched } }`,
      mailOnlyKeyViewer(),
      { id: accountId },
    );
    expect(errorCodes(result)).toEqual(["CONFLICT"]);
  });
});

describe("external mail schema shape", () => {
  test("exposes no plaintext-password or ciphertext output field", async () => {
    const introspection = await harness.run(
      `query {
         __schema {
           types { name fields { name } inputFields { name } }
         }
       }`,
      ADMIN,
    );
    const types = field<{
      types: readonly {
        name: string;
        fields: readonly { name: string }[] | null;
        inputFields: readonly { name: string }[] | null;
      }[];
    }>(introspection, "__schema").types;
    const externalMailTypes = types.filter((type) =>
      /^(ExternalMail|ExternalAccount|ExternalFetch|CreateExternalMailAccount|UpdateExternalMailAccount|SmtpSubmission)/.test(
        type.name,
      ),
    );
    // Sanity check that the filter actually matched the module's types.
    expect(externalMailTypes.length).toBeGreaterThan(5);
    for (const type of externalMailTypes) {
      // Object-type *output* fields must never carry a secret; input types
      // legitimately declare `password` (never `...Ciphertext`, which is
      // never surfaced at all, on either side).
      for (const outputField of type.fields ?? []) {
        expect(outputField.name.toLowerCase()).not.toMatch(
          /password|ciphertext/,
        );
      }
      for (const inputField of type.inputFields ?? []) {
        expect(inputField.name.toLowerCase()).not.toContain("ciphertext");
      }
    }
  });
});
