import type { Attachment } from "@mailcal/domain/entities/attachment";
import type {
  CaldavAccount,
  CaldavCalendarLink,
  CaldavDeletion,
  CaldavEventState,
} from "@mailcal/domain/entities/caldav-account";
import type { Calendar } from "@mailcal/domain/entities/calendar";
import type { UserCalendarPermission } from "@mailcal/domain/entities/user-calendar-permission";
import {
  type CalendarEvent,
  eventTimeBoundsUtc,
  type OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import type {
  AttachmentId,
  CalendarEventId,
  CalendarId,
  CaldavAccountId,
  CaldavCalendarId,
} from "@mailcal/domain/value-objects/ids";
import type {
  CaldavAccountRepository,
  CaldavChangeSet,
  CaldavClient,
  CaldavDeleteResult,
  CaldavDiscovery,
  CaldavObject,
  CaldavPutResult,
  RemoteCalendarRef,
} from "../ports/caldav";
import type {
  CalendarEventRepository,
  UtcRange,
} from "../ports/calendar-event-repository";
import type { CalendarRepository } from "../ports/calendar-repository";
import type { CredentialCipher } from "../ports/credential-cipher";
import type { UserCalendarPermissionRepository } from "../ports/user-calendar-permission-repository";
import type { IcsCodec } from "../ports/ics-codec";

/** In-memory calendar stores, exposed so tests can seed and assert directly
 * instead of driving every setup through a use case. */
export interface FakeCalendarStores {
  readonly calendars: Map<string, Calendar>;
  readonly events: Map<string, CalendarEvent>;
  readonly eventAttachments: Map<string, Attachment[]>;
  /** Shared with the message stores by `createFakeDependencies`, so an
   * attachment staged through `messageRepository` is the same object an
   * event can claim -- exactly as the two tables share `attachments` in
   * D1. */
  readonly attachmentsById: Map<string, Attachment>;
  readonly caldavAccounts: Map<string, CaldavAccount>;
  readonly caldavCalendars: Map<string, CaldavCalendarLink>;
  readonly caldavEventStates: Map<string, CaldavEventState>;
  readonly caldavDeletions: Map<string, CaldavDeletion>;
}

export function createFakeCalendarStores(
  attachmentsById: Map<string, Attachment> = new Map(),
): FakeCalendarStores {
  return {
    calendars: new Map(),
    events: new Map(),
    eventAttachments: new Map(),
    attachmentsById,
    caldavAccounts: new Map(),
    caldavCalendars: new Map(),
    caldavEventStates: new Map(),
    caldavDeletions: new Map(),
  };
}

export function fakeCalendarRepository(
  stores: FakeCalendarStores,
): CalendarRepository {
  return {
    async findById(id) {
      return stores.calendars.get(id) ?? null;
    },
    async findByIds(ids) {
      return ids
        .map((id) => stores.calendars.get(id))
        .filter((calendar): calendar is Calendar => calendar !== undefined);
    },
    async listByOwner(ownerUserId) {
      return [...stores.calendars.values()]
        .filter((calendar) => calendar.ownerUserId === ownerUserId)
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    async listAll() {
      return [...stores.calendars.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    },
    async save(calendar) {
      stores.calendars.set(calendar.id, calendar);
    },
    async delete(id) {
      stores.calendars.delete(id);
      for (const [eventId, event] of stores.events) {
        if (event.calendarId === id) {
          stores.events.delete(eventId);
          stores.eventAttachments.delete(eventId);
        }
      }
    },
  };
}

function instanceKey(start: OccurrenceStart | null): string {
  return start === null ? "" : String(start);
}

/** Mirrors the SQL candidate query: a non-recurring event overlapping the
 * range, or a recurring master whose window does. Keeping the fake honest
 * about this matters -- a use-case test would otherwise pass on candidates
 * the real repository never returns. */
function overlapsRange(event: CalendarEvent, range: UtcRange): boolean {
  const bounds = eventTimeBoundsUtc(event.time);
  if (event.recurrence === null) {
    return bounds.startUtc < range.endUtc && bounds.endUtc > range.startUtc;
  }
  const until = event.recurrence.untilUtc ?? Number.POSITIVE_INFINITY;
  return bounds.startUtc < range.endUtc && until > range.startUtc;
}

export function fakeCalendarEventRepository(
  stores: FakeCalendarStores,
): CalendarEventRepository {
  const listAll = (): readonly CalendarEvent[] => [...stores.events.values()];
  return {
    async findById(id) {
      return stores.events.get(id) ?? null;
    },
    async findByUid(calendarId, uid, recurrenceInstanceStart) {
      return (
        listAll().find(
          (event) =>
            event.calendarId === calendarId &&
            event.uid === uid &&
            instanceKey(event.overrideOf?.recurrenceInstanceStart ?? null) ===
              instanceKey(recurrenceInstanceStart),
        ) ?? null
      );
    },
    async createEvent(event) {
      stores.events.set(event.id, event);
    },
    async updateEvent(event) {
      stores.events.set(event.id, event);
    },
    async deleteEvent(id) {
      stores.events.delete(id);
      stores.eventAttachments.delete(id);
      stores.caldavEventStates.delete(id);
      for (const [overrideId, event] of stores.events) {
        if (event.overrideOf?.parentEventId === id) {
          stores.events.delete(overrideId);
        }
      }
    },
    async listOverrides(parentEventId) {
      return listAll().filter(
        (event) => event.overrideOf?.parentEventId === parentEventId,
      );
    },
    async listOverridesForEvents(parentEventIds) {
      const ids = new Set<string>(parentEventIds);
      return listAll().filter(
        (event) =>
          event.overrideOf !== null &&
          ids.has(event.overrideOf.parentEventId as string),
      );
    },
    async listCandidatesInRange(calendarIds, range) {
      const ids = new Set<string>(calendarIds);
      return listAll().filter(
        (event) =>
          ids.has(event.calendarId as string) &&
          event.overrideOf === null &&
          overlapsRange(event, range),
      );
    },
    async listByCalendar(calendarId) {
      return listAll().filter((event) => event.calendarId === calendarId);
    },
    async listByMentionAddress(address, range) {
      return listAll().filter((event) => {
        if (!event.mentions.includes(address)) {
          return false;
        }
        return range === undefined || overlapsRange(event, range);
      });
    },
    async attachAttachment(eventId, attachmentId, position, _createdAt) {
      const attachment = stores.attachmentsById.get(attachmentId);
      if (attachment === undefined) {
        throw new Error(`unknown attachment in fake: ${attachmentId}`);
      }
      const existing = stores.eventAttachments.get(eventId) ?? [];
      if (existing.some((entry) => entry.id === attachmentId)) {
        return;
      }
      existing.splice(position, 0, attachment);
      stores.eventAttachments.set(eventId, existing);
    },
    async detachAttachment(eventId, attachmentId) {
      const existing = stores.eventAttachments.get(eventId) ?? [];
      const next = existing.filter((entry) => entry.id !== attachmentId);
      stores.eventAttachments.set(eventId, next);
      return next.length !== existing.length;
    },
    async listAttachments(eventId) {
      return stores.eventAttachments.get(eventId) ?? [];
    },
    async listAttachmentsForEvents(eventIds) {
      const result = new Map<string, readonly Attachment[]>();
      for (const eventId of eventIds) {
        result.set(eventId, stores.eventAttachments.get(eventId) ?? []);
      }
      return result;
    },
    async findEventIdsByAttachment(attachmentId: AttachmentId) {
      const ids: CalendarEventId[] = [];
      for (const [eventId, attachments] of stores.eventAttachments) {
        if (attachments.some((entry) => entry.id === attachmentId)) {
          ids.push(eventId as CalendarEventId);
        }
      }
      return ids;
    },
  };
}

function deletionKey(caldavCalendarId: CaldavCalendarId, href: string): string {
  return `${caldavCalendarId} ${href}`;
}

/** In-memory store for per-user calendar rules. Lives beside the other
 * calendar fakes so a test that grants access has everything in one import. */
export function fakeUserCalendarPermissionRepository(
  store: Map<string, UserCalendarPermission>,
): UserCalendarPermissionRepository {
  const forUser = (userId: string): readonly UserCalendarPermission[] =>
    [...store.values()].filter((rule) => rule.userId === userId);
  return {
    async findById(id) {
      return store.get(id) ?? null;
    },
    async listByUserId(userId) {
      return forUser(userId);
    },
    async listByUserIds(userIds) {
      return new Map(
        userIds.map((userId) => [userId as string, forUser(userId)]),
      );
    },
    async findByTarget(userId, capability, ownerUserId) {
      return (
        forUser(userId).find(
          (rule) =>
            rule.capability === capability && rule.ownerUserId === ownerUserId,
        ) ?? null
      );
    },
    async save(permission) {
      store.set(permission.id, permission);
    },
    async delete(id) {
      store.delete(id);
    },
  };
}

export function fakeCaldavAccountRepository(
  stores: FakeCalendarStores,
): CaldavAccountRepository {
  return {
    async findAccountById(id) {
      return stores.caldavAccounts.get(id) ?? null;
    },
    async listAccountsByUser(userId) {
      return [...stores.caldavAccounts.values()].filter(
        (account) => account.userId === userId,
      );
    },
    async saveAccount(account) {
      stores.caldavAccounts.set(account.id, account);
    },
    async deleteAccount(id) {
      stores.caldavAccounts.delete(id);
      for (const [linkId, link] of stores.caldavCalendars) {
        if (link.accountId === id) {
          stores.caldavCalendars.delete(linkId);
        }
      }
    },
    async findCalendarLinkById(id) {
      return stores.caldavCalendars.get(id) ?? null;
    },
    async findCalendarLinkByCalendar(calendarId: CalendarId) {
      return (
        [...stores.caldavCalendars.values()].find(
          (link) => link.calendarId === calendarId,
        ) ?? null
      );
    },
    async listCalendarLinksByAccount(accountId: CaldavAccountId) {
      return [...stores.caldavCalendars.values()].filter(
        (link) => link.accountId === accountId,
      );
    },
    async saveCalendarLink(link) {
      stores.caldavCalendars.set(link.id, link);
    },
    async deleteCalendarLink(id) {
      stores.caldavCalendars.delete(id);
    },
    async findEventState(eventId) {
      return stores.caldavEventStates.get(eventId) ?? null;
    },
    async findEventStateByHref(caldavCalendarId, href) {
      return (
        [...stores.caldavEventStates.values()].find(
          (state) =>
            state.caldavCalendarId === caldavCalendarId && state.href === href,
        ) ?? null
      );
    },
    async listEventStates(caldavCalendarId) {
      return [...stores.caldavEventStates.values()].filter(
        (state) => state.caldavCalendarId === caldavCalendarId,
      );
    },
    async saveEventState(state) {
      stores.caldavEventStates.set(state.eventId, state);
    },
    async deleteEventState(eventId) {
      stores.caldavEventStates.delete(eventId);
    },
    async addDeletion(deletion) {
      stores.caldavDeletions.set(
        deletionKey(deletion.caldavCalendarId, deletion.href),
        deletion,
      );
    },
    async listDeletions(caldavCalendarId) {
      return [...stores.caldavDeletions.values()].filter(
        (deletion) => deletion.caldavCalendarId === caldavCalendarId,
      );
    },
    async removeDeletion(caldavCalendarId, href) {
      stores.caldavDeletions.delete(deletionKey(caldavCalendarId, href));
    },
  };
}

/** A `CredentialCipher` that only marks its input, so a test can assert that
 * a stored value went through the cipher without needing WebCrypto. Never
 * used outside tests -- the real adapter is AES-256-GCM. */
export function plainCredentialCipher(
  options: { readonly available?: boolean } = {},
): CredentialCipher {
  const available = options.available ?? true;
  return {
    available,
    async encrypt(plaintext) {
      if (!available) {
        throw new Error("credential cipher unavailable");
      }
      return `fake:${plaintext}`;
    },
    async decrypt(ciphertext) {
      if (!available) {
        throw new Error("credential cipher unavailable");
      }
      if (!ciphertext.startsWith("fake:")) {
        throw new Error("ciphertext was not produced by this cipher");
      }
      return ciphertext.slice("fake:".length);
    },
  };
}

export interface ScriptedCaldavCall {
  readonly kind: "PUT" | "DELETE";
  readonly href: string;
  readonly ics?: string;
  readonly etag: string | null;
}

export interface ScriptedCaldavClient extends CaldavClient {
  /** Every write the sync attempted, in order. */
  readonly calls: readonly ScriptedCaldavCall[];
}

export interface CaldavScript {
  readonly discovery?: CaldavDiscovery;
  readonly changes?: readonly CaldavChangeSet[];
  readonly objects?: ReadonlyMap<string, CaldavObject>;
  readonly putResults?: ReadonlyMap<string, CaldavPutResult>;
  readonly deleteResults?: ReadonlyMap<string, CaldavDeleteResult>;
  readonly onDiscover?: () => never;
}

/** A `CaldavClient` driven entirely by a canned script. There is no network
 * anywhere in the test suite: iCloud interop is verified against recorded
 * fixtures in the adapter package instead. */
export function scriptedCaldavClient(
  script: CaldavScript = {},
): ScriptedCaldavClient {
  const calls: ScriptedCaldavCall[] = [];
  let changeIndex = 0;
  return {
    calls,
    async discover() {
      script.onDiscover?.();
      return (
        script.discovery ?? {
          principalUrl: null,
          homeSetUrl: null,
          calendars: [],
        }
      );
    },
    async listChanges(_calendar: RemoteCalendarRef, _syncToken) {
      const next = script.changes?.[changeIndex];
      changeIndex += 1;
      return (
        next ?? {
          changedHrefs: [],
          deletedHrefs: [],
          syncToken: null,
          ctag: null,
          fullResync: false,
        }
      );
    },
    async multigetEvents(_calendar, hrefs) {
      const objects: CaldavObject[] = [];
      for (const href of hrefs) {
        const object = script.objects?.get(href);
        if (object !== undefined) {
          objects.push(object);
        }
      }
      return objects;
    },
    async putEvent(_calendar, href, ics, etag) {
      calls.push({ kind: "PUT", href, ics, etag });
      return (
        script.putResults?.get(href) ?? {
          outcome: etag === null ? "CREATED" : "UPDATED",
          etag: `etag-${calls.length}`,
        }
      );
    },
    async deleteEvent(_calendar, href, etag) {
      calls.push({ kind: "DELETE", href, etag });
      return script.deleteResults?.get(href) ?? { outcome: "DELETED" };
    },
  };
}

/** A codec that fails loudly. Use-case tests that care about ICS content
 * inject the real adapter codec or a stub; those that do not must never
 * reach it silently. */
export function unusedIcsCodec(): IcsCodec {
  const fail = (): never => {
    throw new Error("the fake IcsCodec was called but no behavior was set");
  };
  return {
    serializeEvent: () => fail(),
    serializeCalendarObject: () => fail(),
    parseCalendarObject: () => fail(),
  };
}
