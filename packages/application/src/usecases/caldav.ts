import {
  type CaldavAccount,
  type CaldavCalendarLink,
  createCaldavAccount,
  normalizeCaldavServerUrl,
} from "@mailcal/domain/entities/caldav-account";
import { createCalendar } from "@mailcal/domain/entities/calendar";
import {
  type CalendarId,
  type CaldavAccountId,
  createCaldavAccountId,
  createCaldavCalendarId,
  createCalendarId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import {
  BadUserInputError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors";
import { requireCaldavAccountUser } from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import type {
  CaldavCredentials,
  CaldavDiscoveredCalendar,
  CaldavDiscovery,
} from "../ports/caldav";
import { CaldavAuthError, CaldavTransportError } from "../ports/caldav";
import { loadWritableCalendar } from "./calendar-access";
import { translateDomainError } from "./translate-domain-error";

export interface ConnectCaldavAccountInput {
  readonly serverUrl: string;
  readonly username: string;
  /** An iCloud app-specific password. Held in memory for this call only and
   * persisted exclusively as ciphertext. */
  readonly appPassword: string;
}

export interface ConnectCaldavAccountResult {
  readonly account: CaldavAccount;
  readonly calendars: readonly CaldavDiscoveredCalendar[];
}

export type LinkCaldavCalendarMode = "IMPORT_NEW" | "BIND_EXISTING";

export interface LinkCaldavCalendarInput {
  readonly accountId: CaldavAccountId;
  readonly remoteUrl: string;
  readonly mode: LinkCaldavCalendarMode;
  /** Required for `BIND_EXISTING`. */
  readonly calendarId?: CalendarId;
  readonly displayName?: string | null;
}

/** Turns adapter transport failures into the two application errors the
 * design specifies: a rejected credential is the caller's problem
 * (`BAD_USER_INPUT`), anything else is the server's (`SERVICE_UNAVAILABLE`).
 * Neither carries the password. */
export function translateCaldavError(error: unknown): never {
  if (error instanceof CaldavAuthError) {
    throw new BadUserInputError(
      "The CalDAV server rejected these credentials. For iCloud, use an app-specific password.",
      "appPassword",
    );
  }
  if (error instanceof CaldavTransportError) {
    throw new ServiceUnavailableError(
      `The CalDAV server could not be reached: ${error.message}`,
    );
  }
  throw translateDomainError(error);
}

/** Every CalDAV entry point starts here: without a configured
 * `MAILCAL_CREDENTIAL_KEY` there is nowhere safe to put the password, so the
 * feature reports itself unavailable instead of storing plaintext. The rest
 * of the calendar works untouched. */
export function requireCipher(deps: AppDependencies): void {
  if (!deps.credentialCipher.available) {
    throw new ServiceUnavailableError(
      "CalDAV is not configured on this deployment: MAILCAL_CREDENTIAL_KEY is unset",
    );
  }
}

export async function loadCredentials(
  deps: AppDependencies,
  account: CaldavAccount,
): Promise<CaldavCredentials> {
  requireCipher(deps);
  return {
    serverUrl: account.serverUrl,
    username: account.username,
    password: await deps.credentialCipher.decrypt(account.passwordCiphertext),
  };
}

export function createListCaldavAccountsUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<readonly CaldavAccount[]> {
  return async (viewer) => {
    const userId = requireCaldavAccountUser(viewer);
    return deps.caldavAccountRepository.listAccountsByUser(userId);
  };
}

export function createConnectCaldavAccountUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: ConnectCaldavAccountInput,
) => Promise<ConnectCaldavAccountResult> {
  return async (viewer, input) => {
    const userId = requireCaldavAccountUser(viewer);
    requireCipher(deps);
    if (input.appPassword.trim().length === 0) {
      throw new BadUserInputError(
        "appPassword must not be empty",
        "appPassword",
      );
    }

    // Validated *before* the credential is put on the wire. The https rule
    // lives in `normalizeCaldavServerUrl`, and reaching it only inside
    // `createCaldavAccount` -- after discovery -- would mean a plain-http or
    // hostile URL had already received the app-specific password in a Basic
    // auth header. Validation that runs after transmission protects nothing.
    let serverUrl: string;
    try {
      serverUrl = normalizeCaldavServerUrl(input.serverUrl);
    } catch (error) {
      throw translateDomainError(error);
    }

    const credentials: CaldavCredentials = {
      serverUrl,
      username: input.username.trim(),
      password: input.appPassword,
    };

    let discovery: CaldavDiscovery;
    try {
      // Discovery runs *before* anything is persisted, so a typo in the
      // password never leaves a dead account row behind.
      discovery = await deps.caldavClient.discover(credentials);
    } catch (error) {
      return translateCaldavError(error);
    }

    const now = deps.clock.now().toISOString();
    try {
      const account = createCaldavAccount({
        id: createCaldavAccountId(deps.random.uuid()),
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
      await deps.caldavAccountRepository.saveAccount(account);
      return { account, calendars: discovery.calendars };
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

async function loadOwnedAccount(
  deps: AppDependencies,
  viewer: Viewer,
  accountId: CaldavAccountId,
): Promise<CaldavAccount> {
  const userId = requireCaldavAccountUser(viewer);
  const account = await deps.caldavAccountRepository.findAccountById(accountId);
  // Another user's account is reported as absent, not forbidden.
  if (account === null || account.userId !== userId) {
    throw new NotFoundError("CaldavAccount", accountId);
  }
  return account;
}

/** The collection a link points at must belong to the account it is being
 * linked through.
 *
 * Every later sync sends the account's app-specific password to this URL, so
 * an unvalidated `remoteUrl` would turn `linkCaldavCalendar` into a way to
 * aim a stored credential at an arbitrary host. Constrained to the origin of
 * the account's discovered home set (or its server URL when discovery
 * returned none), which is where its collections actually live. */
function requireAccountCollectionUrl(
  account: CaldavAccount,
  remoteUrl: string,
): string {
  let normalized: string;
  try {
    normalized = normalizeCaldavServerUrl(remoteUrl);
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
      "remoteUrl must be a collection on the connected CalDAV account",
      "remoteUrl",
    );
  }
  return normalized;
}

export function createLinkCaldavCalendarUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: LinkCaldavCalendarInput,
) => Promise<CaldavCalendarLink> {
  return async (viewer, input) => {
    const account = await loadOwnedAccount(deps, viewer, input.accountId);
    const now = deps.clock.now().toISOString();

    let calendarId: CalendarId;
    if (input.mode === "BIND_EXISTING") {
      if (input.calendarId === undefined) {
        throw new BadUserInputError(
          "calendarId is required when mode is BIND_EXISTING",
          "calendarId",
        );
      }
      const calendar = await loadWritableCalendar(
        deps,
        viewer,
        input.calendarId,
      );
      calendarId = calendar.id;
    } else {
      try {
        const calendar = createCalendar({
          id: createCalendarId(deps.random.uuid()),
          ownerUserId: account.userId,
          name: input.displayName ?? "iCloud calendar",
          createdAt: now,
        });
        await deps.calendarRepository.save(calendar);
        calendarId = calendar.id;
      } catch (error) {
        throw translateDomainError(error);
      }
    }

    const existing =
      await deps.caldavAccountRepository.findCalendarLinkByCalendar(calendarId);
    if (existing !== null) {
      throw new ConflictError(
        "This calendar is already linked to a CalDAV collection",
      );
    }

    const link: CaldavCalendarLink = {
      id: createCaldavCalendarId(deps.random.uuid()),
      accountId: account.id,
      calendarId,
      remoteUrl: requireAccountCollectionUrl(account, input.remoteUrl),
      displayName: input.displayName ?? null,
      ctag: null,
      syncToken: null,
      lastSyncedAt: null,
    };
    await deps.caldavAccountRepository.saveCalendarLink(link);
    return link;
  };
}

/** Deleting the account removes its links (and therefore stops syncing).
 * Local calendars and events survive: an expired iCloud password must not
 * be able to wipe a user's calendar. */
export function createDeleteCaldavAccountUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CaldavAccountId) => Promise<boolean> {
  return async (viewer, id) => {
    const account = await loadOwnedAccount(deps, viewer, id);
    await deps.caldavAccountRepository.deleteAccount(account.id);
    return true;
  };
}

export function createListCaldavCalendarsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  accountId: CaldavAccountId,
) => Promise<readonly CaldavCalendarLink[]> {
  return async (viewer, accountId) => {
    const account = await loadOwnedAccount(deps, viewer, accountId);
    return deps.caldavAccountRepository.listCalendarLinksByAccount(account.id);
  };
}
