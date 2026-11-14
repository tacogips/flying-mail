import { createSignal, For, type JSX, Show } from "solid-js";
import type { ContactView } from "../../api/contact-types";
import { SearchIcon } from "../icons";

const SEARCH_DEBOUNCE_MS = 250;

/** Name-sorted list with a search box that drives the server-side
 * `ContactFilter.query` -- debounced client-side so every keystroke does
 * not round-trip, but never re-filtering an already-loaded page itself. */
export function ContactList(props: {
  readonly contacts: readonly ContactView[];
  readonly query: string;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly totalCount: number;
  readonly selectedContactId: string | null;
  readonly canWrite: boolean;
  readonly onQueryChange: (value: string) => void;
  readonly onSelect: (contact: ContactView) => void;
  readonly onLoadMore: () => void;
  readonly onNewContact: () => void;
}): JSX.Element {
  const [draft, setDraft] = createSignal(props.query);
  let debounceHandle: ReturnType<typeof setTimeout> | undefined;

  function onInput(value: string): void {
    setDraft(value);
    if (debounceHandle !== undefined) {
      clearTimeout(debounceHandle);
    }
    debounceHandle = setTimeout(
      () => props.onQueryChange(value),
      SEARCH_DEBOUNCE_MS,
    );
  }

  return (
    <div class="contacts-list">
      <div class="contacts-list__toolbar">
        <div class="contacts-list__search">
          <SearchIcon size={16} />
          <input
            type="search"
            placeholder="Search contacts"
            aria-label="Search contacts"
            value={draft()}
            onInput={(event) => onInput(event.currentTarget.value)}
          />
        </div>
        <Show when={props.canWrite}>
          <button
            type="button"
            class="primary"
            onClick={() => props.onNewContact()}
          >
            New contact
          </button>
        </Show>
      </div>

      <p class="contacts-list__count muted">{props.totalCount} contact(s)</p>

      <ul class="contacts-list__items">
        <For each={props.contacts}>
          {(contact) => (
            <li>
              <button
                type="button"
                classList={{
                  "contacts-list__item": true,
                  "contacts-list__item--active":
                    contact.id === props.selectedContactId,
                }}
                onClick={() => props.onSelect(contact)}
              >
                <span class="contacts-list__name">{contact.displayName}</span>
                <span class="contacts-list__book muted">
                  {contact.addressBook.mailAddress.address}
                </span>
                <Show when={contact.emails.length > 0}>
                  <div class="contacts-list__chips">
                    <For each={contact.emails.slice(0, 3)}>
                      {(email) => (
                        <span class="contacts-list__chip">{email.address}</span>
                      )}
                    </For>
                  </div>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.contacts.length === 0 && !props.loading}>
        <p class="empty">No contacts match.</p>
      </Show>

      <Show when={props.hasMore}>
        <button
          type="button"
          class="contacts-list__more"
          disabled={props.loading}
          onClick={() => props.onLoadMore()}
        >
          Load more
        </button>
      </Show>
    </div>
  );
}
