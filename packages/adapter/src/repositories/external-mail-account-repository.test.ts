import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import {
  createExternalMailAccount,
  type ExternalMailAccount,
  replaceExternalMailAccountSmtp,
} from "@flying-mail/domain/entities/external-mail-account";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createExternalAccountId,
  createMailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createExternalMailAccountRepository } from "./external-mail-account-repository";
import {
  createMigratedDatabase,
  seedDomain,
  seedMailAddress,
} from "./test-support";

const NOW = "2026-08-24T00:00:00.000Z";
const DOMAIN_ID = createDomainId("dom-1");
const MAIL_ADDRESS_ID = createMailAddressId("addr-1");
const OTHER_MAIL_ADDRESS_ID = createMailAddressId("addr-2");

let db: SqlDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: DOMAIN_ID, name: "example.com" });
  await seedMailAddress(db, {
    id: MAIL_ADDRESS_ID,
    domainId: DOMAIN_ID,
    localPart: "support",
    address: "support@example.com",
  });
  await seedMailAddress(db, {
    id: OTHER_MAIL_ADDRESS_ID,
    domainId: DOMAIN_ID,
    localPart: "billing",
    address: "billing@example.com",
  });
});

function jmapAccount(
  id: string,
  mailAddressId = MAIL_ADDRESS_ID,
): ExternalMailAccount {
  return createExternalMailAccount({
    id: createExternalAccountId(id),
    mailAddressId,
    externalAddress: createEmailAddress("taco@gmail.com"),
    fetch: {
      kind: "JMAP",
      sessionUrl: "https://api.fastmail.com/jmap/session",
      username: "taco@fastmail.com",
      passwordCiphertext: "cipher-fetch-1",
    },
    createdAt: NOW,
  });
}

function pop3Account(
  id: string,
  mailAddressId = MAIL_ADDRESS_ID,
): ExternalMailAccount {
  return createExternalMailAccount({
    id: createExternalAccountId(id),
    mailAddressId,
    externalAddress: createEmailAddress("taco@example.net"),
    fetch: {
      kind: "POP3",
      host: "pop.example.net",
      port: 995,
      username: "taco",
      passwordCiphertext: "cipher-fetch-2",
    },
    smtp: {
      host: "smtp.example.net",
      port: 587,
      security: "STARTTLS",
      username: "taco",
      passwordCiphertext: "cipher-smtp-1",
    },
    createdAt: NOW,
  });
}

describe("external mail account repository", () => {
  test("round-trips a JMAP account with no smtp config", async () => {
    const repository = createExternalMailAccountRepository(db);
    const account = jmapAccount("acc-1");
    await repository.save(account);

    expect(await repository.findById(account.id)).toEqual(account);
    expect(await repository.findByMailAddress(MAIL_ADDRESS_ID)).toEqual(
      account,
    );
    expect((await repository.list()).map((a) => a.id)).toEqual([account.id]);
  });

  test("round-trips a POP3 account with an smtp config", async () => {
    const repository = createExternalMailAccountRepository(db);
    const account = pop3Account("acc-2");
    await repository.save(account);

    const found = await repository.findById(account.id);
    expect(found).toEqual(account);
    expect(found?.smtp?.passwordCiphertext).toBe("cipher-smtp-1");
  });

  test("ciphertext columns round-trip byte-for-byte", async () => {
    const repository = createExternalMailAccountRepository(db);
    const account = pop3Account("acc-3");
    await repository.save(account);
    const found = await repository.findById(account.id);
    expect(found?.fetch.passwordCiphertext).toBe("cipher-fetch-2");
    expect(found?.smtp?.passwordCiphertext).toBe("cipher-smtp-1");
  });

  test("save() upserts: clearing smtp and switching fetch kind both persist", async () => {
    const repository = createExternalMailAccountRepository(db);
    const account = pop3Account("acc-4");
    await repository.save(account);

    const cleared = replaceExternalMailAccountSmtp(
      account,
      null,
      "2026-08-25T00:00:00.000Z",
    );
    await repository.save(cleared);
    expect((await repository.findById(account.id))?.smtp).toBeNull();

    const switchedToJmap = jmapAccount("acc-4");
    await repository.save(switchedToJmap);
    const found = await repository.findById(account.id);
    expect(found?.fetch.kind).toBe("JMAP");
  });

  test("delete removes the account", async () => {
    const repository = createExternalMailAccountRepository(db);
    const account = jmapAccount("acc-5");
    await repository.save(account);
    await repository.delete(account.id);
    expect(await repository.findById(account.id)).toBeNull();
  });

  test("a mail address can have at most one external account", async () => {
    const repository = createExternalMailAccountRepository(db);
    await repository.save(jmapAccount("acc-6"));
    await expect(repository.save(pop3Account("acc-7"))).rejects.toThrow();
  });

  test("findByMailAddress and list are scoped correctly across addresses", async () => {
    const repository = createExternalMailAccountRepository(db);
    const first = jmapAccount("acc-8", MAIL_ADDRESS_ID);
    const second = pop3Account("acc-9", OTHER_MAIL_ADDRESS_ID);
    await repository.save(first);
    await repository.save(second);

    expect(await repository.findByMailAddress(OTHER_MAIL_ADDRESS_ID)).toEqual(
      second,
    );
    expect((await repository.list()).map((a) => a.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});
