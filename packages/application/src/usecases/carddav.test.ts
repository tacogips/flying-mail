import { Capability } from "@flying-mail/domain/entities/api-key";
import { createCarddavBookId } from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import { CarddavAuthError, CarddavTransportError } from "../ports/carddav";
import {
  type ContactFixture,
  contactKeyViewer,
  NOW,
  seedContactFixture,
} from "../test-support/contact-fixtures";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, memberViewer } from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

const HOME_SET_URL = "https://p1-carddavws.icloud.com/1/carddavhome/";

let fake: FakeDependencies;
let usecases: UseCases;
let fixture: ContactFixture;

async function setup(
  options: Parameters<typeof createFakeDependencies>[0] = {},
): Promise<void> {
  fake = createFakeDependencies({ now: NOW, ...options });
  usecases = createUseCases(fake.deps);
  fixture = await seedContactFixture(fake);
}

beforeEach(async () => {
  await setup({
    carddav: {
      discovery: {
        principalUrl: "https://p1-carddavws.icloud.com/1/principal/",
        homeSetUrl: HOME_SET_URL,
        addressBooks: [
          {
            remoteUrl: `${HOME_SET_URL}card/`,
            displayName: "iCloud",
            ctag: "ctag-1",
            syncToken: "token-1",
          },
        ],
      },
    },
  });
});

