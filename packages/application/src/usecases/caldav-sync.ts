import type {
  CaldavCalendarLink,
  CaldavEventState,
} from "@mailcal/domain/entities/caldav-account";
import {
  type CalendarEvent,
  createCalendarEvent,
} from "@mailcal/domain/entities/calendar-event";
import {
  type CalendarEventId,
  type CalendarId,
  createCalendarEventId,
  createEventLinkId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import type { CaldavCredentials, RemoteCalendarRef } from "../ports/caldav";
import type { ParsedIcsEvent } from "../ports/ics-codec";
import { loadWritableCalendar } from "./calendar-access";
import { loadCredentials, requireCipher, translateCaldavError } from "./caldav";

/** On-demand, request-scoped CalDAV sync.
 *
 * Conflicts are resolved **remote wins**, deterministically: when both sides
 * changed since `lastSyncedAt`, or a `PUT` comes back `412`, the remote
 * version replaces the local one and the count is reported. A "last write
 * wins by timestamp" policy would depend on two clocks agreeing, which they
 * do not. */

export interface SyncCalendarResult {
  readonly pulled: number;
  readonly pushed: number;
  readonly deleted: number;
  readonly conflictsResolvedRemoteWins: number;
  /** True when the change set exceeded {@link MAX_OBJECTS_PER_SYNC}; run
   * sync again to continue. A Worker request has a bounded CPU and
   * subrequest budget, so an unbounded first import cannot be attempted. */
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export const MAX_OBJECTS_PER_SYNC = 500;

interface SyncContext {
  readonly deps: AppDependencies;
  readonly link: CaldavCalendarLink;
  readonly calendarId: CalendarId;
  readonly ref: RemoteCalendarRef;
  readonly now: string;
  readonly warnings: string[];
}

function toRef(
  credentials: CaldavCredentials,
  link: CaldavCalendarLink,
): RemoteCalendarRef {
  return { credentials, remoteUrl: link.remoteUrl };
}

function hrefForEvent(event: CalendarEvent, link: CaldavCalendarLink): string {
  const base = link.remoteUrl.endsWith("/")
    ? link.remoteUrl
    : `${link.remoteUrl}/`;
  // The UID is the resource name, which is what every CalDAV server the
  // design targets expects and what makes a re-created event land on the
  // same href.
  return `${base}${encodeURIComponent(event.uid)}.ics`;
}

function toEventFromParsed(
  context: SyncContext,
  parsed: ParsedIcsEvent,
  existing: CalendarEvent | null,
  master: CalendarEvent | null,
): CalendarEvent {
  const links = parsed.links.map((link, index) => ({
    id: createEventLinkId(context.deps.random.uuid()),
    url: link.url,
    title: link.title,
    position: index,
  }));
  return createCalendarEvent({
    id: existing?.id ?? createCalendarEventId(context.deps.random.uuid()),
    calendarId: context.calendarId,
    uid: parsed.uid,
    title: parsed.title,
    description: parsed.description,
    location: parsed.location,
    time: parsed.time,
    recurrence: parsed.recurrence,
    exdates: parsed.exdates,
    overrideOf:
      parsed.recurrenceInstanceStart === null || master === null
        ? null
        : {
            parentEventId: master.id,
            recurrenceInstanceStart: parsed.recurrenceInstanceStart,
          },
    mentions: parsed.mentions,
    links,
    // `createdAt` is preserved on update so a re-pull does not keep
    // resetting it; `updatedAt` is set to the sync instant, which together
    // with the event state's `lastSyncedAt` is what makes the event clean.
    createdAt: existing?.createdAt ?? context.now,
    updatedAt: context.now,
  });
}

async function upsertParsed(
  context: SyncContext,
  parsed: ParsedIcsEvent,
  href: string,
  etag: string | null,
): Promise<"created" | "updated" | "skipped"> {
  const { deps } = context;
  // An overridden instance is only representable once its series master
  // exists locally. A calendar object normally carries both, master first.
  const master =
    parsed.recurrenceInstanceStart === null
      ? null
      : await deps.calendarEventRepository.findByUid(
          context.calendarId,
          parsed.uid,
          null,
        );
  if (parsed.recurrenceInstanceStart !== null && master === null) {
    context.warnings.push(
      `Skipped an overridden instance of ${parsed.uid}: its series is not present`,
    );
    return "skipped";
  }

  const existing = await deps.calendarEventRepository.findByUid(
    context.calendarId,
    parsed.uid,
    parsed.recurrenceInstanceStart,
  );
  const event = toEventFromParsed(context, parsed, existing, master);

  if (existing === null) {
    await deps.calendarEventRepository.createEvent(event);
  } else {
    await deps.calendarEventRepository.updateEvent(event);
  }
  // Only the master component carries the state row: every component of a
  // calendar object shares one href and one etag, and a row per component
  // would make `findEventStateByHref` return an arbitrary one of them.
  // Deleting the master cascades its overrides, so a remote deletion of the
  // resource still removes the whole series locally.
  if (parsed.recurrenceInstanceStart === null) {
    await deps.caldavAccountRepository.saveEventState({
      eventId: event.id,
      caldavCalendarId: context.link.id,
      href,
      etag,
      lastSyncedAt: context.now,
      remoteUnsupported: parsed.recurrenceUnsupported,
    });
  }
  for (const warning of parsed.warnings) {
    context.warnings.push(
      warning.kind === "UNKNOWN_TIME_ZONE"
        ? `Unknown time zone "${warning.value}" on ${warning.uid}: treated as UTC`
        : `Unsupported recurrence rule on ${warning.uid}: imported as a single event and excluded from push`,
    );
  }
  return existing === null ? "created" : "updated";
}

/** Hrefs we have local state for that the remote listing did not mention. */
async function absentHrefs(
  context: SyncContext,
  presentHrefs: readonly string[],
): Promise<readonly string[]> {
  const present = new Set(presentHrefs);
  const states = await context.deps.caldavAccountRepository.listEventStates(
    context.link.id,
  );
  return states
    .filter((state) => !present.has(state.href))
    .map((state) => state.href);
}

interface PullResult {
  readonly pulled: number;
  readonly deleted: number;
  readonly truncated: boolean;
  readonly syncToken: string | null;
  readonly ctag: string | null;
}

async function pull(context: SyncContext): Promise<PullResult> {
  const { deps } = context;
  const changes = await deps.caldavClient.listChanges(
    context.ref,
    context.link.syncToken,
  );

  const changed = changes.changedHrefs.slice(0, MAX_OBJECTS_PER_SYNC);
  const truncated = changes.changedHrefs.length > changed.length;

  let pulled = 0;
  if (changed.length > 0) {
    const objects = await deps.caldavClient.multigetEvents(
      context.ref,
      changed,
    );
    for (const object of objects) {
      for (const parsed of deps.icsCodec.parseCalendarObject(object.ics)) {
        const outcome = await upsertParsed(
          context,
          parsed,
          object.href,
          object.etag,
        );
        if (outcome !== "skipped") {
          pulled += 1;
        }
      }
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
    const state = await deps.caldavAccountRepository.findEventStateByHref(
      context.link.id,
      href,
    );
    if (state === null) {
      continue;
    }
    await deps.calendarEventRepository.deleteEvent(
      state.eventId as CalendarEventId,
    );
    await deps.caldavAccountRepository.deleteEventState(
      state.eventId as CalendarEventId,
    );
    deleted += 1;
  }

  return {
    pulled,
    deleted,
    truncated,
    syncToken: changes.syncToken,
    ctag: changes.ctag,
  };
}

function isDirty(
  event: CalendarEvent,
  state: CaldavEventState | null,
  link: CaldavCalendarLink,
): boolean {
  if (state === null) {
    // Never synced: created locally since the link was made.
    return link.lastSyncedAt === null || event.updatedAt > link.lastSyncedAt;
  }
  return event.updatedAt > state.lastSyncedAt;
}

/** One calendar object resource: the master (or a lone non-recurring event)
 * plus every override sharing its UID. */
interface PushGroup {
  readonly uid: string;
  readonly master: CalendarEvent;
  readonly overrides: readonly CalendarEvent[];
}

/** Groups a calendar's rows into the resources CalDAV actually stores.
 *
 * An override shares its master's UID, and `hrefForEvent` derives the
 * resource name from the UID, so pushing rows individually would send two
 * different single-VEVENT bodies to the same href -- each overwriting the
 * other. The group is the unit of push, of etag, and of `caldav_event_states`
 * identity; that row is always keyed by the master. */
function groupForPush(events: readonly CalendarEvent[]): readonly PushGroup[] {
  const masters = new Map<string, CalendarEvent>();
  const overrides = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    if (event.overrideOf === null) {
      masters.set(event.uid, event);
      continue;
    }
    const bucket = overrides.get(event.uid) ?? [];
    bucket.push(event);
    overrides.set(event.uid, bucket);
  }
  const groups: PushGroup[] = [];
  for (const [uid, master] of masters) {
    groups.push({ uid, master, overrides: overrides.get(uid) ?? [] });
  }
  return groups;
}

async function push(
  context: SyncContext,
): Promise<{ pushed: number; conflicts: number }> {
  const { deps } = context;
  const events = await deps.calendarEventRepository.listByCalendar(
    context.calendarId,
  );
  let pushed = 0;
  let conflicts = 0;

  for (const group of groupForPush(events)) {
    const members = [group.master, ...group.overrides];
    // The state row belongs to the master, but an override that has never
    // been synced still has one of its own from an older layout; either way
    // the master's row is the group's identity.
    const state = await deps.caldavAccountRepository.findEventState(
      group.master.id,
    );
    if (state?.remoteUnsupported === true) {
      // The remote rule is outside the supported subset. Re-serializing
      // would replace it with something else entirely.
      context.warnings.push(
        `Not pushing ${group.uid}: its remote recurrence rule is not representable`,
      );
      continue;
    }
    // Any dirty member makes the whole resource dirty: the object is
    // rewritten as a whole, so editing one override still republishes the
    // master alongside it.
    if (!members.some((member) => isDirty(member, state, context.link))) {
      continue;
    }
    const href = state?.href ?? hrefForEvent(group.master, context.link);
    const ics = deps.icsCodec.serializeCalendarObject(members, {
      dtstamp: deps.clock.now(),
    });
    const result = await deps.caldavClient.putEvent(
      context.ref,
      href,
      ics,
      state?.etag ?? null,
    );
    if (result.outcome === "CONFLICT") {
      conflicts += 1;
      await resolveRemoteWins(context, href);
      continue;
    }
    // Overrides carry no state row of their own -- the resource has one
    // etag -- so any stale row from an older layout is removed *before* the
    // master's row is written. `caldav_event_states` is UNIQUE on
    // (caldav_calendar_id, href), so saving first would have the master
    // collide with a legacy override row holding the same href, and the
    // upsert only resolves ON CONFLICT(event_id).
    for (const override of group.overrides) {
      await deps.caldavAccountRepository.deleteEventState(override.id);
    }
    await deps.caldavAccountRepository.saveEventState({
      eventId: group.master.id,
      caldavCalendarId: context.link.id,
      href,
      etag: result.etag,
      lastSyncedAt: context.now,
      remoteUnsupported: false,
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
  const objects = await context.deps.caldavClient.multigetEvents(context.ref, [
    href,
  ]);
  for (const object of objects) {
    for (const parsed of context.deps.icsCodec.parseCalendarObject(
      object.ics,
    )) {
      await upsertParsed(context, parsed, object.href, object.etag);
    }
  }
}

async function pushDeletions(
  context: SyncContext,
): Promise<{ deleted: number; conflicts: number }> {
  const { deps } = context;
  const tombstones = await deps.caldavAccountRepository.listDeletions(
    context.link.id,
  );
  let deleted = 0;
  let conflicts = 0;
  for (const tombstone of tombstones) {
    const result = await deps.caldavClient.deleteEvent(
      context.ref,
      tombstone.href,
      tombstone.etag,
    );
    if (result.outcome === "CONFLICT") {
      // The remote changed after we deleted locally. Remote wins, so the
      // event comes back rather than the remote losing an edit.
      conflicts += 1;
      await resolveRemoteWins(context, tombstone.href);
      await deps.caldavAccountRepository.removeDeletion(
        context.link.id,
        tombstone.href,
      );
      continue;
    }
    await deps.caldavAccountRepository.removeDeletion(
      context.link.id,
      tombstone.href,
    );
    deleted += 1;
  }
  return { deleted, conflicts };
}

export function createSyncCalendarUseCase(
  deps: AppDependencies,
): (viewer: Viewer, calendarId: CalendarId) => Promise<SyncCalendarResult> {
  return async (viewer, calendarId) => {
    // Sync writes local events, so it requires calendar write authorization
    // -- a read-scoped key cannot use it to mutate a calendar.
    await loadWritableCalendar(deps, viewer, calendarId);
    requireCipher(deps);

    const link =
      await deps.caldavAccountRepository.findCalendarLinkByCalendar(calendarId);
    if (link === null) {
      throw new BadUserInputError(
        "This calendar is not linked to a CalDAV collection",
        "calendarId",
      );
    }
    const account = await deps.caldavAccountRepository.findAccountById(
      link.accountId,
    );
    if (account === null) {
      throw new NotFoundError("CaldavAccount", link.accountId);
    }

    const credentials = await loadCredentials(deps, account);
    const context: SyncContext = {
      deps,
      link,
      calendarId,
      ref: toRef(credentials, link),
      now: deps.clock.now().toISOString(),
      warnings: [],
    };

    try {
      const pulledResult = await pull(context);
      const pushedResult = await push(context);
      const deletionResult = await pushDeletions(context);

      await deps.caldavAccountRepository.saveCalendarLink({
        ...link,
        ctag: pulledResult.ctag,
        syncToken: pulledResult.syncToken,
        lastSyncedAt: context.now,
      });

      return {
        pulled: pulledResult.pulled,
        pushed: pushedResult.pushed,
        deleted: pulledResult.deleted + deletionResult.deleted,
        conflictsResolvedRemoteWins:
          pushedResult.conflicts + deletionResult.conflicts,
        truncated: pulledResult.truncated,
        warnings: context.warnings,
      };
    } catch (error) {
      return translateCaldavError(error);
    }
  };
}
