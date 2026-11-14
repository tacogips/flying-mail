import type {
  CaldavAccount,
  CaldavCalendarLink,
  CaldavDeletion,
  CaldavEventState,
} from "@mailcal/domain/entities/caldav-account";
import type {
  CalendarEventId,
  CalendarId,
  CaldavAccountId,
  CaldavCalendarId,
  UserId,
} from "@mailcal/domain/value-objects/ids";

export interface CaldavAccountRepository {
  findAccountById(id: CaldavAccountId): Promise<CaldavAccount | null>;
  listAccountsByUser(userId: UserId): Promise<readonly CaldavAccount[]>;
  saveAccount(account: CaldavAccount): Promise<void>;
  deleteAccount(id: CaldavAccountId): Promise<void>;

  findCalendarLinkById(
    id: CaldavCalendarId,
  ): Promise<CaldavCalendarLink | null>;
  findCalendarLinkByCalendar(
    calendarId: CalendarId,
  ): Promise<CaldavCalendarLink | null>;
  listCalendarLinksByAccount(
    accountId: CaldavAccountId,
  ): Promise<readonly CaldavCalendarLink[]>;
  saveCalendarLink(link: CaldavCalendarLink): Promise<void>;
  deleteCalendarLink(id: CaldavCalendarId): Promise<void>;

  findEventState(eventId: CalendarEventId): Promise<CaldavEventState | null>;
  findEventStateByHref(
    caldavCalendarId: CaldavCalendarId,
    href: string,
  ): Promise<CaldavEventState | null>;
  listEventStates(
    caldavCalendarId: CaldavCalendarId,
  ): Promise<readonly CaldavEventState[]>;
  saveEventState(state: CaldavEventState): Promise<void>;
  deleteEventState(eventId: CalendarEventId): Promise<void>;

  addDeletion(deletion: CaldavDeletion): Promise<void>;
  listDeletions(
    caldavCalendarId: CaldavCalendarId,
  ): Promise<readonly CaldavDeletion[]>;
  removeDeletion(
    caldavCalendarId: CaldavCalendarId,
    href: string,
  ): Promise<void>;
}

/** Credentials for one CalDAV conversation. The plaintext password lives
 * only in this argument, for the duration of a single use-case call. */
export interface CaldavCredentials {
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

/** A remote collection plus the credentials needed to reach it. */
export interface RemoteCalendarRef {
  readonly credentials: CaldavCredentials;
  readonly remoteUrl: string;
}

export interface CaldavDiscoveredCalendar {
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
}

export interface CaldavDiscovery {
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly calendars: readonly CaldavDiscoveredCalendar[];
}

export interface CaldavObject {
  readonly href: string;
  readonly etag: string | null;
  readonly ics: string;
}

export interface CaldavChangeSet {
  /** Hrefs whose content changed (or is new) since `syncToken`. */
  readonly changedHrefs: readonly string[];
  readonly deletedHrefs: readonly string[];
  readonly syncToken: string | null;
  readonly ctag: string | null;
  /** True when the server could not honor the token and a full listing was
   * used instead -- the caller must then treat absent hrefs as deletions. */
  readonly fullResync: boolean;
}

export type CaldavPutOutcome = "CREATED" | "UPDATED" | "CONFLICT";

export interface CaldavPutResult {
  readonly outcome: CaldavPutOutcome;
  readonly etag: string | null;
}

export type CaldavDeleteOutcome = "DELETED" | "CONFLICT" | "ALREADY_ABSENT";

export interface CaldavDeleteResult {
  readonly outcome: CaldavDeleteOutcome;
}

/** Raised by the adapter for transport-level problems, so the use case can
 * map them onto application errors without knowing about HTTP. */
export class CaldavAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaldavAuthError";
  }
}

export class CaldavTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CaldavTransportError";
  }
}

/** mailcal is a CalDAV *client* only. Nothing here serves CalDAV to anyone
 * else -- see the design doc's out-of-scope list. */
export interface CaldavClient {
  discover(credentials: CaldavCredentials): Promise<CaldavDiscovery>;
  listChanges(
    calendar: RemoteCalendarRef,
    syncToken: string | null,
  ): Promise<CaldavChangeSet>;
  multigetEvents(
    calendar: RemoteCalendarRef,
    hrefs: readonly string[],
  ): Promise<readonly CaldavObject[]>;
  putEvent(
    calendar: RemoteCalendarRef,
    href: string,
    ics: string,
    etag: string | null,
  ): Promise<CaldavPutResult>;
  deleteEvent(
    calendar: RemoteCalendarRef,
    href: string,
    etag: string | null,
  ): Promise<CaldavDeleteResult>;
}
