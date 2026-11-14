import { createSignal, For, type JSX, Show } from "solid-js";
import type {
  CalendarEventView,
  CalendarView,
  CreateCalendarEventInput,
  EventEditScope,
  EventLinkInput,
  EventOccurrenceView,
  RecurrenceFrequency,
  RecurrenceRuleInput,
  UpdateCalendarEventInput,
  Weekday,
} from "../../api/calendar-types";
import { uploadAttachment } from "../../api/graphql-client";
import {
  browserTimeZone,
  fromDateAndTime,
  toIsoDate,
  toTimeInputValue,
} from "../../lib/calendar-dates";
import { pushToast } from "../../lib/toast";
import type { CalendarStore } from "../../store/calendar-store";

/** Create/edit dialog: title, calendar, all-day toggle, start/end with time
 * zone, the supported recurrence subset, mention chips, URL links and
 * attachments.
 *
 * `editScope` is asked for -- not guessed -- whenever the event being edited
 * belongs to a series: "this occurrence" and "the whole series" are
 * different destructive choices, and picking one silently is how calendar
 * apps lose people's meetings. */

const WEEKDAYS: readonly Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

const FREQUENCIES: readonly RecurrenceFrequency[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

export interface EventDialogTarget {
  /** The occurrence being edited, or `null` for a new event. */
  readonly occurrence: EventOccurrenceView | null;
  /** Seed start for a new event, from the clicked cell. */
  readonly start: Date;
}

interface LinkDraft {
  readonly url: string;
  readonly title: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EventDialog(props: {
  readonly store: CalendarStore;
  readonly calendars: readonly CalendarView[];
  readonly target: EventDialogTarget;
  readonly onClose: () => void;
}): JSX.Element {
  const existing = (): CalendarEventView | null =>
    props.target.occurrence?.event ?? null;
  const isSeriesMember = (): boolean => {
    const event = existing();
    return (
      event !== null &&
      (event.recurrence !== null || event.overrideOfEventId !== null)
    );
  };

  const seedStart = (): Date =>
    existing()?.time.startsAt !== undefined &&
    existing()?.time.startsAt !== null
      ? new Date(String(existing()?.time.startsAt))
      : props.target.start;
  const seedEnd = (): Date => {
    const endsAt = existing()?.time.endsAt;
    if (endsAt != null) {
      return new Date(endsAt);
    }
    return new Date(seedStart().getTime() + 3_600_000);
  };

  const [title, setTitle] = createSignal(existing()?.title ?? "");
  const [description, setDescription] = createSignal(
    existing()?.description ?? "",
  );
  const [location, setLocation] = createSignal(existing()?.location ?? "");
  const [calendarId, setCalendarId] = createSignal(
    existing()?.calendarId ?? props.calendars[0]?.id ?? "",
  );
  const [allDay, setAllDay] = createSignal(existing()?.time.allDay ?? false);
  const [startDate, setStartDate] = createSignal(
    existing()?.time.startDate ?? toIsoDate(seedStart()),
  );
  const [startTime, setStartTime] = createSignal(toTimeInputValue(seedStart()));
  const [endDate, setEndDate] = createSignal(
    existing()?.time.endDateExclusive ?? toIsoDate(seedEnd()),
  );
  const [endTime, setEndTime] = createSignal(toTimeInputValue(seedEnd()));
  const [timeZone, setTimeZone] = createSignal(
    existing()?.time.timeZone ?? browserTimeZone(),
  );

  const [repeats, setRepeats] = createSignal(existing()?.recurrence !== null);
  const [freq, setFreq] = createSignal<RecurrenceFrequency>(
    existing()?.recurrence?.freq ?? "WEEKLY",
  );
  const [interval, setInterval] = createSignal(
    existing()?.recurrence?.interval ?? 1,
  );
  const [count, setCount] = createSignal(existing()?.recurrence?.count ?? null);
  const [until, setUntil] = createSignal(
    existing()?.recurrence?.until === null ||
      existing()?.recurrence?.until === undefined
      ? ""
      : toIsoDate(new Date(String(existing()?.recurrence?.until))),
  );
  const [byDay, setByDay] = createSignal<readonly Weekday[]>(
    existing()?.recurrence?.byDay ?? [],
  );

  const [mentions, setMentions] = createSignal<readonly string[]>(
    existing()?.mentions ?? [],
  );
  const [mentionDraft, setMentionDraft] = createSignal("");
  const [links, setLinks] = createSignal<readonly LinkDraft[]>(
    (existing()?.links ?? []).map((link) => ({
      url: link.url,
      title: link.title ?? "",
    })),
  );
  const [editScope, setEditScope] =
    createSignal<EventEditScope>("ENTIRE_SERIES");
  const [busy, setBusy] = createSignal(false);

  function addMention(): void {
    const address = mentionDraft().trim().toLowerCase();
    if (address.length === 0) {
      return;
    }
    if (!EMAIL_PATTERN.test(address)) {
      pushToast("error", `${address} is not a mail address`);
      return;
    }
    if (!mentions().includes(address)) {
      setMentions([...mentions(), address]);
    }
    setMentionDraft("");
  }

  function timeInput(): CreateCalendarEventInput["time"] {
    if (allDay()) {
      return {
        allDay: true,
        startDate: startDate(),
        endDateExclusive: endDate(),
      };
    }
    return {
      allDay: false,
      startsAt: fromDateAndTime(startDate(), startTime()).toISOString(),
      endsAt: fromDateAndTime(endDate(), endTime()).toISOString(),
      timeZone: timeZone(),
    };
  }

  function recurrenceInput(): RecurrenceRuleInput | undefined {
    if (!repeats()) {
      return undefined;
    }
    return {
      freq: freq(),
      interval: interval(),
      ...(count() === null ? {} : { count: Number(count()) }),
      ...(until().length === 0
        ? {}
        : { until: fromDateAndTime(until(), "23:59").toISOString() }),
      ...(byDay().length === 0 ? {} : { byDay: byDay() }),
    };
  }

  function linkInputs(): readonly EventLinkInput[] {
    return links()
      .filter((link) => link.url.trim().length > 0)
      .map((link) => ({
        url: link.url.trim(),
        ...(link.title.trim().length === 0 ? {} : { title: link.title.trim() }),
      }));
  }

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (calendarId().length === 0) {
      pushToast("error", "Create a calendar first");
      return;
    }
    setBusy(true);
    const recurrence = recurrenceInput();
    const current = existing();
    if (current === null) {
      const input: CreateCalendarEventInput = {
        calendarId: calendarId(),
        title: title(),
        time: timeInput(),
        ...(description().trim().length === 0
          ? {}
          : { description: description() }),
        ...(location().trim().length === 0 ? {} : { location: location() }),
        ...(recurrence === undefined ? {} : { recurrence }),
        mentions: mentions(),
        links: linkInputs(),
      };
      const created = await props.store.createEvent(input);
      setBusy(false);
      if (created !== null) {
        props.onClose();
      }
      return;
    }

    const update: UpdateCalendarEventInput = {
      title: title(),
      description: description(),
      location: location(),
      time: timeInput(),
      ...(recurrence === undefined ? {} : { recurrence }),
      mentions: mentions(),
      links: linkInputs(),
      ...(isSeriesMember()
        ? {
            editScope: editScope(),
            ...(editScope() === "THIS_OCCURRENCE"
              ? {
                  occurrenceStart:
                    props.target.occurrence?.occurrenceStart ?? "",
                }
              : {}),
          }
        : {}),
    };
    const saved = await props.store.updateEvent(current.id, update);
    setBusy(false);
    if (saved !== null) {
      props.onClose();
    }
  }

  async function remove(): Promise<void> {
    const current = existing();
    if (current === null) {
      return;
    }
    setBusy(true);
    const ok = await props.store.deleteEvent(current.id, {
      ...(isSeriesMember()
        ? {
            editScope: editScope(),
            ...(editScope() === "THIS_OCCURRENCE"
              ? {
                  occurrenceStart:
                    props.target.occurrence?.occurrenceStart ?? "",
                }
              : {}),
          }
        : {}),
    });
    setBusy(false);
    if (ok) {
      props.onClose();
    }
  }

  async function upload(files: FileList | null): Promise<void> {
    const current = existing();
    const file = files?.[0];
    if (file === undefined) {
      return;
    }
    if (current === null) {
      // The claim needs an event id, so the file has to wait until the event
      // exists. Saying so beats silently dropping the upload.
      pushToast("info", "Save the event first, then attach files to it.");
      return;
    }
    setBusy(true);
    const uploaded = await uploadAttachment(file);
    if (!uploaded.ok) {
      setBusy(false);
      pushToast("error", "Upload failed");
      return;
    }
    await props.store.attachFile(current.id, uploaded.data.id);
    setBusy(false);
  }

  return (
    // A modal backdrop: clicking or pressing Escape outside the form closes
    // it, and the dialog role is what tells assistive technology that the
    // rest of the page is inert.
    <div
      class="calendar-dialog__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={existing() === null ? "New event" : "Edit event"}
      tabindex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          props.onClose();
        }
      }}
    >
      <form class="calendar-dialog" onSubmit={(event) => void save(event)}>
        <h2>{existing() === null ? "New event" : "Edit event"}</h2>

        <div class="calendar-dialog__field">
          <label for="event-title">Title</label>
          <input
            id="event-title"
            value={title()}
            required
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </div>

        <div class="calendar-dialog__row">
          <div>
            <label for="event-calendar">Calendar</label>
            <select
              id="event-calendar"
              value={calendarId()}
              onChange={(event) => setCalendarId(event.currentTarget.value)}
            >
              <For each={props.calendars}>
                {(calendar) => (
                  <option value={calendar.id}>{calendar.name}</option>
                )}
              </For>
            </select>
          </div>
          <div>
            <label class="calendar-dialog__checkbox">
              <input
                type="checkbox"
                checked={allDay()}
                onChange={(event) => setAllDay(event.currentTarget.checked)}
              />
              All day
            </label>
          </div>
        </div>

        <div class="calendar-dialog__row">
          <div>
            <label for="event-start-date">Starts</label>
            <input
              id="event-start-date"
              type="date"
              value={startDate()}
              onInput={(event) => setStartDate(event.currentTarget.value)}
            />
          </div>
          <Show when={!allDay()}>
            <div>
              <label for="event-start-time">Start time</label>
              <input
                id="event-start-time"
                type="time"
                value={startTime()}
                onInput={(event) => setStartTime(event.currentTarget.value)}
              />
            </div>
          </Show>
          <div>
            <label for="event-end-date">
              {allDay() ? "Ends (exclusive)" : "Ends"}
            </label>
            <input
              id="event-end-date"
              type="date"
              value={endDate()}
              onInput={(event) => setEndDate(event.currentTarget.value)}
            />
          </div>
          <Show when={!allDay()}>
            <div>
              <label for="event-end-time">End time</label>
              <input
                id="event-end-time"
                type="time"
                value={endTime()}
                onInput={(event) => setEndTime(event.currentTarget.value)}
              />
            </div>
          </Show>
        </div>

        <Show when={!allDay()}>
          <div class="calendar-dialog__field">
            <label for="event-tz">Time zone</label>
            <input
              id="event-tz"
              value={timeZone()}
              onInput={(event) => setTimeZone(event.currentTarget.value)}
            />
          </div>
        </Show>

        <div class="calendar-dialog__field">
          <label class="calendar-dialog__checkbox">
            <input
              type="checkbox"
              checked={repeats()}
              onChange={(event) => setRepeats(event.currentTarget.checked)}
            />
            Repeats
          </label>
        </div>

        <Show when={repeats()}>
          <div class="calendar-dialog__row">
            <div>
              <label for="event-freq">Frequency</label>
              <select
                id="event-freq"
                value={freq()}
                onChange={(event) =>
                  setFreq(event.currentTarget.value as RecurrenceFrequency)
                }
              >
                <For each={FREQUENCIES}>
                  {(value) => <option value={value}>{value}</option>}
                </For>
              </select>
            </div>
            <div>
              <label for="event-interval">Every</label>
              <input
                id="event-interval"
                type="number"
                min="1"
                value={interval()}
                onInput={(event) =>
                  setInterval(Number(event.currentTarget.value) || 1)
                }
              />
            </div>
            <div>
              <label for="event-count">Count</label>
              <input
                id="event-count"
                type="number"
                min="1"
                value={count() ?? ""}
                onInput={(event) =>
                  setCount(
                    event.currentTarget.value.length === 0
                      ? null
                      : Number(event.currentTarget.value),
                  )
                }
              />
            </div>
            <div>
              <label for="event-until">Until</label>
              <input
                id="event-until"
                type="date"
                value={until()}
                onInput={(event) => setUntil(event.currentTarget.value)}
              />
            </div>
          </div>
          <Show when={freq() === "WEEKLY"}>
            <div class="calendar-dialog__chips">
              <For each={WEEKDAYS}>
                {(day) => (
                  <button
                    type="button"
                    class="calendar-dialog__chip"
                    aria-pressed={byDay().includes(day)}
                    onClick={() =>
                      setByDay((current) =>
                        current.includes(day)
                          ? current.filter((entry) => entry !== day)
                          : [...current, day],
                      )
                    }
                  >
                    {day}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <p class="calendar-dialog__hint">
            Count and Until are mutually exclusive; leave both empty for an
            open-ended series.
          </p>
        </Show>

        <div class="calendar-dialog__field">
          <label for="event-mention">Mentions</label>
          <div class="calendar-dialog__chips">
            <For each={mentions()}>
              {(address) => (
                <span class="calendar-dialog__chip">
                  {address}
                  <button
                    type="button"
                    aria-label={`Remove ${address}`}
                    onClick={() =>
                      setMentions((current) =>
                        current.filter((entry) => entry !== address),
                      )
                    }
                  >
                    x
                  </button>
                </span>
              )}
            </For>
          </div>
          <input
            id="event-mention"
            placeholder="name@example.com"
            value={mentionDraft()}
            onInput={(event) => setMentionDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addMention();
              }
            }}
            onBlur={addMention}
          />
          <p class="calendar-dialog__hint">
            A mention lets that person read the event. It is not an invitation:
            mailcal tracks no attendance status.
          </p>
        </div>

        <div class="calendar-dialog__field">
          <span class="calendar-dialog__grouplabel">Links</span>
          <div class="calendar-dialog__list">
            <For each={links()}>
              {(link, index) => (
                <div class="calendar-dialog__listrow">
                  <input
                    placeholder="https://example.com"
                    value={link.url}
                    onInput={(event) =>
                      setLinks((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, url: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <input
                    placeholder="Title"
                    value={link.title}
                    onInput={(event) =>
                      setLinks((current) =>
                        current.map((entry, position) =>
                          position === index()
                            ? { ...entry, title: event.currentTarget.value }
                            : entry,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setLinks((current) =>
                        current.filter(
                          (_entry, position) => position !== index(),
                        ),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </div>
          <button
            type="button"
            onClick={() => setLinks([...links(), { url: "", title: "" }])}
          >
            Add link
          </button>
        </div>

        <div class="calendar-dialog__field">
          <label for="event-file">Attachments</label>
          <div class="calendar-dialog__list">
            <For each={existing()?.attachments ?? []}>
              {(attachment) => (
                <div class="calendar-dialog__listrow">
                  <a href={attachment.url}>{attachment.fileName}</a>
                  <button
                    type="button"
                    onClick={() =>
                      void props.store.detachFile(
                        existing()?.id ?? "",
                        attachment.id,
                      )
                    }
                  >
                    Detach
                  </button>
                </div>
              )}
            </For>
          </div>
          <input
            id="event-file"
            type="file"
            onChange={(event) => void upload(event.currentTarget.files)}
          />
        </div>

        <div class="calendar-dialog__field">
          <label for="event-description">Notes</label>
          <textarea
            id="event-description"
            rows="3"
            value={description()}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </div>

        <div class="calendar-dialog__field">
          <label for="event-location">Location</label>
          <input
            id="event-location"
            value={location()}
            onInput={(event) => setLocation(event.currentTarget.value)}
          />
        </div>

        <Show when={isSeriesMember()}>
          <div class="calendar-dialog__field">
            <label for="event-scope">This change applies to</label>
            <select
              id="event-scope"
              value={editScope()}
              onChange={(event) =>
                setEditScope(event.currentTarget.value as EventEditScope)
              }
            >
              <option value="ENTIRE_SERIES">The entire series</option>
              <option value="THIS_OCCURRENCE">This occurrence only</option>
            </select>
          </div>
        </Show>

        <div class="calendar-dialog__actions">
          <Show when={existing() !== null}>
            <button
              type="button"
              class="danger"
              disabled={busy()}
              onClick={() => void remove()}
            >
              Delete
            </button>
          </Show>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="primary" disabled={busy()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
