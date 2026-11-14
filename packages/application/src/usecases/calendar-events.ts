import {
  type CalendarEvent,
  createCalendarEvent,
  type OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import {
  applyOverrides,
  expandOccurrences,
  MAX_OCCURRENCES_PER_EVENT,
  type Occurrence,
} from "@mailcal/domain/entities/recurrence-expansion";
import { Capability } from "@mailcal/domain/entities/api-key";
import { UserRole } from "@mailcal/domain/entities/user";
import { matchAddressPattern } from "@mailcal/domain/value-objects/address-pattern";
import {
  createEmailAddress,
  type EmailAddress,
  emailDomainName,
} from "@mailcal/domain/value-objects/email-address";
import {
  type CalendarEventId,
  type CalendarId,
  createCalendarEventId,
  createEventLinkId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { BadUserInputError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import {
  type CalendarAccessContext,
  createCalendarAccessContext,
  listReadableCalendars,
  loadReadableEvent,
  loadWritableCalendar,
  loadWritableEvent,
  viewerAccountEmail,
} from "./calendar-access";
import {
  type EventLinkUseCaseInput,
  type EventTimeInput,
  type RecurrenceRuleUseCaseInput,
  toEventTime,
  toOccurrenceStart,
  toRecurrenceRule,
} from "./calendar-event-inputs";
import { translateDomainError } from "./translate-domain-error";

export type EventEditScope = "THIS_OCCURRENCE" | "ENTIRE_SERIES";

export interface CreateCalendarEventInput {
  readonly calendarId: CalendarId;
  readonly title: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly time: EventTimeInput;
  readonly recurrence?: RecurrenceRuleUseCaseInput | null;
  readonly mentions?: readonly string[];
  readonly links?: readonly EventLinkUseCaseInput[];
}

export interface UpdateCalendarEventInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly time?: EventTimeInput;
  readonly recurrence?: RecurrenceRuleUseCaseInput | null;
  readonly mentions?: readonly string[];
  readonly links?: readonly EventLinkUseCaseInput[];
  readonly editScope?: EventEditScope;
  /** Required with `THIS_OCCURRENCE` on a recurring series. */
  readonly occurrenceStart?: string;
}

export interface DeleteCalendarEventInput {
  readonly editScope?: EventEditScope;
  readonly occurrenceStart?: string;
}

export interface ListEventsInRangeInput {
  readonly calendarIds?: readonly CalendarId[];
  /** ISO 8601 instants. */
  readonly rangeStart: string;
  readonly rangeEnd: string;
  /** When false, series masters are returned once at their own start rather
   * than expanded -- what an agent wants when editing the rule itself. */
  readonly expand?: boolean;
}

export interface EventOccurrenceView {
  readonly event: CalendarEvent;
  readonly occurrenceStart: OccurrenceStart;
  readonly startUtc: number;
  readonly endUtc: number;
  readonly isOverride: boolean;
}

export interface ListEventsResult {
  readonly occurrences: readonly EventOccurrenceView[];
  /** True when at least one series hit the per-event occurrence cap. */
  readonly truncated: boolean;
}

function parseInstant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new BadUserInputError(
      `${field} must be an ISO 8601 timestamp`,
      field,
    );
  }
  return parsed;
}

function toLinkInputs(
  links: readonly EventLinkUseCaseInput[],
  random: AppDependencies["random"],
): readonly {
  readonly id: ReturnType<typeof createEventLinkId>;
  readonly url: string;
  readonly title: string | null;
}[] {
  return links.map((link) => ({
    id: createEventLinkId(random.uuid()),
    url: link.url,
    title: link.title ?? null,
  }));
}

