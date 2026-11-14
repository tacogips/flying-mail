import { For, type JSX } from "solid-js";
import type {
  CalendarView,
  EventOccurrenceView,
} from "../../api/calendar-types";
import {
  buildWeekDays,
  isSameDay,
  layoutDayOccurrences,
  occurrencesForDay,
} from "../../lib/calendar-dates";
import { EventChip } from "./event-chip";

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
});

/** Seven day columns over a 24-hour ruler. All-day occurrences sit in their
 * own strip above the ruler, because they have no position on it. */
export function WeekGrid(props: {
  readonly anchor: Date;
  readonly today: Date;
  readonly occurrences: readonly EventOccurrenceView[];
  readonly calendars: readonly CalendarView[];
  readonly onOpenEvent: (occurrence: EventOccurrenceView) => void;
  readonly onCreateOn: (date: Date) => void;
}): JSX.Element {
  const colorOf = (calendarId: string): string | undefined =>
    props.calendars.find((calendar) => calendar.id === calendarId)?.color;
  const days = (): readonly Date[] => buildWeekDays(props.anchor);

  return (
    <div class="week-grid">
      <div class="week-grid__corner" />
      <For each={days()}>
        {(day) => (
          <div
            class="week-grid__head"
            classList={{
              "week-grid__head--today": isSameDay(day, props.today),
            }}
          >
            {DAY_FORMAT.format(day)}
          </div>
        )}
      </For>

      <div class="week-grid__allday">all day</div>
      <For each={days()}>
        {(day) => (
          <div class="week-grid__allday">
            <For
              each={occurrencesForDay(props.occurrences, day).filter(
                (occurrence) => occurrence.event.time.allDay,
              )}
            >
              {(occurrence) => (
                <EventChip
                  occurrence={occurrence}
                  showTime={false}
                  color={colorOf(occurrence.event.calendarId)}
                  onOpen={props.onOpenEvent}
                />
              )}
            </For>
          </div>
        )}
      </For>

      <div class="week-grid__hours">
        <For each={HOURS}>
          {(hour) => (
            <div class="week-grid__hour">
              {String(hour).padStart(2, "0")}:00
            </div>
          )}
        </For>
      </div>
      <For each={days()}>
        {(day) => (
          <div class="week-grid__column">
            {/* The empty background is its own button, sitting behind the
                chips: a chip is already a button, and nesting one inside
                another is invalid HTML. */}
            <button
              type="button"
              class="calendar-hitbox"
              aria-label={`Create an event on ${DAY_FORMAT.format(day)}`}
              onClick={(event) => {
                // Clicking empty space starts a new event at the clicked
                // hour, which is what every calendar app does.
                const bounds = event.currentTarget.getBoundingClientRect();
                const fraction = (event.clientY - bounds.top) / bounds.height;
                const start = new Date(day);
                start.setHours(
                  Math.max(0, Math.min(23, Math.floor(fraction * 24))),
                  0,
                  0,
                  0,
                );
                props.onCreateOn(start);
              }}
            />
            <For each={layoutDayOccurrences(props.occurrences, day)}>
              {(placed) => (
                <EventChip
                  occurrence={placed.occurrence}
                  color={colorOf(placed.occurrence.event.calendarId)}
                  style={{
                    top: `${placed.top * 100}%`,
                    height: `${placed.height * 100}%`,
                    left: `${(placed.column / placed.columns) * 100}%`,
                    width: `${(1 / placed.columns) * 100}%`,
                  }}
                  onOpen={props.onOpenEvent}
                />
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
