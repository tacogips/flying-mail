import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { EventOccurrenceView } from "../../api/calendar-types";
import { formatTimeLabel } from "../../lib/calendar-dates";

/** One occurrence, as a button. A chip is the only way into the event
 * dialog, so it is a real `<button>` rather than a styled div: keyboard
 * users get it for free. */
export function EventChip(props: {
  readonly occurrence: EventOccurrenceView;
  readonly color?: string | undefined;
  readonly showTime?: boolean | undefined;
  readonly style?: JSX.CSSProperties | undefined;
  readonly onOpen: (occurrence: EventOccurrenceView) => void;
}): JSX.Element {
  const allDay = (): boolean => props.occurrence.event.time.allDay;
  return (
    <button
      type="button"
      class="event-chip"
      classList={{
        "event-chip--override": props.occurrence.isOverride,
        "event-chip--positioned": props.style !== undefined,
      }}
      style={{
        ...(props.color === undefined
          ? {}
          : { "background-color": props.color }),
        ...props.style,
      }}
      title={props.occurrence.event.title}
      onClick={(event) => {
        // The cell behind a chip opens the "new event" dialog; a click on
        // the chip means "open this one" and nothing else.
        event.stopPropagation();
        props.onOpen(props.occurrence);
      }}
    >
      <Show when={props.showTime !== false && !allDay()}>
        <span class="event-chip__time">
          {formatTimeLabel(props.occurrence.startsAt)}
        </span>
      </Show>
      {props.occurrence.event.title}
    </button>
  );
}
