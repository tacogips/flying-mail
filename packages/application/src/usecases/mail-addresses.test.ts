import { Capability } from "@mailcal/domain/entities/api-key";
import {
  createMailDomain,
  verifyMailDomain,
} from "@mailcal/domain/entities/mail-domain";
import { MailAddressStatus } from "@mailcal/domain/entities/mail-address";
import { createDomainName } from "@mailcal/domain/value-objects/domain-name";
import {
  createDomainId,
  createMailAddressId,
} from "@mailcal/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
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
import { createUseCases, type UseCases } from "../usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

describe("mail address provisioning", () => {
  let fake: FakeDependencies;
  let usecases: UseCases;

  beforeEach(async () => {
    fake = createFakeDependencies({ now: NOW });
    usecases = createUseCases(fake.deps);
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

  const admin = adminViewer();

  test("creates an address and derives its full form", async () => {
    const address = await usecases.createMailAddress(admin, {
      domainId,
      localPart: "Support",
      displayName: "Support desk",
    });
    expect(address).toMatchObject({
      localPart: "support",
      address: "support@example.com",
      displayName: "Support desk",
      status: MailAddressStatus.Active,
    });
  });

  test("lists addresses for a domain and across all domains", async () => {
    await usecases.createMailAddress(admin, { domainId, localPart: "b" });
    await usecases.createMailAddress(admin, { domainId, localPart: "a" });
    expect(
      (await usecases.listMailAddresses(admin, domainId)).map(
        (entry) => entry.localPart,
      ),
    ).toEqual(["a", "b"]);
    expect(await usecases.listMailAddresses(admin, null)).toHaveLength(2);
  });

  test("rejects a duplicate, case-insensitively", async () => {
    await usecases.createMailAddress(admin, { domainId, localPart: "support" });
    await expect(
      usecases.createMailAddress(admin, { domainId, localPart: "SUPPORT" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects a malformed local part as BAD_USER_INPUT", async () => {
    await expect(
      usecases.createMailAddress(admin, { domainId, localPart: "not valid" }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("reports an unknown domain", async () => {
    await expect(
      usecases.createMailAddress(admin, {
        domainId: createDomainId("nope"),
        localPart: "support",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("renames the label without touching the address", async () => {
    const created = await usecases.createMailAddress(admin, {
      domainId,
      localPart: "support",
    });
    const renamed = await usecases.renameMailAddress(
      admin,
      created.id,
      "Help desk",
    );
    expect(renamed.displayName).toBe("Help desk");
    expect(renamed.address).toBe("support@example.com");
  });

  test("disables and re-enables", async () => {
    const created = await usecases.createMailAddress(admin, {
      domainId,
      localPart: "support",
    });
    const disabled = await usecases.setMailAddressStatus(
      admin,
      created.id,
      MailAddressStatus.Disabled,
    );
    expect(disabled.status).toBe(MailAddressStatus.Disabled);
    const reEnabled = await usecases.setMailAddressStatus(
      admin,
      created.id,
      MailAddressStatus.Active,
    );
    expect(reEnabled.status).toBe(MailAddressStatus.Active);
  });

  test("deletes an unused address and reports a missing one", async () => {
    const created = await usecases.createMailAddress(admin, {
      domainId,
      localPart: "support",
    });
    await expect(usecases.deleteMailAddress(admin, created.id)).resolves.toBe(
      true,
    );
    await expect(
      usecases.deleteMailAddress(admin, createMailAddressId("gone")),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  describe("authorization", () => {
    test("requires DOMAIN_ADMIN, which a member does not hold", async () => {
      await expect(
        usecases.createMailAddress(memberViewer(), {
          domainId,
          localPart: "support",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        usecases.listMailAddresses(memberViewer(), domainId),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a key needs DOMAIN_ADMIN; MAIL_MANAGE is not enough", async () => {
      const manageOnly = apiKeyViewer([
        { capability: Capability.MailManage, domainId },
      ]);
      await expect(
        usecases.createMailAddress(manageOnly, {
          domainId,
          localPart: "support",
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      const domainAdmin = apiKeyViewer([
        { capability: Capability.DomainAdmin, domainId: null },
      ]);
      await expect(
        usecases.createMailAddress(domainAdmin, {
          domainId,
          localPart: "support",
        }),
      ).resolves.toMatchObject({ address: "support@example.com" });
    });

    test("records the creating user, and null for a key", async () => {
      const byUser = await usecases.createMailAddress(admin, {
        domainId,
        localPart: "a",
      });
      expect(byUser.createdByUserId).not.toBeNull();

      const byKey = await usecases.createMailAddress(
        apiKeyViewer([{ capability: Capability.DomainAdmin, domainId: null }]),
        { domainId, localPart: "b" },
      );
      expect(byKey.createdByUserId).toBeNull();
    });
  });
});
