import { createSignal, For, type JSX, Show } from "solid-js";
import {
  CREATE_MESSAGE_EVENT_MUTATION,
  DELETE_MESSAGE_EVENT_MUTATION,
  UPDATE_MESSAGE_EVENT_MUTATION,
} from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type { MessageEventKind, MessageEventView } from "../api/schema-types";
import { describeErrors } from "../lib/mutation-error";
import { pushToast } from "../lib/toast";
import "./event-panel.css";

const KIND_LABELS: Readonly<Record<MessageEventKind, string>> = {
  DEADLINE: "Deadline",
  REMINDER: "Reminder",
  FOLLOW_UP: "Follow up",
  OTHER: "Note",
};

/** Events attached to one message: the "reply by 10/1" panel. Owns its
 * list locally, seeded from the loaded message, so completing or deleting
 * an event does not require refetching the whole message. */
export function EventPanel(props: {
  readonly messageId: string;
  readonly initialEvents: readonly MessageEventView[];
}): JSX.Element {
  const [events, setEvents] = createSignal<readonly MessageEventView[]>(
    props.initialEvents,
  );
  const [adding, setAdding] = createSignal(false);
  const [kind, setKind] = createSignal<MessageEventKind>("DEADLINE");
  const [dueAt, setDueAt] = createSignal("");
  const [title, setTitle] = createSignal("");

  async function addEvent(event: Event): Promise<void> {
    event.preventDefault();
    if (title().trim().length === 0) {
      pushToast("error", "The event needs a title");
      return;
    }
    if (kind() === "DEADLINE" && dueAt() === "") {
      pushToast("error", "A deadline needs a date");
      return;
    }
    const result = await graphqlRequest<
      { readonly createMessageEvent: MessageEventView },
      Record<string, unknown>
    >(CREATE_MESSAGE_EVENT_MUTATION, {
      input: {
        messageId: props.messageId,
        kind: kind(),
        title: title(),
        ...(dueAt() === "" ? {} : { dueAt: new Date(dueAt()).toISOString() }),
      },
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setEvents((current) => [...current, result.data.createMessageEvent]);
    setTitle("");
    setDueAt("");
    setAdding(false);
  }

  async function toggleCompleted(entry: MessageEventView): Promise<void> {
    const result = await graphqlRequest<
      { readonly updateMessageEvent: MessageEventView },
      Record<string, unknown>
    >(UPDATE_MESSAGE_EVENT_MUTATION, {
      id: entry.id,
      input: { completed: entry.completedAt === null },
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setEvents((current) =>
      current.map((event) =>
        event.id === entry.id ? result.data.updateMessageEvent : event,
      ),
    );
  }

  async function remove(entry: MessageEventView): Promise<void> {
    const result = await graphqlRequest<
      { readonly deleteMessageEvent: boolean },
      Record<string, unknown>
    >(DELETE_MESSAGE_EVENT_MUTATION, { id: entry.id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setEvents((current) => current.filter((event) => event.id !== entry.id));
  }

  function dueLabel(value: string | null): string {
    if (value === null) {
      return "";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : date.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
  }

  return (
    <section class="event-panel" aria-label="Events">
      <header class="event-panel-header">
        <h2>Events</h2>
        <button type="button" onClick={() => setAdding(!adding())}>
          {adding() ? "Close" : "Add event"}
        </button>
      </header>

      <Show when={events().length > 0}>
        <ul class="event-list">
          <For each={events()}>
            {(entry) => (
              <li classList={{ done: entry.completedAt !== null }}>
                <label class="event-main">
                  <input
                    type="checkbox"
                    checked={entry.completedAt !== null}
                    onChange={() => void toggleCompleted(entry)}
                  />
                  <span class="event-kind">{KIND_LABELS[entry.kind]}</span>
                  <Show when={entry.dueAt !== null}>
                    <span class="event-due">{dueLabel(entry.dueAt)}</span>
                  </Show>
                  <span class="event-title">{entry.title}</span>
                </label>
                <button
                  type="button"
                  class="event-delete"
                  aria-label={`Delete event ${entry.title}`}
                  onClick={() => void remove(entry)}
                >
                  Delete
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={adding()}>
        <form class="event-add" onSubmit={(event) => void addEvent(event)}>
          <select
            aria-label="Event kind"
            value={kind()}
            onChange={(event) =>
              setKind(event.currentTarget.value as MessageEventKind)
            }
          >
            <For each={Object.keys(KIND_LABELS) as MessageEventKind[]}>
              {(value) => <option value={value}>{KIND_LABELS[value]}</option>}
            </For>
          </select>
          <input
            type="date"
            aria-label="Due date"
            value={dueAt()}
            onInput={(event) => setDueAt(event.currentTarget.value)}
          />
          <input
            type="text"
            aria-label="Event title"
            placeholder="e.g. reply"
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <button type="submit" class="primary">
            Add
          </button>
        </form>
      </Show>
    </section>
  );
}