export function createCreateCalendarEventUseCase(
  deps: AppDependencies,
): (viewer: Viewer, input: CreateCalendarEventInput) => Promise<CalendarEvent> {
  return async (viewer, input) => {
    await loadWritableCalendar(deps, viewer, input.calendarId);
    const now = deps.clock.now().toISOString();
    try {
      const event = createCalendarEvent({
        id: createCalendarEventId(deps.random.uuid()),
        calendarId: input.calendarId,
        // The UID is generated here, not in the domain: it must be stable
        // and globally unique for CalDAV, which is an application concern.
        uid: `${deps.random.uuid()}@mailcal`,
        title: input.title,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.location === undefined ? {} : { location: input.location }),
        time: toEventTime(input.time),
        recurrence: toRecurrenceRule(input.recurrence),
        ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
        ...(input.links === undefined
          ? {}
          : { links: toLinkInputs(input.links, deps.random) }),
        createdAt: now,
      });
      await deps.calendarEventRepository.createEvent(event);
      return event;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createGetCalendarEventUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: CalendarEventId) => Promise<CalendarEvent | null> {
  return (viewer, id) => loadReadableEvent(deps, viewer, id);
}

/** Rebuilds an event from its current state plus a patch, so every edit goes
 * through the same domain invariants a creation does. */
function patchEvent(
  deps: AppDependencies,
  event: CalendarEvent,
  input: UpdateCalendarEventInput,
  now: string,
): CalendarEvent {
  return createCalendarEvent({
    id: event.id,
    calendarId: event.calendarId,
    uid: event.uid,
    title: input.title ?? event.title,
    description:
      input.description === undefined ? event.description : input.description,
    location: input.location === undefined ? event.location : input.location,
    time: input.time === undefined ? event.time : toEventTime(input.time),
    recurrence:
      input.recurrence === undefined
        ? event.recurrence
        : toRecurrenceRule(input.recurrence),
    exdates: event.exdates,
    overrideOf: event.overrideOf,
    mentions:
      input.mentions === undefined ? [...event.mentions] : input.mentions,
    links:
      input.links === undefined
        ? event.links
        : toLinkInputs(input.links, deps.random),
    createdAt: event.createdAt,
    updatedAt: now,
  });
}

/** `THIS_OCCURRENCE` on a series materializes an override row: a sibling
 * event sharing the master's UID and carrying a `RECURRENCE-ID`. That is
 * exactly how CalDAV represents "this one is different", so the edit
 * survives a round trip through iCloud. */
async function updateSingleOccurrence(
  deps: AppDependencies,
  master: CalendarEvent,
  input: UpdateCalendarEventInput,
  now: string,
): Promise<CalendarEvent> {
  if (input.occurrenceStart === undefined) {
    throw new BadUserInputError(
      "occurrenceStart is required when editScope is THIS_OCCURRENCE",
      "occurrenceStart",
    );
  }
  const instanceStart = toOccurrenceStart(input.occurrenceStart, master.time);
  const existing = (
    await deps.calendarEventRepository.listOverrides(master.id)
  ).find(
    (override) =>
      override.overrideOf !== null &&
      String(override.overrideOf.recurrenceInstanceStart) ===
        String(instanceStart),
  );

  if (existing !== undefined) {
    const updated = patchEvent(deps, existing, input, now);
    await deps.calendarEventRepository.updateEvent(updated);
    return updated;
  }

  const seedTime =
    master.time.kind === "TIMED" && typeof instanceStart === "number"
      ? {
          kind: "TIMED" as const,
          startsAt: instanceStart,
          endsAt: instanceStart + (master.time.endsAt - master.time.startsAt),
          timeZone: master.time.timeZone,
        }
      : master.time;

  const override = createCalendarEvent({
    id: createCalendarEventId(deps.random.uuid()),
    calendarId: master.calendarId,
    uid: master.uid,
    title: input.title ?? master.title,
    description:
      input.description === undefined ? master.description : input.description,
    location: input.location === undefined ? master.location : input.location,
    time: input.time === undefined ? seedTime : toEventTime(input.time),
    // An override never carries its own rule; the master owns the series.
    recurrence: null,
    overrideOf: {
      parentEventId: master.id,
      recurrenceInstanceStart: instanceStart,
    },
    mentions:
      input.mentions === undefined ? [...master.mentions] : input.mentions,
    links:
      input.links === undefined
        ? master.links
        : toLinkInputs(input.links, deps.random),
    createdAt: now,
  });
  await deps.calendarEventRepository.createEvent(override);
  return override;
}

export function createUpdateCalendarEventUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: CalendarEventId,
  input: UpdateCalendarEventInput,
) => Promise<CalendarEvent> {
  return async (viewer, id, input) => {
    const event = await loadWritableEvent(deps, viewer, id);
    const now = deps.clock.now().toISOString();
    try {
      // ENTIRE_SERIES aimed at an overridden instance means the series, not
      // the exception the caller happened to have open. Sibling overrides are
      // left alone: they are deliberate exceptions, and silently flattening
      // them would lose edits the user made on purpose.
      if (event.overrideOf !== null && input.editScope === "ENTIRE_SERIES") {
        const master = await requireSeriesMaster(deps, event);
        const updatedMaster = patchEvent(deps, master, input, now);
        await deps.calendarEventRepository.updateEvent(updatedMaster);
        return updatedMaster;
      }
      if (input.editScope === "THIS_OCCURRENCE" && event.recurrence !== null) {
        return await updateSingleOccurrence(deps, event, input, now);
      }
      const updated = patchEvent(deps, event, input, now);
      await deps.calendarEventRepository.updateEvent(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

/** `THIS_OCCURRENCE` appends an `EXDATE` to the master (and drops any
 * override for that instance) rather than deleting a row -- the series is
 * still one object to every other CalDAV client. */
async function deleteSingleOccurrence(
  deps: AppDependencies,
  master: CalendarEvent,
  instanceStart: OccurrenceStart,
  now: string,
): Promise<boolean> {
  const overrides = await deps.calendarEventRepository.listOverrides(master.id);
  for (const override of overrides) {
    if (
      override.overrideOf !== null &&
      String(override.overrideOf.recurrenceInstanceStart) ===
        String(instanceStart)
    ) {
      await deps.calendarEventRepository.deleteEvent(override.id);
    }
  }
  const updated = createCalendarEvent({
    ...master,
    exdates: [...master.exdates, instanceStart],
    updatedAt: now,
    links: master.links,
    mentions: [...master.mentions],
  });
  await deps.calendarEventRepository.updateEvent(updated);
  return true;
}

export function createDeleteCalendarEventUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: CalendarEventId,
  input?: DeleteCalendarEventInput,
) => Promise<boolean> {
  return async (viewer, id, input = {}) => {
    const event = await loadWritableEvent(deps, viewer, id);
    const now = deps.clock.now().toISOString();
    try {
      // An override carries no rule of its own, so branching on `recurrence`
      // alone would send every override down the plain-delete path: the row
      // would go, the master's EXDATE would not be written, and the instance
      // would come straight back as the series' un-overridden base.
      if (event.overrideOf !== null) {
        const master = await requireSeriesMaster(deps, event);
        if (input.editScope === "ENTIRE_SERIES") {
          // The tombstone belongs to the master: after the resource-grouping
          // fix that is the row carrying the href and etag.
          await recordCaldavTombstone(deps, master);
          await deps.calendarEventRepository.deleteEvent(master.id);
          return true;
        }
        // THIS_OCCURRENCE, and a bare delete of an override: both mean "this
        // instance is gone", which is an EXDATE on the master plus the
        // override row. Bumping the master also marks the CalDAV resource
        // dirty, so the next push re-serializes it without the component.
        return await deleteSingleOccurrence(
          deps,
          master,
          event.overrideOf.recurrenceInstanceStart,
          now,
        );
      }
      if (input.editScope === "THIS_OCCURRENCE" && event.recurrence !== null) {
        if (input.occurrenceStart === undefined) {
          throw new BadUserInputError(
            "occurrenceStart is required when editScope is THIS_OCCURRENCE",
            "occurrenceStart",
          );
        }
        return await deleteSingleOccurrence(
          deps,
          event,
          toOccurrenceStart(input.occurrenceStart, event.time),
          now,
        );
      }
      await recordCaldavTombstone(deps, event);
      await deps.calendarEventRepository.deleteEvent(id);
      return true;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

/** The series an override belongs to. A dangling override cannot be
 * resolved to an instance of anything, so it is reported as absent rather
 * than silently treated as a standalone event. */
async function requireSeriesMaster(
  deps: AppDependencies,
  override: CalendarEvent,
): Promise<CalendarEvent> {
  if (override.overrideOf === null) {
    return override;
  }
  const master = await deps.calendarEventRepository.findById(
    override.overrideOf.parentEventId,
  );
  if (master === null) {
    throw new NotFoundError("CalendarEvent", override.overrideOf.parentEventId);
  }
  return master;
}

/** Deleting a synced event cascades away its `caldav_event_states` row, so
 * the pending remote DELETE is written down first. Without this the event
 * would silently reappear on the next pull. */
async function recordCaldavTombstone(
  deps: AppDependencies,
  event: CalendarEvent,
): Promise<void> {
  const state = await deps.caldavAccountRepository.findEventState(event.id);
  if (state === null) {
    return;
  }
  await deps.caldavAccountRepository.addDeletion({
    caldavCalendarId: state.caldavCalendarId,
    href: state.href,
    etag: state.etag,
    deletedAt: deps.clock.now().toISOString(),
  });
}

function toOccurrenceView(
  event: CalendarEvent,
  occurrence: Occurrence,
  isOverride: boolean,
): EventOccurrenceView {
  return {
    event,
    occurrenceStart: occurrence.occurrenceStart,
    startUtc: occurrence.startUtc,
    endUtc: occurrence.endUtc,
    isOverride,
  };
}

async function resolveRequestedCalendarIds(
  deps: AppDependencies,
  viewer: Viewer,
  requested: readonly CalendarId[] | undefined,
  context: CalendarAccessContext,
): Promise<readonly CalendarId[]> {
  const readable = await listReadableCalendars(deps, viewer, context);
  const readableIds = readable.map((calendar) => calendar.id);
  if (requested === undefined || requested.length === 0) {
    return readableIds;
  }
  const allowed = new Set<string>(readableIds);
  // Silently dropping unreadable ids rather than erroring: naming a
  // calendar the viewer cannot see must not be distinguishable from naming
  // one that does not exist.
  return requested.filter((id) => allowed.has(id));
}

export function createListEventsInRangeUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: ListEventsInRangeInput,
) => Promise<ListEventsResult> {
  return async (viewer, input) => {
    const context = createCalendarAccessContext();
    const range = {
      startUtc: parseInstant(input.rangeStart, "rangeStart"),
      endUtc: parseInstant(input.rangeEnd, "rangeEnd"),
    };
    const calendarIds = await resolveRequestedCalendarIds(
      deps,
      viewer,
      input.calendarIds,
      context,
    );
    if (calendarIds.length === 0) {
      return { occurrences: [], truncated: false };
    }

    const candidates = await deps.calendarEventRepository.listCandidatesInRange(
      calendarIds,
      range,
    );
    const masters = candidates.filter((event) => event.overrideOf === null);
    const rangeOverrides = candidates.filter(
      (event) => event.overrideOf !== null,
    );

    try {
      return buildOccurrences({
        masters,
        rangeOverrides,
        range,
        expand: input.expand ?? true,
        overridesByParent: await loadOverridesByParent(deps, masters),
      });
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

async function loadOverridesByParent(
  deps: AppDependencies,
  masters: readonly CalendarEvent[],
): Promise<ReadonlyMap<string, readonly CalendarEvent[]>> {
  const recurring = masters.filter((event) => event.recurrence !== null);
  if (recurring.length === 0) {
    return new Map();
  }
  const overrides = await deps.calendarEventRepository.listOverridesForEvents(
    recurring.map((event) => event.id),
  );
  const byParent = new Map<string, CalendarEvent[]>();
  for (const override of overrides) {
    if (override.overrideOf === null) {
      continue;
    }
    const key = override.overrideOf.parentEventId as string;
    const bucket = byParent.get(key) ?? [];
    bucket.push(override);
    byParent.set(key, bucket);
  }
  return byParent;
}

function buildOccurrences(params: {
  readonly masters: readonly CalendarEvent[];
  readonly rangeOverrides: readonly CalendarEvent[];
  readonly range: { readonly startUtc: number; readonly endUtc: number };
  readonly expand: boolean;
  readonly overridesByParent: ReadonlyMap<string, readonly CalendarEvent[]>;
}): ListEventsResult {
  const views: EventOccurrenceView[] = [];
  const substituted = new Set<string>();
  let truncated = false;

  for (const master of params.masters) {
    if (!params.expand && master.recurrence !== null) {
      const first = expandOccurrences(
        master,
        params.range.startUtc,
        params.range.endUtc,
        { maxOccurrences: 1 },
      );
      const only = first.occurrences[0];
      if (only !== undefined) {
        views.push(toOccurrenceView(master, only, false));
      }
      continue;
    }
    const expansion = expandOccurrences(
      master,
      params.range.startUtc,
      params.range.endUtc,
      { maxOccurrences: MAX_OCCURRENCES_PER_EVENT },
    );
    truncated = truncated || expansion.truncated;
    const overrides = params.overridesByParent.get(master.id as string) ?? [];
    for (const entry of applyOverrides(
      master,
      overrides,
      expansion.occurrences,
    )) {
      const isOverride = entry.event.id !== master.id;
      if (isOverride) {
        substituted.add(entry.event.id as string);
      }
      // An override may have moved its instance out of the requested range.
      if (
        entry.occurrence.startUtc >= params.range.endUtc ||
        entry.occurrence.endUtc <= params.range.startUtc
      ) {
        continue;
      }
      views.push(toOccurrenceView(entry.event, entry.occurrence, isOverride));
    }
  }

  // An override moved *into* the range from an instance outside it is not
  // reachable through its master's expansion, so it is added here.
  for (const override of params.rangeOverrides) {
    if (substituted.has(override.id as string)) {
      continue;
    }
    const expansion = expandOccurrences(
      override,
      params.range.startUtc,
      params.range.endUtc,
    );
    const only = expansion.occurrences[0];
    if (only === undefined) {
      continue;
    }
    views.push(
      toOccurrenceView(
        override,
        {
          ...only,
          occurrenceStart:
            override.overrideOf?.recurrenceInstanceStart ??
            only.occurrenceStart,
        },
        true,
      ),
    );
  }

  views.sort((left, right) => left.startUtc - right.startUtc);
  return { occurrences: views, truncated };
}

export interface ListEventsMentioningInput {
  readonly address: string;
  readonly rangeStart?: string;
  readonly rangeEnd?: string;
}

/** "Events mentioning me". A USER may query its own address (an ADMIN any
 * address); an API key may query an address one of its `CALENDAR_READ`
 * scopes covers. The per-event read check still runs afterwards, so a
 * mention never widens what the caller can see beyond the matching events. */
export function createListEventsMentioningUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: ListEventsMentioningInput,
) => Promise<readonly CalendarEvent[]> {
  return async (viewer, input) => {
    const context = createCalendarAccessContext();
    const address: EmailAddress = createEmailAddress(input.address, "address");
    await requireMentionQueryAccess(deps, viewer, address, context);

    const range =
      input.rangeStart === undefined || input.rangeEnd === undefined
        ? undefined
        : {
            startUtc: parseInstant(input.rangeStart, "rangeStart"),
            endUtc: parseInstant(input.rangeEnd, "rangeEnd"),
          };
    const events = await deps.calendarEventRepository.listByMentionAddress(
      address,
      range,
    );
    const visible: CalendarEvent[] = [];
    for (const event of events) {
      const readable = await loadReadableEvent(deps, viewer, event.id, context);
      if (readable !== null) {
        visible.push(readable);
      }
    }
    return visible;
  };
}

async function requireMentionQueryAccess(
  deps: AppDependencies,
  viewer: Viewer,
  address: EmailAddress,
  context: CalendarAccessContext,
): Promise<void> {
  if (viewer.kind === "USER") {
    if (viewer.role === UserRole.Admin) {
      return;
    }
    const own = await viewerAccountEmail(deps, viewer, context);
    if (own === address) {
      return;
    }
    // Reported as absent rather than forbidden: asking about someone else's
    // address must not confirm that the address exists here.
    throw new NotFoundError("CalendarEvent", `mentions:${address}`);
  }
  const domain = await deps.mailDomainRepository.findByName(
    emailDomainName(address),
  );
  const covered = viewer.scopes.some(
    (scope) =>
      scope.capability === Capability.CalendarRead &&
      (scope.domainId === null || scope.domainId === (domain?.id ?? null)) &&
      matchAddressPattern(scope.addressPattern, address),
  );
  if (!covered) {
    throw new NotFoundError("CalendarEvent", `mentions:${address}`);
  }
}
