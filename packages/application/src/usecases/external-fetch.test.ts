import { Capability } from "@flying-mail/domain/entities/api-key";
import { ExternalAccountStatus } from "@flying-mail/domain/entities/external-mail-account";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import { createMailAddress } from "@flying-mail/domain/entities/mail-address";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import {
  createDomainId,
  createExternalAccountId,
  createMailAddressId,
  type ExternalAccountId,
  type MailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { ConflictError, NotFoundError } from "../errors";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import {
  adminViewer,
  apiKeyViewer,
  mailboxAgentViewer,
} from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";
import type { CreateExternalAccountInput } from "./external-mail-usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

let fake: FakeDependencies;
let usecases: UseCases;
let mailAddressId: MailAddressId;

function jmapInput(
  overrides: Partial<CreateExternalAccountInput> = {},
): CreateExternalAccountInput {
  return {
    mailAddressId,
    externalAddress: "me@gmail.com",
    fetch: {
      kind: "JMAP",
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "me@gmail.com",
      password: "app-password",
    },
    ...overrides,
  };
}

function pop3Input(
  overrides: Partial<CreateExternalAccountInput> = {},
): CreateExternalAccountInput {
  return jmapInput({
    fetch: {
      kind: "POP3",
      host: "pop.example.com",
      username: "me@gmail.com",
      password: "app-password",
    },
    ...overrides,
  });
}

function raw(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function setup(
  options: Parameters<typeof createFakeDependencies>[0] = {},
): Promise<void> {
  fake = createFakeDependencies({ now: NOW, ...options });
  usecases = createUseCases(fake.deps);
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
  mailAddressId = createMailAddressId("addr-1");
  await fake.deps.mailAddressRepository.save(
    createMailAddress({
      id: mailAddressId,
      domainId,
      domainName: createDomainName("example.com"),
      localPart: "gmail",
      createdByUserId: null,
      createdAt: NOW,
    }),
  );
}

beforeEach(async () => {
  await setup();
});

describe("fetchExternalMail (JMAP)", () => {
  test("ingests fetched messages and joins the ledger row into the same insert batch", async () => {
    await setup({
      jmap: {
        fetchSinceResult: {
          messages: [
            {
              remoteId: "jmap-1",
              raw: raw(
                "From: sender@gmail.com\r\nTo: me@gmail.com\r\nSubject: Hi\r\nMessage-ID: <m1@gmail.com>\r\n\r\nBody",
              ),
            },
          ],
          hasMore: false,
        },
      },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );

    const summary = await usecases.fetchExternalMail(adminViewer(), account.id);
    expect(summary).toEqual({ fetched: 1, skipped: 0, hasMore: false });

    // The insertWithRelations call that stored the message also carried the
    // ledger's SqlStatement -- not a separate write that followed it.
    expect(fake.messageStores.insertCalls).toHaveLength(1);
    const call = fake.messageStores.insertCalls[0];
    expect(call?.extraStatements).toHaveLength(1);

    const known = await fake.deps.externalMessageStateRepository.listRemoteIds(
      account.id,
    );
    expect(known.has("jmap-1")).toBe(true);
    const state = await fake.deps.externalMessageStateRepository.find(
      account.id,
      "jmap-1",
    );
    expect(state?.messageId).toBe(call?.message.id);
  });

  test("a remote id already in the ledger is never re-ingested", async () => {
    await setup({
      jmap: {
        fetchSinceResult: {
          messages: [{ remoteId: "jmap-1", raw: raw("x") }],
          hasMore: false,
        },
      },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    await usecases.fetchExternalMail(adminViewer(), account.id);
    expect(fake.messageStores.insertCalls).toHaveLength(1);

    // Second run offers the same remote id again (as a real JMAP query
    // would until state advances); the orchestration's own dedupe check
    // must still refuse to re-ingest it.
    const summary = await usecases.fetchExternalMail(adminViewer(), account.id);
    expect(summary).toEqual({ fetched: 0, skipped: 1, hasMore: false });
    expect(fake.messageStores.insertCalls).toHaveLength(1);
  });

  test("caps at max and reports hasMore from the client", async () => {
    await setup({
      jmap: {
        fetchSinceResult: {
          messages: [{ remoteId: "jmap-1", raw: raw("x") }],
          hasMore: true,
        },
      },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const summary = await usecases.fetchExternalMail(
      adminViewer(),
      account.id,
      {
        max: 1,
      },
    );
    expect(summary.hasMore).toBe(true);
    expect(fake.jmapClient.fetchSinceCalls[0]?.max).toBe(1);
  });

  test("a DUPLICATE result records the ledger row directly, not via extraStatements", async () => {
    await setup({
      jmap: {
        fetchSinceResult: {
          // Two distinct remote ids whose raw bytes parse to the *same*
          // rfcMessageId (the fake parser returns one canned result
          // regardless of input): the first ingest STOREs it, the second
          // hits `receiveMessage`'s own dedupe and comes back DUPLICATE.
          messages: [
            { remoteId: "jmap-1", raw: raw("first") },
            { remoteId: "jmap-2", raw: raw("second") },
          ],
          hasMore: false,
        },
      },
    });
    fake.mimeParser.setResult({ messageId: "dup@gmail.com" });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );

    const summary = await usecases.fetchExternalMail(adminViewer(), account.id);
    expect(summary).toEqual({ fetched: 2, skipped: 0, hasMore: false });
    // Only one message row was ever inserted -- the second remote id's
    // DUPLICATE result never called insertWithRelations at all.
    expect(fake.messageStores.insertCalls).toHaveLength(1);
    const storedMessageId = fake.messageStores.insertCalls[0]?.message.id;

    const firstState = await fake.deps.externalMessageStateRepository.find(
      account.id,
      "jmap-1",
    );
    const secondState = await fake.deps.externalMessageStateRepository.find(
      account.id,
      "jmap-2",
    );
    expect(firstState?.messageId).toBe(storedMessageId);
    // The DUPLICATE branch records the ledger row against the message that
    // actually exists, via a direct `save()` rather than a batched
    // statement -- and it is the *same* underlying message as the first.
    expect(secondState?.messageId).toBe(storedMessageId);
  });

  test("DISABLED account refuses with CONFLICT", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    await usecases.updateExternalAccount(adminViewer(), account.id, {
      status: ExternalAccountStatus.Disabled,
    });
    await expect(
      usecases.fetchExternalMail(adminViewer(), account.id),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("an unauthorized viewer sees NOT_FOUND, not FORBIDDEN", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const elsewhere = apiKeyViewer([
      {
        capability: Capability.MailRead,
        domainId: createDomainId("dom-other"),
        addressPattern: "*",
      },
    ]);
    await expect(
      usecases.fetchExternalMail(elsewhere, account.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a scoped key with MAIL_READ on the bound address may fetch", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const scoped = mailboxAgentViewer(domainId, "gmail@example.com");
    const summary = await usecases.fetchExternalMail(scoped, account.id);
    expect(summary).toEqual({ fetched: 0, skipped: 0, hasMore: false });
  });

  test("rejects an unknown account id", async () => {
    await expect(
      usecases.fetchExternalMail(
        adminViewer(),
        createExternalAccountId("ext-missing") as ExternalAccountId,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("fetchExternalMail (POP3)", () => {
  test("diffs UIDLs against the ledger, fetches only new ones, and caps with hasMore", async () => {
    await setup({
      pop3: {
        uidls: ["u1", "u2", "u3"],
        messagesByUidl: new Map([
          ["u1", raw("From: a@gmail.com\r\nSubject: 1\r\n\r\nBody 1")],
          ["u2", raw("From: a@gmail.com\r\nSubject: 2\r\n\r\nBody 2")],
        ]),
      },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      pop3Input(),
    );

    const summary = await usecases.fetchExternalMail(
      adminViewer(),
      account.id,
      { max: 2 },
    );
    expect(summary).toEqual({ fetched: 2, skipped: 0, hasMore: true });
    expect(fake.pop3Client.fetchByUidlCalls[0]).toEqual(["u1", "u2"]);

    const known = await fake.deps.externalMessageStateRepository.listRemoteIds(
      account.id,
    );
    expect(known.has("u1")).toBe(true);
    expect(known.has("u2")).toBe(true);
    expect(known.has("u3")).toBe(false);
  });

  test("a UIDL already in the ledger is skipped on the next run", async () => {
    await setup({
      pop3: {
        uidls: ["u1"],
        messagesByUidl: new Map([
          ["u1", raw("From: a@gmail.com\r\nSubject: 1\r\n\r\nBody 1")],
        ]),
      },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      pop3Input(),
    );
    await usecases.fetchExternalMail(adminViewer(), account.id);

    const summary = await usecases.fetchExternalMail(adminViewer(), account.id);
    expect(summary).toEqual({ fetched: 0, skipped: 0, hasMore: false });
    expect(fake.pop3Client.fetchByUidlCalls.at(-1)).toEqual([]);
  });
});
