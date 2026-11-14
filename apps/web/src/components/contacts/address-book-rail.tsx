import { For, type JSX, Show } from "solid-js";
import type {
  AddressBookGroup,
  ContactRailSelection,
} from "../../store/contact-store";

function isSameSelection(
  a: ContactRailSelection,
  b: ContactRailSelection,
): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "ADDRESS" && b.kind === "ADDRESS") {
    return a.mailAddressId === b.mailAddressId;
  }
  if (a.kind === "BOOK" && b.kind === "BOOK") {
    return a.addressBookId === b.addressBookId;
  }
  return true;
}

/** "All contacts" plus one entry per readable mail address, its books
 * nested underneath when the address has more than one. Groups come from
 * `contact-store.ts`'s `addressBookGroups`, itself derived from the single
 * unfiltered `addressBooks` query -- there is no separate "list of readable
 * addresses" endpoint, so an address with zero books simply has no entry
 * yet. */
export function AddressBookRail(props: {
  readonly groups: readonly AddressBookGroup[];
  readonly selection: ContactRailSelection;
  readonly onSelect: (selection: ContactRailSelection) => void;
}): JSX.Element {
  return (
    <nav class="contacts-rail" aria-label="Address books">
      <ul class="contacts-rail__group">
        <li>
          <button
            type="button"
            classList={{
              "contacts-rail__item": true,
              "contacts-rail__item--active": isSameSelection(props.selection, {
                kind: "ALL",
              }),
            }}
            onClick={() => props.onSelect({ kind: "ALL" })}
          >
            All contacts
          </button>
        </li>
      </ul>

      <ul class="contacts-rail__group">
        <For each={props.groups}>
          {(group) => (
            <li>
              <button
                type="button"
                classList={{
                  "contacts-rail__item": true,
                  "contacts-rail__item--active": isSameSelection(
                    props.selection,
                    { kind: "ADDRESS", mailAddressId: group.mailAddressId },
                  ),
                }}
                onClick={() =>
                  props.onSelect({
                    kind: "ADDRESS",
                    mailAddressId: group.mailAddressId,
                  })
                }
              >
                {group.address}
              </button>
              <Show when={group.books.length > 1}>
                <ul class="contacts-rail__nested">
                  <For each={group.books}>
                    {(book) => (
                      <li>
                        <button
                          type="button"
                          classList={{
                            "contacts-rail__item": true,
                            "contacts-rail__item--nested": true,
                            "contacts-rail__item--active": isSameSelection(
                              props.selection,
                              { kind: "BOOK", addressBookId: book.id },
                            ),
                          }}
                          onClick={() =>
                            props.onSelect({
                              kind: "BOOK",
                              addressBookId: book.id,
                            })
                          }
                        >
                          <span>{book.name}</span>
                          <span class="contacts-rail__count muted">
                            {book.contactCount}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.groups.length === 0}>
        <p class="contacts-rail__empty muted">
          No address books yet. A book appears here once its address has one.
        </p>
      </Show>
    </nav>
  );
}
