import { For, type JSX, Show } from "solid-js";
import type {
  CalendarView,
  EventOccurrenceView,
} from "../../api/calendar-types";
import {
  buildMonthMatrix,
  occurrencesForDay,
  toIsoDate,
} from "../../lib/calendar-dates";
import { EventChip } from "./event-chip";

/** Above this, a cell shows "+n more" instead of growing: a month cell is
 * ~96px tall, and four chips is what fits without scrolling inside it. */
const MAX_CHIPS_PER_CELL = 4;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function MonthGrid(props: {
  readonly anchor: Date;
  readonly today: Date;
  readonly occurrences: readonly EventOccurrenceView[];
  readonly calendars: readonly CalendarView[];
  readonly onOpenEvent: (occurrence: EventOccurrenceView) => void;
  readonly onCreateOn: (date: Date) => void;
}): JSX.Element {
  const colorOf = (calendarId: string): string | undefined =>
    props.calendars.find((calendar) => calendar.id === calendarId)?.color;

  return (
    <div class="month-grid">
      <For each={WEEKDAY_LABELS}>
        {(label) => <div class="month-grid__weekday">{label}</div>}
      </For>
      <For each={buildMonthMatrix(props.anchor, props.today)}>
        {(week) => (
          <For each={week}>
            {(cell) => {
              const forDay = (): readonly EventOccurrenceView[] =>
                occurrencesForDay(props.occurrences, cell.date);
              return (
                <div
                  class="month-grid__cell"
                  classList={{
                    "month-grid__cell--outside": !cell.inMonth,
                    "month-grid__cell--today": cell.isToday,
                  }}
                >
                  {/* The cell background is a button behind the chips; a
                      chip is itself a button, and nesting the two would be
                      invalid HTML. */}
                  <button
                    type="button"
                    class="calendar-hitbox"
                    aria-label={`Create an event on ${toIsoDate(cell.date)}`}
                    onClick={() => props.onCreateOn(cell.date)}
                  />
                  <span class="month-grid__daynumber">
                    {cell.date.getDate()}
                  </span>
                  <For each={forDay().slice(0, MAX_CHIPS_PER_CELL)}>
                    {(occurrence) => (
                      <EventChip
                        occurrence={occurrence}
                        color={colorOf(occurrence.event.calendarId)}
                        onOpen={props.onOpenEvent}
                      />
                    )}
                  </For>
                  <Show when={forDay().length > MAX_CHIPS_PER_CELL}>
                    <span class="month-grid__more">
                      +{forDay().length - MAX_CHIPS_PER_CELL} more
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        )}
      </For>
    </div>
  );
}
