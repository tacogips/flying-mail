import type { Attachment } from "@mailcal/domain/entities/attachment";
import {
  type CalendarEvent,
  createCalendarEvent,
} from "@mailcal/domain/entities/calendar-event";
import type {
  AttachmentId,
  CalendarEventId,
  EventLinkId,
} from "@mailcal/domain/value-objects/ids";
import { createEventLinkId } from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError } from "../errors";
import type { Viewer } from "../policies/viewer";
import { loadReadableEvent, loadWritableEvent } from "./calendar-access";
import type { EventLinkUseCaseInput } from "./calendar-event-inputs";
import { translateDomainError } from "./translate-domain-error";

/** Mention, link and attachment management. Split out of
 * `calendar-events.ts` so neither file carries the whole event surface. */

function rebuild(
  event: CalendarEvent,
  patch: {
    readonly mentions?: readonly string[];
    readonly links?: CalendarEvent["links"];
  },
  updatedAt: string,
): CalendarEvent {
  return createCalendarEvent({
    id: event.id,
    calendarId: event.calendarId,
    uid: event.uid,
    title: event.title,
    description: event.description,
    location: event.location,
    time: event.time,
    recurrence: event.recurrence,
    exdates: event.exdates,
    overrideOf: event.overrideOf,
    mentions: patch.mentions ?? [...event.mentions],
    links: patch.links ?? event.links,
    createdAt: event.createdAt,
    updatedAt,
  });
}

/** Mentions are addressed by mail address, as the acceptance criteria
 * require -- there is no user lookup and no invitation. Adding an address
 * that is already mentioned is a no-op, not an error. */
export function createAddEventMentionUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  address: string,
) => Promise<CalendarEvent> {
  return async (viewer, eventId, address) => {
    const event = await loadWritableEvent(deps, viewer, eventId);
    const now = deps.clock.now().toISOString();
    try {
      const updated = rebuild(
        event,
        { mentions: [...event.mentions, address] },
        now,
      );
      await deps.calendarEventRepository.updateEvent(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createRemoveEventMentionUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  address: string,
) => Promise<CalendarEvent> {
  return async (viewer, eventId, address) => {
    const event = await loadWritableEvent(deps, viewer, eventId);
    const normalized = address.trim().toLowerCase();
    const now = deps.clock.now().toISOString();
    try {
      const updated = rebuild(
        event,
        {
          mentions: event.mentions.filter((mention) => mention !== normalized),
        },
        now,
      );
      await deps.calendarEventRepository.updateEvent(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createAddEventLinkUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  link: EventLinkUseCaseInput,
) => Promise<CalendarEvent> {
  return async (viewer, eventId, link) => {
    const event = await loadWritableEvent(deps, viewer, eventId);
    const now = deps.clock.now().toISOString();
    try {
      const updated = rebuild(
        event,
        {
          links: [
            ...event.links,
            {
              id: createEventLinkId(deps.random.uuid()),
              url: link.url,
              title: link.title ?? null,
              position: event.links.length,
            },
          ],
        },
        now,
      );
      await deps.calendarEventRepository.updateEvent(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createRemoveEventLinkUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  linkId: EventLinkId,
) => Promise<CalendarEvent> {
  return async (viewer, eventId, linkId) => {
    const event = await loadWritableEvent(deps, viewer, eventId);
    const now = deps.clock.now().toISOString();
    try {
      const updated = rebuild(
        event,
        { links: event.links.filter((link) => link.id !== linkId) },
        now,
      );
      await deps.calendarEventRepository.updateEvent(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

/** Claims a staged upload for an event, reusing the existing
 * `POST /api/attachments` flow untouched. Only an unclaimed staged upload
 * qualifies: an attachment already bound to a message belongs to that
 * message's authorization domain, and re-binding it here would let an event
 * launder access to mail. */
export function createAttachFileToEventUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  attachmentId: AttachmentId,
) => Promise<readonly Attachment[]> {
  return async (viewer, eventId, attachmentId) => {
    await loadWritableEvent(deps, viewer, eventId);
    const attachment =
      await deps.messageRepository.findAttachmentById(attachmentId);
    if (attachment === null) {
      throw new NotFoundError("Attachment", attachmentId);
    }
    if (attachment.messageId !== null) {
      throw new ConflictError(
        "This attachment already belongs to a message and cannot be attached to an event",
      );
    }
    const claimants =
      await deps.calendarEventRepository.findEventIdsByAttachment(attachmentId);
    if (claimants.some((claimant) => claimant !== eventId)) {
      throw new ConflictError(
        "This attachment is already attached to another event",
      );
    }
    const existing =
      await deps.calendarEventRepository.listAttachments(eventId);
    await deps.calendarEventRepository.attachAttachment(
      eventId,
      attachmentId,
      existing.length,
      deps.clock.now().toISOString(),
    );
    return deps.calendarEventRepository.listAttachments(eventId);
  };
}

export function createDetachFileFromEventUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
  attachmentId: AttachmentId,
) => Promise<boolean> {
  return async (viewer, eventId, attachmentId) => {
    await loadWritableEvent(deps, viewer, eventId);
    return deps.calendarEventRepository.detachAttachment(eventId, attachmentId);
  };
}

export function createListEventAttachmentsUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  eventId: CalendarEventId,
) => Promise<readonly Attachment[]> {
  return async (viewer, eventId) => {
    const event = await loadReadableEvent(deps, viewer, eventId);
    if (event === null) {
      return [];
    }
    return deps.calendarEventRepository.listAttachments(eventId);
  };
}

/** Backs the attachment download route's event branch: can this viewer read
 * *any* event that claims the attachment? Returns false for an attachment no
 * event has claimed, so the message path stays in charge of those. */
export function createCanViewerReadEventAttachmentUseCase(
  deps: AppDependencies,
): (viewer: Viewer, attachmentId: AttachmentId) => Promise<boolean> {
  return async (viewer, attachmentId) => {
    const eventIds =
      await deps.calendarEventRepository.findEventIdsByAttachment(attachmentId);
    for (const eventId of eventIds) {
      if ((await loadReadableEvent(deps, viewer, eventId)) !== null) {
        return true;
      }
    }
    return false;
  };
}
