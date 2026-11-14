import { For, type JSX } from "solid-js";
import type { CalendarView } from "../../api/calendar-types";
import {
  type CalendarViewMode,
  formatRangeLabel,
} from "../../lib/calendar-dates";

/** View switch, range navigation, calendar visibility toggles and the two
 * entry points (new event, CalDAV settings). */
export function CalendarToolbar(props: {
  readonly mode: CalendarViewMode;
  readonly anchor: Date;
  readonly loading: boolean;
  readonly calendars: readonly CalendarView[];
  readonly hiddenCalendarIds: ReadonlySet<string>;
  readonly onModeChange: (mode: CalendarViewMode) => void;
  readonly onPrevious: () => void;
  readonly onToday: () => void;
  readonly onNext: () => void;
  readonly onToggleCalendar: (calendarId: string) => void;
  readonly onNewEvent: () => void;
  readonly onToggleSettings: () => void;
}): JSX.Element {
  return (
    <>
      <div class="calendar-toolbar">
        <div class="calendar-toolbar__group">
          <button
            type="button"
            onClick={props.onPrevious}
            aria-label="Previous"
          >
            &lt;
          </button>
          <button type="button" onClick={props.onToday}>
            Today
          </button>
          <button type="button" onClick={props.onNext} aria-label="Next">
            &gt;
          </button>
        </div>
        <span class="calendar-toolbar__label">
          {formatRangeLabel(props.mode, props.anchor)}
        </span>
        <div class="calendar-toolbar__group">
          <button
            type="button"
            aria-pressed={props.mode === "MONTH"}
            onClick={() => props.onModeChange("MONTH")}
          >
            Month
          </button>
          <button
            type="button"
            aria-pressed={props.mode === "WEEK"}
            onClick={() => props.onModeChange("WEEK")}
          >
            Week
          </button>
        </div>
        <span class="calendar-toolbar__spacer" />
        <span aria-live="polite">{props.loading ? "Loading..." : ""}</span>
        <div class="calendar-toolbar__group">
          <button type="button" onClick={props.onToggleSettings}>
            CalDAV
          </button>
          <button
            type="button"
            class="primary"
            onClick={props.onNewEvent}
            disabled={props.calendars.length === 0}
          >
            New event
          </button>
        </div>
      </div>
      <div class="calendar-legend">
        <For each={props.calendars}>
          {(calendar) => (
            <button
              type="button"
              class="calendar-legend__item"
              aria-pressed={!props.hiddenCalendarIds.has(calendar.id)}
              onClick={() => props.onToggleCalendar(calendar.id)}
            >
              <span
                class="calendar-legend__swatch"
                style={{ "background-color": calendar.color }}
              />
              {calendar.name}
            </button>
          )}
        </For>
      </div>
    </>
  );
}
