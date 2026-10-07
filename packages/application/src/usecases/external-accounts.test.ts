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
  type MailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import { ExternalMailAuthError } from "../ports/external-mail";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, memberViewer } from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";
import type { CreateExternalAccountInput } from "./external-mail-usecases";

const NOW = "2026-08-23T00:00:00.000Z";
const domainId = createDomainId("dom-1");

let fake: FakeDependencies;
let usecases: UseCases;
let mailAddressId: MailAddressId;

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

beforeEach(async () => {
  await setup();
});

describe("createExternalAccount", () => {
  test("a non-admin is forbidden", async () => {
    await expect(
      usecases.createExternalAccount(memberViewer(), jmapInput()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("without a configured credential key, fails SERVICE_UNAVAILABLE", async () => {
    await setup({ credentialCipherAvailable: false });
    await expect(
      usecases.createExternalAccount(adminViewer(), jmapInput()),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("rejects an unknown mailAddressId", async () => {
    await expect(
      usecases.createExternalAccount(
        adminViewer(),
        jmapInput({ mailAddressId: createMailAddressId("addr-missing") }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("persists ciphertext, never plaintext", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    expect(account.fetch.kind).toBe("JMAP");
    if (account.fetch.kind === "JMAP") {
      expect(account.fetch.passwordCiphertext).not.toBe("app-password");
    }
    const listed = await usecases.listExternalAccounts(adminViewer());
    expect(listed.map((entry) => entry.id)).toEqual([account.id]);
  });

  test("rejects a second account on the same mail address", async () => {
    await usecases.createExternalAccount(adminViewer(), jmapInput());
    await expect(
      usecases.createExternalAccount(adminViewer(), jmapInput()),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("a POP3 account defaults to port 995 and enciphers its password", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput({
        fetch: {
          kind: "POP3",
          host: "pop.mail.example.com",
          username: "me@gmail.com",
          password: "app-password",
        },
      }),
    );
    expect(account.fetch.kind).toBe("POP3");
    if (account.fetch.kind === "POP3") {
      expect(account.fetch.port).toBe(995);
      expect(account.fetch.passwordCiphertext).not.toBe("app-password");
    }
  });

  test("rejects a POP3 host on the plaintext port", async () => {
    await expect(
      usecases.createExternalAccount(
        adminViewer(),
        jmapInput({
          fetch: {
            kind: "POP3",
            host: "pop.mail.example.com",
            port: 110,
            username: "me@gmail.com",
            password: "app-password",
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("persists an SMTP relay config alongside fetch", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput({
        smtp: {
          host: "smtp.fastmail.com",
          port: 587,
          security: "STARTTLS",
          username: "me@gmail.com",
          password: "smtp-password",
        },
      }),
    );
    expect(account.smtp?.passwordCiphertext).not.toBe("smtp-password");
  });
});

describe("updateExternalAccount", () => {
  test("an omitted password keeps the stored ciphertext byte-for-byte", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const originalCiphertext =
      account.fetch.kind === "JMAP" ? account.fetch.passwordCiphertext : "";

    const updated = await usecases.updateExternalAccount(
      adminViewer(),
      account.id,
      {
        fetch: {
          kind: "JMAP",
          sessionUrl: "https://api.fastmail.com/jmap/session2",
        },
      },
    );
    expect(updated.fetch.kind).toBe("JMAP");
    if (updated.fetch.kind === "JMAP") {
      expect(updated.fetch.sessionUrl).toBe(
        "https://api.fastmail.com/jmap/session2",
      );
      expect(updated.fetch.passwordCiphertext).toBe(originalCiphertext);
    }
  });

  test("a supplied password re-enciphers", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const originalCiphertext =
      account.fetch.kind === "JMAP" ? account.fetch.passwordCiphertext : "";

    const updated = await usecases.updateExternalAccount(
      adminViewer(),
      account.id,
      { fetch: { kind: "JMAP", password: "rotated-password" } },
    );
    expect(updated.fetch.kind).toBe("JMAP");
    if (updated.fetch.kind === "JMAP") {
      expect(updated.fetch.passwordCiphertext).not.toBe(originalCiphertext);
      expect(updated.fetch.passwordCiphertext).not.toBe("rotated-password");
    }
  });

  test("smtp: null clears a previously configured relay", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput({
        smtp: {
          host: "smtp.fastmail.com",
          port: 587,
          security: "STARTTLS",
          username: "me@gmail.com",
          password: "smtp-password",
        },
      }),
    );
    expect(account.smtp).not.toBeNull();
    const updated = await usecases.updateExternalAccount(
      adminViewer(),
      account.id,
      { smtp: null },
    );
    expect(updated.smtp).toBeNull();
  });

  test("configuring SMTP for the first time requires a password", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    await expect(
      usecases.updateExternalAccount(adminViewer(), account.id, {
        smtp: {
          host: "smtp.fastmail.com",
          port: 587,
          security: "STARTTLS",
          username: "me@gmail.com",
        },
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("status flips the account to DISABLED", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const updated = await usecases.updateExternalAccount(
      adminViewer(),
      account.id,
      { status: ExternalAccountStatus.Disabled },
    );
    expect(updated.status).toBe(ExternalAccountStatus.Disabled);
  });

  test("rejects an unknown account", async () => {
    await expect(
      usecases.updateExternalAccount(
        adminViewer(),
        createExternalAccountId("ext-missing"),
        { displayName: "x" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteExternalAccount", () => {
  test("deletes the account and it drops out of the list", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    expect(
      await usecases.deleteExternalAccount(adminViewer(), account.id),
    ).toBe(true);
    expect(await usecases.listExternalAccounts(adminViewer())).toEqual([]);
  });

  test("a non-admin is forbidden", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    await expect(
      usecases.deleteExternalAccount(memberViewer(), account.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("testExternalAccount", () => {
  test("reports fetchOk and a null smtpOk when SMTP is unconfigured", async () => {
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const result = await usecases.testExternalAccount(
      adminViewer(),
      account.id,
    );
    expect(result.fetchOk).toBe(true);
    expect(result.fetchError).toBeNull();
    expect(result.smtpOk).toBeNull();
    expect(result.smtpError).toBeNull();
  });

  test("surfaces a rejected fetch credential without throwing", async () => {
    await setup({
      jmap: { testConnectionError: new ExternalMailAuthError("401") },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput(),
    );
    const result = await usecases.testExternalAccount(
      adminViewer(),
      account.id,
    );
    expect(result.fetchOk).toBe(false);
    expect(result.fetchError).toBe("401");
  });

  test("tests the SMTP leg independently when configured", async () => {
    await setup({
      smtp: { testConnectionError: new Error("smtp unreachable") },
    });
    const account = await usecases.createExternalAccount(
      adminViewer(),
      jmapInput({
        smtp: {
          host: "smtp.fastmail.com",
          port: 587,
          security: "STARTTLS",
          username: "me@gmail.com",
          password: "smtp-password",
        },
      }),
    );
    const result = await usecases.testExternalAccount(
      adminViewer(),
      account.id,
    );
    expect(result.fetchOk).toBe(true);
    expect(result.smtpOk).toBe(false);
    expect(result.smtpError).toBe("smtp unreachable");
  });
});
