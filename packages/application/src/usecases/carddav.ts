import {
  type CarddavAccount,
  type CarddavBookLink,
  createCarddavAccount,
  normalizeCarddavServerUrl,
} from "@flying-mail/domain/entities/carddav-account";
import { createAddressBook } from "@flying-mail/domain/entities/address-book";
import {
  type AddressBookId,
  type CarddavAccountId,
  type CarddavBookId,
  createAddressBookId,
  createCarddavAccountId,
  createCarddavBookId,
  type MailAddressId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import {
  BadUserInputError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import {
  requireCarddavAccountUser,
  requireContactWrite,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type {
  CarddavCredentials,
  CarddavDiscoveredAddressBook,
  CarddavDiscovery,
} from "../ports/carddav";
import { CarddavAuthError, CarddavTransportError } from "../ports/carddav";
import {
  loadWritableAddressBook,
  resolveAddressBookOwner,
} from "./contact-access";
import { translateDomainError } from "./translate-domain-error";

export interface ConnectCarddavAccountInput {
  readonly serverUrl: string;
  readonly username: string;
  /** An iCloud app-specific password. Held in memory for this call only and
   * persisted exclusively as ciphertext. */
  readonly appPassword: string;
}

export interface ConnectCarddavAccountResult {
  readonly account: CarddavAccount;
  readonly addressBooks: readonly CarddavDiscoveredAddressBook[];
}

export type LinkRemoteAddressBookMode = "IMPORT_NEW" | "BIND_EXISTING";

export interface LinkRemoteAddressBookInput {
  readonly accountId: CarddavAccountId;
  readonly remoteUrl: string;
  readonly mode: LinkRemoteAddressBookMode;
  /** Required for `BIND_EXISTING`. */
  readonly addressBookId?: AddressBookId;
  /** Required for `IMPORT_NEW`: an `AddressBook` is owned by a *mail
   * address* with no default to fall back on, so
   * `AddressBook.mailAddressId` is never optional. */
  readonly mailAddressId?: MailAddressId;
  readonly displayName?: string | null;
}

/** Turns adapter transport failures into the two application errors the
 * design specifies: a rejected credential is the caller's problem
 * (`BAD_USER_INPUT`), anything else is the server's (`SERVICE_UNAVAILABLE`).
 * Neither carries the password. */
export function translateCarddavError(error: unknown): never {
  if (error instanceof CarddavAuthError) {
    throw new BadUserInputError(
      "The CardDAV server rejected these credentials. For iCloud, use an app-specific password.",
      "appPassword",
    );
  }
  if (error instanceof CarddavTransportError) {
    throw new ServiceUnavailableError(
      `The CardDAV server could not be reached: ${error.message}`,
    );
  }
  throw translateDomainError(error);
}

/** Every CardDAV entry point starts here: without a configured
 * `FLYING_MAIL_CREDENTIAL_KEY` there is nowhere safe to put the password, so the
 * feature reports itself unavailable instead of storing plaintext. The rest
 * of contacts works untouched. */
export function requireCipher(deps: AppDependencies): void {
  if (!deps.credentialCipher.available) {
    throw new ServiceUnavailableError(
      "CardDAV is not configured on this deployment: FLYING_MAIL_CREDENTIAL_KEY is unset",
    );
  }
}

export async function loadCarddavCredentials(
  deps: AppDependencies,
  account: CarddavAccount,
): Promise<CarddavCredentials> {
  requireCipher(deps);
  return {
    serverUrl: account.serverUrl,
    username: account.username,
    password: await deps.credentialCipher.decrypt(account.passwordCiphertext),
  };
}

export function createListCarddavAccountsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly CarddavAccount[]> {
  return async (viewer) => {
    const userId = requireCarddavAccountUser(viewer);
    return deps.carddavAccountRepository.listAccountsByUser(userId);
  };
}

export function createConnectCarddavAccountUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: ConnectCarddavAccountInput,
) => Promise<ConnectCarddavAccountResult> {
  return async (viewer, input) => {
    const userId = requireCarddavAccountUser(viewer);
    requireCipher(deps);
    if (input.appPassword.trim().length === 0) {
      throw new BadUserInputError(
        "appPassword must not be empty",
        "appPassword",
      );
    }

    // Validate before putting the credential on the wire.
    let serverUrl: string;
    try {
      serverUrl = normalizeCarddavServerUrl(input.serverUrl);
    } catch (error) {
      throw translateDomainError(error);
    }

    const credentials: CarddavCredentials = {
      serverUrl,
      username: input.username.trim(),
      password: input.appPassword,
    };

    let discovery: CarddavDiscovery;
    try {
      // Discovery runs *before* anything is persisted, so a typo in the
      // password never leaves a dead account row behind.
      discovery = await deps.carddavClient.discover(credentials);
    } catch (error) {
      return translateCarddavError(error);
    }

    const now = deps.clock.now().toISOString();
    try {
      const account = createCarddavAccount({
        id: createCarddavAccountId(deps.random.uuid()),
        userId,
        serverUrl,
        username: credentials.username,
        passwordCiphertext: await deps.credentialCipher.encrypt(
          input.appPassword,
        ),
        principalUrl: discovery.principalUrl,
        homeSetUrl: discovery.homeSetUrl,
        createdAt: now,
      });
      await deps.carddavAccountRepository.saveAccount(account);
      return { account, addressBooks: discovery.addressBooks };
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

async function loadOwnedAccount(
  deps: AppDependencies,
  viewer: Viewer,
  accountId: CarddavAccountId,
): Promise<CarddavAccount> {
  const userId = requireCarddavAccountUser(viewer);
  const account =
    await deps.carddavAccountRepository.findAccountById(accountId);
  // Another user's account is reported as absent, not forbidden.
  if (account === null || account.userId !== userId) {
    throw new NotFoundError("CarddavAccount", accountId);
  }
  return account;
}

/** The collection a link points at must belong to the account it is being
 * linked through because every later sync sends the account's app-specific
 * password to this URL. */
function requireAccountCollectionUrl(
  account: CarddavAccount,
  remoteUrl: string,
): string {
  let normalized: string;
  try {
    normalized = normalizeCarddavServerUrl(remoteUrl);
  } catch {
    throw new BadUserInputError(
      "remoteUrl must be an absolute https URL",
      "remoteUrl",
    );
  }
  const expectedOrigin = new URL(account.homeSetUrl ?? account.serverUrl)
    .origin;
  if (new URL(normalized).origin !== expectedOrigin) {
    throw new BadUserInputError(
      "remoteUrl must be a collection on the connected CardDAV account",
      "remoteUrl",
    );
  }
  return normalized;
}

export function createLinkRemoteAddressBookUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: LinkRemoteAddressBookInput,
) => Promise<CarddavBookLink> {
  return async (viewer, input) => {
    const account = await loadOwnedAccount(deps, viewer, input.accountId);
    const now = deps.clock.now().toISOString();

    let addressBookId: AddressBookId;
    if (input.mode === "BIND_EXISTING") {
      if (input.addressBookId === undefined) {
        throw new BadUserInputError(
          "addressBookId is required when mode is BIND_EXISTING",
          "addressBookId",
        );
      }
      const book = await loadWritableAddressBook(
        deps,
        viewer,
        input.addressBookId,
      );
      addressBookId = book.id;
    } else {
      if (input.mailAddressId === undefined) {
        throw new BadUserInputError(
          "mailAddressId is required when mode is IMPORT_NEW",
          "mailAddressId",
        );
      }
      const owner = await resolveAddressBookOwner(deps, input.mailAddressId);
      if (owner === null) {
        throw new NotFoundError("MailAddress", input.mailAddressId);
      }
      requireContactWrite(viewer, owner);
      try {
        const book = createAddressBook({
          id: createAddressBookId(deps.random.uuid()),
          mailAddressId: input.mailAddressId,
          name: input.displayName ?? "iCloud contacts",
          createdAt: now,
        });
        await deps.addressBookRepository.save(book);
        addressBookId = book.id;
      } catch (error) {
        throw translateDomainError(error);
      }
    }

    const existing =
      await deps.carddavAccountRepository.findBookLinkByAddressBook(
        addressBookId,
      );
    if (existing !== null) {
      throw new ConflictError(
        "This address book is already linked to a CardDAV collection",
      );
    }

    const link: CarddavBookLink = {
      id: createCarddavBookId(deps.random.uuid()),
      accountId: account.id,
      addressBookId,
      remoteUrl: requireAccountCollectionUrl(account, input.remoteUrl),
      displayName: input.displayName ?? null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    };
    await deps.carddavAccountRepository.saveBookLink(link);
    return link;
  };
}

/** Unlinks one book without touching the account or any other link.
 * Ownership is checked through the account, mirroring
 * `loadOwnedAccount`'s posture: another user's link is reported absent, not
 * forbidden. */
export function createUnlinkRemoteAddressBookUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CarddavBookId) => Promise<boolean> {
  return async (viewer, id) => {
    const link = await deps.carddavAccountRepository.findBookLinkById(id);
    if (link === null) {
      return false;
    }
    await loadOwnedAccount(deps, viewer, link.accountId);
    await deps.carddavAccountRepository.deleteBookLink(id);
    return true;
  };
}

/** Deleting the account removes its links (and therefore stops syncing).
 * Local address books and contacts survive: an expired iCloud password must
 * not be able to wipe a user's contacts. */
export function createDisconnectCarddavAccountUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CarddavAccountId) => Promise<boolean> {
  return async (viewer, id) => {
    const account = await loadOwnedAccount(deps, viewer, id);
    await deps.carddavAccountRepository.deleteAccount(account.id);
    return true;
  };
}

export function createListRemoteAddressBooksUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  accountId: CarddavAccountId,
) => Promise<readonly CarddavBookLink[]> {
  return async (viewer, accountId) => {
    const account = await loadOwnedAccount(deps, viewer, accountId);
    return deps.carddavAccountRepository.listBookLinksByAccount(account.id);
  };
}