describe("connectCarddavAccount", () => {
  test("an API key cannot connect an account: it must not exfiltrate a credential", async () => {
    const key = contactKeyViewer([Capability.ContactWrite]);
    await expect(
      usecases.connectCarddavAccount(key, {
        serverUrl: "https://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "app-specific-pw",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("without a configured credential key, connecting fails SERVICE_UNAVAILABLE", async () => {
    await setup({ credentialCipherAvailable: false });
    await expect(
      usecases.connectCarddavAccount(adminViewer(), {
        serverUrl: "https://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "app-specific-pw",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("rejects a plain-http server URL before ever touching the wire", async () => {
    await expect(
      usecases.connectCarddavAccount(adminViewer(), {
        serverUrl: "http://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "app-specific-pw",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("rejects an empty app password", async () => {
    await expect(
      usecases.connectCarddavAccount(adminViewer(), {
        serverUrl: "https://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "   ",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("a rejected credential surfaces as BAD_USER_INPUT, never SERVICE_UNAVAILABLE", async () => {
    await setup({
      carddav: {
        onDiscover: () => {
          throw new CarddavAuthError("401");
        },
      },
    });
    await expect(
      usecases.connectCarddavAccount(adminViewer(), {
        serverUrl: "https://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "wrong",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("a transport failure surfaces as SERVICE_UNAVAILABLE", async () => {
    await setup({
      carddav: {
        onDiscover: () => {
          throw new CarddavTransportError("timeout");
        },
      },
    });
    await expect(
      usecases.connectCarddavAccount(adminViewer(), {
        serverUrl: "https://contacts.icloud.com",
        username: "ada@icloud.com",
        appPassword: "app-specific-pw",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("connects, persists ciphertext (never plaintext), and returns discovered books", async () => {
    const result = await usecases.connectCarddavAccount(adminViewer(), {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    expect(result.account.passwordCiphertext).not.toBe("app-specific-pw");
    expect(result.account.homeSetUrl).toBe(HOME_SET_URL);
    expect(result.addressBooks).toHaveLength(1);

    const accounts = await usecases.listCarddavAccounts(adminViewer());
    expect(accounts.map((account) => account.id)).toEqual([result.account.id]);
  });
});

describe("linkRemoteAddressBook", () => {
  test("BIND_EXISTING requires contact write on the target book", async () => {
    const { account } = await usecases.connectCarddavAccount(adminViewer(), {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    const bystander = memberViewer("usr-1", []);
    await expect(
      usecases.linkRemoteAddressBook(bystander, {
        accountId: account.id,
        remoteUrl: `${HOME_SET_URL}card/`,
        mode: "BIND_EXISTING",
        addressBookId: fixture.addressBookId,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("BIND_EXISTING links the existing book and rejects a second link to it", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    const link = await usecases.linkRemoteAddressBook(admin, {
      accountId: account.id,
      remoteUrl: `${HOME_SET_URL}card/`,
      mode: "BIND_EXISTING",
      addressBookId: fixture.addressBookId,
    });
    expect(link.addressBookId).toBe(fixture.addressBookId);

    await expect(
      usecases.linkRemoteAddressBook(admin, {
        accountId: account.id,
        remoteUrl: `${HOME_SET_URL}card/other/`,
        mode: "BIND_EXISTING",
        addressBookId: fixture.addressBookId,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("IMPORT_NEW requires mailAddressId and creates a new local book on it", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    await expect(
      usecases.linkRemoteAddressBook(admin, {
        accountId: account.id,
        remoteUrl: `${HOME_SET_URL}card/`,
        mode: "IMPORT_NEW",
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);

    const link = await usecases.linkRemoteAddressBook(admin, {
      accountId: account.id,
      remoteUrl: `${HOME_SET_URL}card/`,
      mode: "IMPORT_NEW",
      mailAddressId: fixture.billingMailAddressId,
      displayName: "iCloud",
    });
    const books = await usecases.listAddressBooks(
      admin,
      fixture.billingMailAddressId,
    );
    expect(books.map((book) => book.id)).toContain(link.addressBookId);
  });

  test("rejects a remoteUrl outside the connected account's origin", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    await expect(
      usecases.linkRemoteAddressBook(admin, {
        accountId: account.id,
        remoteUrl: "https://evil.example.com/card/",
        mode: "BIND_EXISTING",
        addressBookId: fixture.addressBookId,
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });
});

describe("unlinkRemoteAddressBook / disconnectCarddavAccount", () => {
  test("unlinking removes only the link; the local book and contacts survive", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    const link = await usecases.linkRemoteAddressBook(admin, {
      accountId: account.id,
      remoteUrl: `${HOME_SET_URL}card/`,
      mode: "BIND_EXISTING",
      addressBookId: fixture.addressBookId,
    });
    const contact = await usecases.createContact(admin, {
      addressBookId: fixture.addressBookId,
      displayName: "Ada Lovelace",
    });

    expect(await usecases.unlinkRemoteAddressBook(admin, link.id)).toBe(true);
    expect(
      await fake.deps.carddavAccountRepository.findBookLinkById(link.id),
    ).toBeNull();
    expect(await usecases.getContact(admin, contact.id)).not.toBeNull();
  });

  test("an unknown link unlinks as false, not an error", async () => {
    const admin = adminViewer();
    expect(
      await usecases.unlinkRemoteAddressBook(
        admin,
        createCarddavBookId("cdl-missing"),
      ),
    ).toBe(false);
  });

  test("disconnecting removes the account and its links; local data survives", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    const link = await usecases.linkRemoteAddressBook(admin, {
      accountId: account.id,
      remoteUrl: `${HOME_SET_URL}card/`,
      mode: "BIND_EXISTING",
      addressBookId: fixture.addressBookId,
    });

    expect(await usecases.disconnectCarddavAccount(admin, account.id)).toBe(
      true,
    );
    expect(
      await fake.deps.carddavAccountRepository.findBookLinkById(link.id),
    ).toBeNull();
    expect(
      await usecases.listAddressBooks(admin, fixture.supportMailAddressId),
    ).toHaveLength(1);
  });

  test("another user's account is reported absent, not forbidden", async () => {
    const admin = adminViewer();
    const { account } = await usecases.connectCarddavAccount(admin, {
      serverUrl: "https://contacts.icloud.com",
      username: "ada@icloud.com",
      appPassword: "app-specific-pw",
    });
    const other = adminViewer("usr-other");
    await expect(
      usecases.disconnectCarddavAccount(other, account.id),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
