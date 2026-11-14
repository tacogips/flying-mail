import { createSignal, type JSX, onMount, Show } from "solid-js";
import type { EventOccurrenceView } from "../api/calendar-types";
import { CaldavSettings } from "../components/calendar/caldav-settings";
import { CalendarToolbar } from "../components/calendar/calendar-toolbar";
import {
  EventDialog,
  type EventDialogTarget,
} from "../components/calendar/event-dialog";
import { MonthGrid } from "../components/calendar/month-grid";
import { WeekGrid } from "../components/calendar/week-grid";
import "../components/calendar/calendar.css";
import { startOfDay } from "../lib/calendar-dates";
import { createCalendarStore } from "../store/calendar-store";

/** The `/calendar` route.
 *
 * The calendar store is created here rather than in the app-level store
 * context: it is only ever needed behind this lazy route, and mounting it
 * globally would make every mailbox visitor pay for state they never read.
 */
export default function CalendarPage(): JSX.Element {
  const store = createCalendarStore();
  const [dialog, setDialog] = createSignal<EventDialogTarget | null>(null);
  const [showSettings, setShowSettings] = createSignal(false);
  const today = startOfDay(new Date());

  onMount(() => {
    void (async () => {
      await store.loadCalendars();
      await store.loadRange();
    })();
  });

  function navigate(action: () => void): void {
    action();
    void store.loadRange();
  }

  function openOccurrence(occurrence: EventOccurrenceView): void {
    setDialog({ occurrence, start: new Date(occurrence.startsAt) });
  }

  function createOn(date: Date): void {
    const start = new Date(date);
    if (start.getHours() === 0 && start.getMinutes() === 0) {
      // A month cell carries no time; 09:00 is a friendlier default than
      // midnight.
      start.setHours(9, 0, 0, 0);
    }
    setDialog({ occurrence: null, start });
  }

  return (
    <div class="calendar-page">
      <CalendarToolbar
        mode={store.mode()}
        anchor={store.anchor()}
        loading={store.loading()}
        calendars={store.calendars()}
        hiddenCalendarIds={store.hiddenCalendarIds()}
        onModeChange={(mode) => navigate(() => store.setMode(mode))}
        onPrevious={() => navigate(() => store.goPrevious())}
        onToday={() => navigate(() => store.goToday())}
        onNext={() => navigate(() => store.goNext())}
        onToggleCalendar={(id) => store.toggleCalendarVisible(id)}
        onNewEvent={() => createOn(new Date())}
        onToggleSettings={() => setShowSettings((current) => !current)}
      />

      <Show when={store.truncated()}>
        <p class="calendar-banner">
          Some series were cut short by the expansion limit; narrow the range to
          see the rest.
        </p>
      </Show>
      <Show when={store.calendars().length === 0}>
        <p class="calendar-banner">
          You have no calendars yet. Create one from CalDAV, or ask an admin.
        </p>
      </Show>

      <div class="calendar-grid">
        <Show
          when={store.mode() === "MONTH"}
          fallback={
            <WeekGrid
              anchor={store.anchor()}
              today={today}
              occurrences={store.visibleOccurrences()}
              calendars={store.calendars()}
              onOpenEvent={openOccurrence}
              onCreateOn={createOn}
            />
          }
        >
          <MonthGrid
            anchor={store.anchor()}
            today={today}
            occurrences={store.visibleOccurrences()}
            calendars={store.calendars()}
            onOpenEvent={openOccurrence}
            onCreateOn={createOn}
          />
        </Show>
      </div>

      <Show when={showSettings()}>
        <CaldavSettings store={store} calendars={store.calendars()} />
      </Show>

      <Show when={dialog()}>
        {(target) => (
          <EventDialog
            store={store}
            calendars={store.calendars()}
            target={target()}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
    </div>
  );
}
