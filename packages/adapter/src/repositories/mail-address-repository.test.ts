import type { SqlDatabase } from "@mailcal/application/ports/sql-database";
import {
  createMailAddress,
  MailAddressStatus,
  renameMailAddress,
  setMailAddressStatus,
} from "@mailcal/domain/entities/mail-address";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  createDomainId,
  createMailAddressId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import { createMailAddressRepository } from "./mail-address-repository";
import { createMigratedDatabase, seedDomain } from "./test-support";

const TS = "2026-08-23T00:00:00.000Z";
const LATER = "2026-08-24T00:00:00.000Z";
const domainId = createDomainId("dom-1");

function mint(localPart: string, displayName: string | null = null) {
  return createMailAddress({
    id: createMailAddressId(`addr-${localPart}`),
    domainId,
    domainName: createDomainName("example.com"),
    localPart,
    displayName,
    createdByUserId: null,
    createdAt: TS,
  });
}

describe("mail address repository", () => {
  let db: SqlDatabase;
  let repository: ReturnType<typeof createMailAddressRepository>;

  beforeEach(async () => {
    db = await createMigratedDatabase();
    await seedDomain(db, { id: domainId, name: "example.com" });
    repository = createMailAddressRepository(db);
  });

  test("round-trips an address", async () => {
    const stored = mint("support", "Support desk");
    await repository.save(stored);
    expect(await repository.findById(stored.id)).toEqual(stored);
  });

  test("finds by full address, which is the ingest lookup", async () => {
    await repository.save(mint("support"));
    expect(
      await repository.findByAddress("support@example.com"),
    ).not.toBeNull();
    expect(await repository.findByAddress("nobody@example.com")).toBeNull();
  });

  test("normalizes case and whitespace on lookup", async () => {
    await repository.save(mint("support"));
    expect(
      await repository.findByAddress("  SUPPORT@EXAMPLE.COM  "),
    ).not.toBeNull();
  });

  test("refuses a duplicate address", async () => {
    await repository.save(mint("support"));
    const clash = {
      ...mint("support"),
      id: createMailAddressId("addr-other"),
    };
    await expect(repository.save(clash)).rejects.toThrow();
  });

  test("refuses a duplicate local part within a domain", async () => {
    await seedDomain(db, { id: "dom-2", name: "other.test" });
    await repository.save(mint("support"));
    // Same local part on a different domain is a different mailbox.
    const onOtherDomain = createMailAddress({
      id: createMailAddressId("addr-other"),
      domainId: createDomainId("dom-2"),
      domainName: createDomainName("other.test"),
      localPart: "support",
      createdByUserId: null,
      createdAt: TS,
    });
    await expect(repository.save(onOtherDomain)).resolves.toBeUndefined();
  });

  test("updates the label and status but never the address", async () => {
    const stored = mint("support");
    await repository.save(stored);
    await repository.save(renameMailAddress(stored, "Help desk", LATER));
    await repository.save(
      setMailAddressStatus(stored, MailAddressStatus.Disabled, LATER),
    );
    const loaded = await repository.findById(stored.id);
    expect(loaded?.status).toBe(MailAddressStatus.Disabled);
    expect(loaded?.address).toBe("support@example.com");
    expect(loaded?.localPart).toBe("support");
  });

  test("lists by domain, ordered by local part", async () => {
    await repository.save(mint("zulu"));
    await repository.save(mint("alpha"));
    expect(
      (await repository.listByDomain(domainId)).map((a) => a.localPart),
    ).toEqual(["alpha", "zulu"]);
    expect(await repository.list()).toHaveLength(2);
  });

  test("counts nothing for a fresh address", async () => {
    const stored = mint("support");
    await repository.save(stored);
    expect(await repository.countMessages(stored.id)).toBe(0);
  });

  test("deletes, and cascades when the domain goes", async () => {
    const stored = mint("support");
    await repository.save(stored);
    await repository.delete(stored.id);
    expect(await repository.findById(stored.id)).toBeNull();

    await repository.save(mint("again"));
    await db.execute("DELETE FROM domains WHERE id = ?", [domainId]);
    expect(await repository.list()).toEqual([]);
  });

  test("rejects a status outside the enum", async () => {
    await expect(
      db.execute(
        `INSERT INTO mail_addresses
           (id, domain_id, local_part, address, status, created_at, updated_at)
         VALUES ('bad', ?, 'x', 'x@example.com', 'PAUSED', ?, ?)`,
        [domainId, TS, TS],
      ),
    ).rejects.toThrow();
  });
});
