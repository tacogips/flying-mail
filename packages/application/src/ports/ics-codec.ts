import type {
  CalendarEvent,
  EventTime,
  OccurrenceStart,
} from "@mailcal/domain/entities/calendar-event";
import type { RecurrenceRule } from "@mailcal/domain/value-objects/recurrence";

/** Something the importer had to approximate. Surfaced in
 * `SyncCalendarResult.warnings` so a user can see why an imported event does
 * not look like it does on the other client, instead of silently getting a
 * subtly different calendar. */
export type IcsWarning =
  | {
      readonly kind: "UNKNOWN_TIME_ZONE";
      readonly uid: string;
      readonly value: string;
    }
  | {
      readonly kind: "RECURRENCE_UNSUPPORTED";
      readonly uid: string;
      readonly value: string;
    };

export interface ParsedIcsLink {
  readonly url: string;
  readonly title: string | null;
}

export interface ParsedIcsEvent {
  readonly uid: string;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly time: EventTime;
  readonly recurrence: RecurrenceRule | null;
  readonly exdates: readonly OccurrenceStart[];
  /** `RECURRENCE-ID`: present when this VEVENT overrides one instance of the
   * series sharing its UID. */
  readonly recurrenceInstanceStart: OccurrenceStart | null;
  readonly mentions: readonly string[];
  readonly links: readonly ParsedIcsLink[];
  /** True when the remote `RRULE` fell outside the supported subset and the
   * event was imported as non-recurring. Such events are never pushed back:
   * re-serializing would overwrite a rule we cannot represent. */
  readonly recurrenceUnsupported: boolean;
  readonly warnings: readonly IcsWarning[];
}

export interface IcsSerializeOptions {
  /** `DTSTAMP`, supplied by the caller's clock so serialization is pure. */
  readonly dtstamp: Date;
  readonly productId?: string;
}

/** RFC 5545 subset codec. Mirrors the `MimeParser`/`MimeBuilder` port
 * precedent: the application layer states the contract, the adapter owns the
 * grammar. */
export interface IcsCodec {
  serializeEvent(event: CalendarEvent, options: IcsSerializeOptions): string;
  /** One calendar object resource: a series master plus every override that
   * shares its UID, as a single `VCALENDAR` with one `VEVENT` per component.
   *
   * RFC 4791 section 4.1 makes the resource, not the event, the unit of
   * storage: every component sharing a UID must live in one object. Pushing
   * a master and its overrides as separate objects would give them the same
   * href and let each silently overwrite the other on the server. */
  serializeCalendarObject(
    events: readonly CalendarEvent[],
    options: IcsSerializeOptions,
  ): string;
  /** One calendar object may hold a series master plus its overrides. */
  parseCalendarObject(ics: string): readonly ParsedIcsEvent[];
}
