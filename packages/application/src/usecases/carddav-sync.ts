import type {
  CarddavBookLink,
  CarddavContactState,
} from "@flying-mail/domain/entities/carddav-account";
import {
  type Contact,
  createContact,
} from "@flying-mail/domain/entities/contact";
import {
  type AddressBookId,
  type CarddavBookId,
  createContactId,
} from "@flying-mail/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import type {
  CarddavCredentials,
  RemoteAddressBookRef,
} from "../ports/carddav";
import type { ParsedVcardContact } from "../ports/vcard-codec";
import {
  loadCarddavCredentials,
  requireCipher,
  translateCarddavError,
} from "./carddav";
import { loadWritableAddressBook } from "./contact-access";

/** On-demand, request-scoped CardDAV sync.
 *
 * A vCard is always one contact and one href, so there is no resource
 * grouping step. A partially modeled
 * vCard (`extraVcardLines` non-null but `unparsable: false`) still imports
 * **and is still pushed** -- only a wholly `unparsable` vCard is excluded
 * from both directions and counted in `skipped`. Conflicts deterministically
 * resolve as **remote wins**. */

export interface SyncCarddavBookResult {
  readonly pulled: number;
  readonly pushed: number;
  readonly deleted: number;
  /** Wholly unparsable vCards only -- see the module doc. */
  readonly skipped: number;
  readonly conflictsResolvedRemoteWins: number;
  /** True when the change set exceeded {@link MAX_OBJECTS_PER_SYNC}; run
   * sync again to continue. */
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export const MAX_OBJECTS_PER_SYNC = 500;

interface SyncContext {
  readonly deps: AppDependencies;
  readonly link: CarddavBookLink;
  readonly addressBookId: AddressBookId;
  readonly ref: RemoteAddressBookRef;
  readonly now: string;
  readonly warnings: string[];
}

function toRef(
  credentials: CarddavCredentials,
  link: CarddavBookLink,
): RemoteAddressBookRef {
  return { credentials, remoteUrl: link.remoteUrl };
}

function hrefForContact(contact: Contact, link: CarddavBookLink): string {
  const base = link.remoteUrl.endsWith("/")
    ? link.remoteUrl
    : `${link.remoteUrl}/`;
  // The UID is the resource name, mirroring `hrefForEvent`'s reasoning.
  return `${base}${encodeURIComponent(contact.uid)}.vcf`;
}

function toContactFromParsed(
  context: SyncContext,
  parsed: ParsedVcardContact,
  existing: Contact | null,
): Contact {
  return createContact({
    id: existing?.id ?? createContactId(context.deps.random.uuid()),
    addressBookId: context.addressBookId,
    uid: parsed.uid,
    displayName: parsed.displayName,
    givenName: parsed.givenName,
    familyName: parsed.familyName,
    nickname: parsed.nickname,
    organization: parsed.organization,
    title: parsed.title,
    emails: parsed.emails.map((email) => ({
      address: email.address,
      label: email.label,
    })),
    phones: parsed.phones.map((phone) => ({
      number: phone.number,
      label: phone.label,
    })),
    postalAddresses: parsed.postalAddresses.map((address) => ({
      formatted: address.formatted,
      label: address.label,
    })),
    urls: parsed.urls,
    note: parsed.note,
    birthday: parsed.birthday,
    extraVcardLines: parsed.extraVcardLines,
    // `createdAt` is preserved on update so a re-pull does not keep
    // resetting it; `updatedAt` is set to the sync instant, which together
    // with the contact state's `lastSyncedAt` is what makes the contact
    // clean.
    createdAt: existing?.createdAt ?? context.now,
    updatedAt: context.now,
  });
}

async function upsertParsed(
  context: SyncContext,
  parsed: ParsedVcardContact,
  href: string,
  etag: string | null,
): Promise<"created" | "updated"> {
  const { deps } = context;
  const existing = await deps.contactRepository.findByUid(
    context.addressBookId,
    parsed.uid,
  );
  const contact = toContactFromParsed(context, parsed, existing);

  if (existing === null) {
    await deps.contactRepository.createContact(contact);
  } else {
    await deps.contactRepository.updateContact(contact);
  }
  await deps.carddavAccountRepository.saveContactState({
    contactId: contact.id,
    carddavBookId: context.link.id,
    href,
    etag,
    lastSyncedAt: context.now,
    // Carried for observability only. This never excludes the contact from
    // push because `extraVcardLines` round-trips losslessly.
    remoteUnsupported: contact.extraVcardLines !== null,
  });
  return existing === null ? "created" : "updated";
}

/** Hrefs we have local state for that the remote listing did not mention. */
async function absentHrefs(
  context: SyncContext,
  presentHrefs: readonly string[],
): Promise<readonly string[]> {
  const present = new Set(presentHrefs);
  const states = await context.deps.carddavAccountRepository.listContactStates(
    context.link.id,
  );
  return states
    .filter((state) => !present.has(state.href))
    .map((state) => state.href);
}

interface PullResult {
  readonly pulled: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly truncated: boolean;
  readonly syncToken: string | null;
  readonly ctag: string | null;
}

async function pull(context: SyncContext): Promise<PullResult> {
  const { deps } = context;
  const changes = await deps.carddavClient.listChanges(
    context.ref,
    context.link.syncToken,
  );

  const changed = changes.changedHrefs.slice(0, MAX_OBJECTS_PER_SYNC);
  const truncated = changes.changedHrefs.length > changed.length;

  let pulled = 0;
  let skipped = 0;
  if (changed.length > 0) {
    const objects = await deps.carddavClient.multigetContacts(
      context.ref,
      changed,
    );
    for (const object of objects) {
      const parsed = deps.vcardCodec.parseVcard(object.vcard);
      if (parsed === null || parsed.unparsable) {
        skipped += 1;
        context.warnings.push(`Skipped an unparsable vCard at ${object.href}`);
        continue;
      }
      await upsertParsed(context, parsed, object.href, object.etag);
      pulled += 1;
    }
  }

  let deleted = 0;
  // A full resync lists every remote member instead of a change delta, so
  // anything we hold that is absent from the listing was deleted remotely.
  // Skipped when the listing was truncated: the missing hrefs are then
  // merely the ones this request did not get to.
  const remoteDeletions =
    changes.fullResync && !truncated
      ? await absentHrefs(context, changes.changedHrefs)
      : [];
  for (const href of [...changes.deletedHrefs, ...remoteDeletions]) {
    const state = await deps.carddavAccountRepository.findContactStateByHref(
      context.link.id,
      href,
    );
    if (state === null) {
      continue;
    }
    await deps.contactRepository.deleteContact(state.contactId);
    await deps.carddavAccountRepository.deleteContactState(state.contactId);
    deleted += 1;
  }

  return {
    pulled,
    deleted,
    skipped,
    truncated,
    syncToken: changes.syncToken,
    ctag: changes.ctag,
  };
}

function isDirty(
  contact: Contact,
  state: CarddavContactState | null,
  link: CarddavBookLink,
): boolean {
  if (state === null) {
    // Never synced: created locally since the link was made.
    return link.lastSyncedAt === null || contact.updatedAt > link.lastSyncedAt;
  }
  return contact.updatedAt > state.lastSyncedAt;
}

async function push(
  context: SyncContext,
): Promise<{ pushed: number; conflicts: number }> {
  const { deps } = context;
  const contacts = await deps.contactRepository.listByAddressBook(
    context.addressBookId,
  );
  let pushed = 0;
  let conflicts = 0;

  for (const contact of contacts) {
    const state = await deps.carddavAccountRepository.findContactState(
      contact.id,
    );
    if (!isDirty(contact, state, context.link)) {
      continue;
    }
    const href = state?.href ?? hrefForContact(contact, context.link);
    const vcard = deps.vcardCodec.formatVcard(contact);
    const result = await deps.carddavClient.putContact(
      context.ref,
      href,
      vcard,
      state?.etag ?? null,
    );
    if (result.outcome === "CONFLICT") {
      conflicts += 1;
      await resolveRemoteWins(context, href);
      continue;
    }
    await deps.carddavAccountRepository.saveContactState({
      contactId: contact.id,
      carddavBookId: context.link.id,
      href,
      etag: result.etag,
      lastSyncedAt: context.now,
      remoteUnsupported: contact.extraVcardLines !== null,
    });
    pushed += 1;
  }
  return { pushed, conflicts };
}

/** Re-fetches one resource and lets the remote version replace the local
 * one. Used for both a 412 on push and a 412 on a tombstone delete. */
async function resolveRemoteWins(
  context: SyncContext,
  href: string,
): Promise<void> {
  const objects = await context.deps.carddavClient.multigetContacts(
    context.ref,
    [href],
  );
  for (const object of objects) {
    const parsed = context.deps.vcardCodec.parseVcard(object.vcard);
    if (parsed === null || parsed.unparsable) {
      context.warnings.push(
        `Skipped an unparsable vCard at ${object.href} while resolving a conflict`,
      );
      continue;
    }
    await upsertParsed(context, parsed, object.href, object.etag);
  }
}

async function pushDeletions(
  context: SyncContext,
): Promise<{ deleted: number; conflicts: number }> {
  const { deps } = context;
  const tombstones = await deps.carddavAccountRepository.listDeletions(
    context.link.id,
  );
  let deleted = 0;
  let conflicts = 0;
  for (const tombstone of tombstones) {
    const result = await deps.carddavClient.deleteContact(
      context.ref,
      tombstone.href,
      tombstone.etag,
    );
    if (result.outcome === "CONFLICT") {
      // The remote changed after we deleted locally. Remote wins, so the
      // contact comes back rather than the remote losing an edit.
      conflicts += 1;
      await resolveRemoteWins(context, tombstone.href);
      await deps.carddavAccountRepository.removeDeletion(
        context.link.id,
        tombstone.href,
      );
      continue;
    }
    await deps.carddavAccountRepository.removeDeletion(
      context.link.id,
      tombstone.href,
    );
    deleted += 1;
  }
  return { deleted, conflicts };
}

export function createSyncCarddavBookUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  carddavBookId: CarddavBookId,
) => Promise<SyncCarddavBookResult> {
  return async (viewer, carddavBookId) => {
    const link =
      await deps.carddavAccountRepository.findBookLinkById(carddavBookId);
    if (link === null) {
      throw new NotFoundError("CarddavBookLink", carddavBookId);
    }
    // Sync writes local contacts, so it requires contact write
    // authorization on the linked book -- a read-scoped key cannot use it
    // to mutate a book.
    await loadWritableAddressBook(deps, viewer, link.addressBookId);
    requireCipher(deps);

    const account = await deps.carddavAccountRepository.findAccountById(
      link.accountId,
    );
    if (account === null) {
      throw new NotFoundError("CarddavAccount", link.accountId);
    }

    const credentials = await loadCarddavCredentials(deps, account);
    const context: SyncContext = {
      deps,
      link,
      addressBookId: link.addressBookId,
      ref: toRef(credentials, link),
      now: deps.clock.now().toISOString(),
      warnings: [],
    };

    try {
      const pulledResult = await pull(context);
      const pushedResult = await push(context);
      const deletionResult = await pushDeletions(context);

      await deps.carddavAccountRepository.saveBookLink({
        ...link,
        ctag: pulledResult.ctag,
        syncToken: pulledResult.syncToken,
        lastSyncedAt: context.now,
      });

      return {
        pulled: pulledResult.pulled,
        pushed: pushedResult.pushed,
        deleted: pulledResult.deleted + deletionResult.deleted,
        skipped: pulledResult.skipped,
        conflictsResolvedRemoteWins:
          pushedResult.conflicts + deletionResult.conflicts,
        truncated: pulledResult.truncated,
        warnings: context.warnings,
      };
    } catch (error) {
      return translateCarddavError(error);
    }
  };
}
