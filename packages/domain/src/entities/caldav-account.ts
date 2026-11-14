import { ValidationError } from "../errors";
import type {
  CalendarId,
  CaldavAccountId,
  CaldavCalendarId,
  UserId,
} from "../value-objects/ids";

/** A user's connection to a remote CalDAV server (in practice iCloud).
 *
 * The entity holds **ciphertext only**: the app-specific password exists in
 * plaintext solely inside the connect/sync use cases, for the duration of
 * one request. Nothing that can reach a client, a log, or D1 ever sees the
 * plaintext -- see `CredentialCipher`. */
export interface CaldavAccount {
  readonly id: CaldavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One local calendar bound to one remote collection. `ctag`/`syncToken`
 * are opaque server-issued values; `lastSyncedAt` is what makes a local
 * event "dirty" (its `updatedAt` is newer) and therefore due for push. */
export interface CaldavCalendarLink {
  readonly id: CaldavCalendarId;
  readonly accountId: CaldavAccountId;
  readonly calendarId: CalendarId;
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
}

/** Per-event sync bookkeeping: which remote resource an event lives at and
 * what etag we last saw there. */
export interface CaldavEventState {
  readonly eventId: string;
  readonly caldavCalendarId: CaldavCalendarId;
  readonly href: string;
  readonly etag: string | null;
  readonly lastSyncedAt: string;
  /** True when the remote object used an `RRULE` outside the supported
   * subset and was imported as non-recurring. Such an event is never pushed
   * back: re-serializing it would overwrite a rule mailcal cannot
   * represent, silently rewriting the series on every other client. */
  readonly remoteUnsupported: boolean;
}

/** A tombstone for a synced event deleted locally. Needed because deleting
 * the event cascades its `caldav_event_states` row away, and the deletion
 * still has to be pushed on the next sync. */
export interface CaldavDeletion {
  readonly caldavCalendarId: CaldavCalendarId;
  readonly href: string;
  readonly etag: string | null;
  readonly deletedAt: string;
}

export interface CreateCaldavAccountInput {
  readonly id: CaldavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;
  readonly principalUrl?: string | null;
  readonly homeSetUrl?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/** Rejects anything but an absolute `https(s)` URL. A plain-`http` CalDAV
 * server would carry the app-specific password in clear text on the wire;
 * `http` is allowed only for `localhost`, so integration testing against a
 * local server stays possible without weakening the real rule. */
export function normalizeCaldavServerUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(
      "CalDAV server URL must be an absolute URL",
      "serverUrl",
    );
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ValidationError("CalDAV server URL must use https", "serverUrl");
  }
  return url.toString();
}

export function createCaldavAccount(
  input: CreateCaldavAccountInput,
): CaldavAccount {
  const username = input.username.trim();
  if (username.length === 0) {
    throw new ValidationError("CalDAV username must not be empty", "username");
  }
  if (input.passwordCiphertext.trim().length === 0) {
    throw new ValidationError(
      "CalDAV password ciphertext must not be empty",
      "passwordCiphertext",
    );
  }
  return {
    id: input.id,
    userId: input.userId,
    serverUrl: normalizeCaldavServerUrl(input.serverUrl),
    username,
    passwordCiphertext: input.passwordCiphertext,
    principalUrl: input.principalUrl ?? null,
    homeSetUrl: input.homeSetUrl ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}
