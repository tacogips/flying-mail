import { ValidationError } from "../errors";
import type {
  AddressBookId,
  CarddavAccountId,
  CarddavBookId,
  ContactId,
  UserId,
} from "../value-objects/ids";

/** A user's connection to a remote CardDAV server (in practice iCloud).
 * The entity holds **ciphertext only**; the app-specific password exists in
 * plaintext solely inside the connect/sync use cases, for the duration of
 * one request -- see `CredentialCipher`. CarddavAccount belongs to a
 * *user*, unlike `AddressBook`/`Contact` which belong to a mail address:
 * it holds that user's iCloud credential, not a mailbox's. */
export interface CarddavAccount {
  readonly id: CarddavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;
  readonly principalUrl: string | null;
  readonly homeSetUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One local address book bound to one remote collection. `ctag`/`syncToken`
 * are opaque server-issued values; `lastSyncedAt` is what makes a local
 * contact "dirty" (its `updatedAt` is newer) and therefore due for push. */
export interface CarddavBookLink {
  readonly id: CarddavBookId;
  readonly accountId: CarddavAccountId;
  readonly addressBookId: AddressBookId;
  readonly remoteUrl: string;
  readonly displayName: string | null;
  readonly ctag: string | null;
  readonly syncToken: string | null;
  readonly lastSyncedAt: string | null;
}

/** Per-contact sync bookkeeping: which remote resource a contact lives at
 * and what etag was last seen there. */
export interface CarddavContactState {
  readonly contactId: ContactId;
  readonly carddavBookId: CarddavBookId;
  readonly href: string;
  readonly etag: string | null;
  readonly lastSyncedAt: string;
  /** True when the remote vCard could not be *fully* modeled and part of it
   * was imported into `extraVcardLines` instead. A partially modeled vCard
   * still round-trips losslessly through `extraVcardLines` and is **not**
   * excluded from push. Only a wholly unparsable vCard is skipped and
   * reported in the sync summary. */
  readonly remoteUnsupported: boolean;
}

/** A tombstone for a synced contact deleted locally. Needed because
 * deleting the contact cascades its `carddav_contact_states` row away, and
 * the deletion still has to be pushed on the next sync. */
export interface CarddavDeletion {
  readonly carddavBookId: CarddavBookId;
  readonly href: string;
  readonly etag: string | null;
  readonly deletedAt: string;
}

export interface CreateCarddavAccountInput {
  readonly id: CarddavAccountId;
  readonly userId: UserId;
  readonly serverUrl: string;
  readonly username: string;
  readonly passwordCiphertext: string;
  readonly principalUrl?: string | null;
  readonly homeSetUrl?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/** Rejects anything but an absolute `https` URL. A plain-`http` CardDAV
 * server would carry the app-specific password in clear text on the wire;
 * `http` is allowed only for `localhost`, so integration testing against a
 * local server stays possible without weakening the real rule. */
export function normalizeCarddavServerUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(
      "CardDAV server URL must be an absolute URL",
      "serverUrl",
    );
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new ValidationError("CardDAV server URL must use https", "serverUrl");
  }
  return url.toString();
}

export function createCarddavAccount(
  input: CreateCarddavAccountInput,
): CarddavAccount {
  const username = input.username.trim();
  if (username.length === 0) {
    throw new ValidationError("CardDAV username must not be empty", "username");
  }
  if (input.passwordCiphertext.trim().length === 0) {
    throw new ValidationError(
      "CardDAV password ciphertext must not be empty",
      "passwordCiphertext",
    );
  }
  return {
    id: input.id,
    userId: input.userId,
    serverUrl: normalizeCarddavServerUrl(input.serverUrl),
    username,
    passwordCiphertext: input.passwordCiphertext,
    principalUrl: input.principalUrl ?? null,
    homeSetUrl: input.homeSetUrl ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}
