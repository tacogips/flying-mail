import { useSearchParams } from "@solidjs/router";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { CONTACT_QUERY } from "../api/contact-documents";
import type { ContactView } from "../api/contact-types";
import { graphqlRequest } from "../api/graphql-client";
import { AddressBookRail } from "../components/contacts/address-book-rail";
import { CarddavSettings } from "../components/contacts/carddav-settings";
import { ContactDetail } from "../components/contacts/contact-detail";
import { ContactDialog } from "../components/contacts/contact-dialog";
import { ContactList } from "../components/contacts/contact-list";
import "../components/contacts/contacts.css";
import {
  type ContactDialogTarget,
  createContactStore,
} from "../store/contact-store";
import { useStore } from "../store/store-context";

/** The `/contacts` route.
 *
 * The contact store is created here rather than in the app-level store
 * context because it is only needed behind this lazy route. Mounting it
 * globally would make every mailbox visitor pay for state they never read. */
export default function ContactsPage(): JSX.Element {
  const appStore = useStore();
  const store = createContactStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedContactId, setSelectedContactId] = createSignal<string | null>(
    null,
  );
  const [deepLinkedContact, setDeepLinkedContact] =
    createSignal<ContactView | null>(null);
  const [showSettings, setShowSettings] = createSignal(false);

  const canWrite = (): boolean =>
    appStore.viewer()?.capabilities.includes("CONTACT_WRITE") ?? false;

  const selectedContact = (): ContactView | null => {
    const id = selectedContactId();
    if (id === null) {
      return null;
    }
    return (
      store.contacts().find((entry) => entry.id === id) ?? deepLinkedContact()
    );
  };

  /** Resolves a contact for the detail pane by id. The loaded page usually
   * already has it, but a `/contacts?contactId=...` deep link (from the
   * message-view lookup hook) may name a contact outside the current rail
   * selection or page, so a miss falls back to a direct `contact` query. */
  async function selectContactById(id: string): Promise<void> {
    setSelectedContactId(id);
    setSearchParams({ contactId: id });
    if (store.contacts().some((entry) => entry.id === id)) {
      setDeepLinkedContact(null);
      return;
    }
    const result = await graphqlRequest<
      { readonly contact: ContactView | null },
      { id: string }
    >(CONTACT_QUERY, { id });
    setDeepLinkedContact(result.ok ? result.data.contact : null);
  }

  onMount(() => {
    void (async () => {
      await store.loadAddressBooks();
      await store.loadContacts();
      const contactId = searchParams["contactId"];
      if (typeof contactId === "string" && contactId.length > 0) {
        await selectContactById(contactId);
      }
    })();
  });

  function defaultBookIdForSelection(): string | null {
    const selection = store.selection();
    const books = store.addressBooks();
    if (selection.kind === "BOOK") {
      return selection.addressBookId;
    }
    if (selection.kind === "ADDRESS") {
      const forAddress = books.filter(
        (book) => book.mailAddress.id === selection.mailAddressId,
      );
      return (
        forAddress.find((book) => book.isDefault)?.id ??
        forAddress[0]?.id ??
        null
      );
    }
    return books.find((book) => book.isDefault)?.id ?? books[0]?.id ?? null;
  }

  function newContactTarget(): ContactDialogTarget {
    return { contact: null, addressBookId: defaultBookIdForSelection() };
  }

  async function removeContact(contact: ContactView): Promise<void> {
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`Delete ${contact.displayName}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    const ok = await store.deleteContact(contact.id);
    if (ok && selectedContactId() === contact.id) {
      setSelectedContactId(null);
    }
  }

  return (
    <div class="contacts-page">
      <div class="contacts-toolbar">
        <h1>Contacts</h1>
        <span class="contacts-toolbar__spacer" />
        <button
          type="button"
          onClick={() => setShowSettings((current) => !current)}
        >
          {showSettings() ? "Hide CardDAV settings" : "CardDAV settings"}
        </button>
      </div>

      <div class="contacts-body">
        <AddressBookRail
          groups={store.addressBookGroups()}
          selection={store.selection()}
          onSelect={(selection) => void store.setSelection(selection)}
        />
        <ContactList
          contacts={store.contacts()}
          query={store.query()}
          loading={store.loading()}
          hasMore={store.hasMore()}
          totalCount={store.totalCount()}
          selectedContactId={selectedContactId()}
          canWrite={canWrite()}
          onQueryChange={(value) => void store.setQuery(value)}
          onSelect={(contact) => void selectContactById(contact.id)}
          onLoadMore={() => void store.loadMore()}
          onNewContact={() => store.openDialog(newContactTarget())}
        />
        <ContactDetail
          contact={selectedContact()}
          canWrite={canWrite()}
          onEdit={() => {
            const contact = selectedContact();
            if (contact !== null) {
              store.openDialog({
                contact,
                addressBookId: contact.addressBook.id,
              });
            }
          }}
          onDelete={() => {
            const contact = selectedContact();
            if (contact !== null) {
              void removeContact(contact);
            }
          }}
        />
      </div>

      <Show when={showSettings()}>
        <CarddavSettings store={store} addressBooks={store.addressBooks()} />
      </Show>

      <Show when={store.dialog()}>
        {(target) => (
          <ContactDialog
            store={store}
            addressBooks={store.addressBooks()}
            target={target()}
            onClose={() => store.closeDialog()}
          />
        )}
      </Show>
    </div>
  );
}
