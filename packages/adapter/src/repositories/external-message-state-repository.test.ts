import type { SqlDatabase } from "@flying-mail/application/ports/sql-database";
import { createExternalMailAccount } from "@flying-mail/domain/entities/external-mail-account";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createDomainId,
  createExternalAccountId,
  createMailAddressId,
  createMessageId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createExternalMailAccountRepository } from "./external-mail-account-repository";
import { createExternalMessageStateRepository } from "./external-message-state-repository";
import {
  createMigratedDatabase,
  seedDomain,
  seedMailAddress,
} from "./test-support";

const NOW = "2026-08-24T00:00:00.000Z";
const ACCOUNT_ID = createExternalAccountId("acc-1");
const OTHER_ACCOUNT_ID = createExternalAccountId("acc-2");

let db: SqlDatabase;

beforeEach(async () => {
  db = await createMigratedDatabase();
  await seedDomain(db, { id: createDomainId("dom-1"), name: "example.com" });
  await seedMailAddress(db, {
    id: createMailAddressId("addr-1"),
    domainId: createDomainId("dom-1"),
    localPart: "support",
    address: "support@example.com",
  });
  await seedMailAddress(db, {
    id: createMailAddressId("addr-2"),
    domainId: createDomainId("dom-1"),
    localPart: "billing",
    address: "billing@example.com",
  });
  const accounts = createExternalMailAccountRepository(db);
  await accounts.save(
    createExternalMailAccount({
      id: ACCOUNT_ID,
      mailAddressId: createMailAddressId("addr-1"),
      externalAddress: createEmailAddress("taco@gmail.com"),
      fetch: {
        kind: "JMAP",
        sessionUrl: "https://api.fastmail.com/jmap/session",
        username: "taco@fastmail.com",
        passwordCiphertext: "cipher-1",
      },
      createdAt: NOW,
    }),
  );
  await accounts.save(
    createExternalMailAccount({
      id: OTHER_ACCOUNT_ID,
      mailAddressId: createMailAddressId("addr-2"),
      externalAddress: createEmailAddress("taco2@gmail.com"),
      fetch: {
        kind: "JMAP",
        sessionUrl: "https://api.fastmail.com/jmap/session",
        username: "taco2@fastmail.com",
        passwordCiphertext: "cipher-2",
      },
      createdAt: NOW,
    }),
  );
});

describe("external message state repository", () => {
  test("save, find and listRemoteIds round-trip, scoped per account", async () => {
    const repository = createExternalMessageStateRepository(db);
    await repository.save({
      accountId: ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    await repository.save({
      accountId: OTHER_ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-2"),
      fetchedAt: NOW,
    });

    expect(await repository.find(ACCOUNT_ID, "remote-1")).toEqual({
      accountId: ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    // The same remoteId string under a different account is a distinct row.
    expect(await repository.find(OTHER_ACCOUNT_ID, "remote-1")).toMatchObject({
      messageId: createMessageId("msg-2"),
    });
    expect(await repository.find(ACCOUNT_ID, "does-not-exist")).toBeNull();

    expect(await repository.listRemoteIds(ACCOUNT_ID)).toEqual(
      new Set(["remote-1"]),
    );
  });

  test("save() upserts on (accountId, remoteId)", async () => {
    const repository = createExternalMessageStateRepository(db);
    await repository.save({
      accountId: ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    await repository.save({
      accountId: ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-1-again"),
      fetchedAt: "2026-08-25T00:00:00.000Z",
    });

    const found = await repository.find(ACCOUNT_ID, "remote-1");
    expect(found?.messageId).toBe(createMessageId("msg-1-again"));
    expect(found?.fetchedAt).toBe("2026-08-25T00:00:00.000Z");
    expect((await repository.listRemoteIds(ACCOUNT_ID)).size).toBe(1);
  });

  test("buildSaveStatement builds the same statement save() executes, unexecuted", async () => {
    const repository = createExternalMessageStateRepository(db);
    const state = {
      accountId: ACCOUNT_ID,
      remoteId: "remote-built",
      messageId: createMessageId("msg-built"),
      fetchedAt: NOW,
    };
    const statement = repository.buildSaveStatement(state);
    expect(await repository.find(ACCOUNT_ID, "remote-built")).toBeNull();

    await db.execute(statement.sql, statement.params);
    expect(await repository.find(ACCOUNT_ID, "remote-built")).toEqual(state);
  });

  test("deleting the owning account cascades its message states", async () => {
    const repository = createExternalMessageStateRepository(db);
    await repository.save({
      accountId: ACCOUNT_ID,
      remoteId: "remote-1",
      messageId: createMessageId("msg-1"),
      fetchedAt: NOW,
    });
    await createExternalMailAccountRepository(db).delete(ACCOUNT_ID);
    expect(await repository.listRemoteIds(ACCOUNT_ID)).toEqual(new Set());
  });
});
