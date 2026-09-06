import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import type {
  AddressBookView,
  CarddavDiscoveredAddressBookView,
} from "../../api/contact-types";
import { pushToast } from "../../lib/toast";
import type { ContactStore } from "../../store/contact-store";

/** Connect an iCloud (or other CardDAV) account, link its collections to
 * local address books, and run a sync. The app-specific password is typed
 * here and sent once; nothing in this component reads it back because the
 * server never returns it. */
export function CarddavSettings(props: {
  readonly store: ContactStore;
  readonly addressBooks: readonly AddressBookView[];
}): JSX.Element {
  const [serverUrl, setServerUrl] = createSignal(
    "https://contacts.icloud.com/",
  );
  const [username, setUsername] = createSignal("");
  const [appPassword, setAppPassword] = createSignal("");
  const [discovered, setDiscovered] = createSignal<
    readonly CarddavDiscoveredAddressBookView[]
  >([]);
  const [activeAccountId, setActiveAccountId] = createSignal<string | null>(
    null,
  );
  const [bindTargets, setBindTargets] = createSignal<
    Readonly<Record<string, string>>
  >({});
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void props.store.loadCarddavAccounts();
  });

  /** The mail addresses a new `IMPORT_NEW` book can target: every address
   * behind an existing local book, deduplicated. Addresses with zero books
   * are not discoverable client-side without `DOMAIN_ADMIN` (see
   * `contact-store.ts`'s `groupAddressBooks`), so the very first book on an
   * instance still has to come from `createContact`. */
  function knownAddresses(): readonly AddressBookView["mailAddress"][] {
    const seen = new Map<string, AddressBookView["mailAddress"]>();
    for (const book of props.addressBooks) {
      if (!seen.has(book.mailAddress.id)) {
        seen.set(book.mailAddress.id, book.mailAddress);
      }
    }
    return [...seen.values()].sort((a, b) =>
      a.address.localeCompare(b.address),
    );
  }

  async function connect(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await props.store.connectCarddavAccount({
      serverUrl: serverUrl(),
      username: username(),
      appPassword: appPassword(),
    });
    setBusy(false);
    // Cleared whether or not the call succeeded: the field should never
    // keep a credential around after a submit.
    setAppPassword("");
    if (result === null) {
      return;
    }
    setActiveAccountId(result.account.id);
    setDiscovered(result.addressBooks);
    pushToast(
      "success",
      `Connected. Found ${result.addressBooks.length} address book(s).`,
    );
  }

  async function link(
    remote: CarddavDiscoveredAddressBookView,
    accountId: string,
  ): Promise<void> {
    const target = bindTargets()[remote.remoteUrl] ?? "";
    // The select value is `book:<id>` or `address:<id>`, encoding both which
    // kind of target was chosen and its id in one string, since `mode` alone
    // no longer determines the payload: `IMPORT_NEW` now needs the target
    // mail address, not just the absence of a book id.
    const separator = target.indexOf(":");
    if (separator <= 0) {
      pushToast("error", "Choose a local address book or a mail address first");
      return;
    }
    const kind = target.slice(0, separator);
    const value = target.slice(separator + 1);
    setBusy(true);
    const linked = await props.store.linkCarddavBook({
      accountId,
      remoteUrl: remote.remoteUrl,
      mode: kind === "book" ? "BIND_EXISTING" : "IMPORT_NEW",
      ...(kind === "book"
        ? { addressBookId: value }
        : { mailAddressId: value }),
      ...(remote.displayName === null
        ? {}
        : { displayName: remote.displayName }),
    });
    setBusy(false);
    if (linked !== null) {
      pushToast("success", "Address book linked. Run a sync to pull contacts.");
    }
  }

  async function sync(linkId: string): Promise<void> {
    setBusy(true);
    const result = await props.store.syncCarddavBook(linkId);
    setBusy(false);
    if (result === null) {
      return;
    }
    pushToast(
      result.warnings.length > 0 ? "info" : "success",
      `Pulled ${result.pulled}, pushed ${result.pushed}, deleted ${result.deleted}, skipped ${result.skipped}` +
        (result.conflictsResolvedRemoteWins > 0
          ? `; ${result.conflictsResolvedRemoteWins} conflict(s) resolved in the server's favor`
          : "") +
        (result.truncated ? "; more remains, sync again" : "") +
        (result.warnings.length > 0 ? `. ${result.warnings.join(" ")}` : ""),
    );
  }

  return (
    <section class="carddav-settings">
      <h3>CardDAV</h3>
      <form
        class="carddav-settings__row"
        onSubmit={(event) => void connect(event)}
      >
        <label>
          Server
          <input
            value={serverUrl()}
            onInput={(event) => setServerUrl(event.currentTarget.value)}
          />
        </label>
        <label>
          Apple ID
          <input
            value={username()}
            autocomplete="username"
            onInput={(event) => setUsername(event.currentTarget.value)}
          />
        </label>
        <label>
          App-specific password
          <input
            type="password"
            value={appPassword()}
            autocomplete="off"
            onInput={(event) => setAppPassword(event.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={busy()}>
          Connect
        </button>
      </form>

      <Show when={discovered().length > 0 && activeAccountId() !== null}>
        <div class="carddav-settings__account">
          <strong>Discovered address books</strong>
          <For each={discovered()}>
            {(remote) => (
              <div class="carddav-settings__row">
                <span>{remote.displayName ?? remote.remoteUrl}</span>
                <label>
                  Link to
                  <select
                    value={bindTargets()[remote.remoteUrl] ?? ""}
                    onChange={(event) =>
                      setBindTargets((current) => ({
                        ...current,
                        [remote.remoteUrl]: event.currentTarget.value,
                      }))
                    }
                  >
                    <option value="" disabled>
                      Choose a target
                    </option>
                    <For each={props.addressBooks}>
                      {(book) => (
                        <option value={`book:${book.id}`}>
                          {book.mailAddress.address} &mdash; {book.name}
                        </option>
                      )}
                    </For>
                    <For each={knownAddresses()}>
                      {(address) => (
                        <option value={`address:${address.id}`}>
                          New book under {address.address}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy()}
                  onClick={() => void link(remote, activeAccountId() ?? "")}
                >
                  Link
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      <For each={props.store.carddavAccounts()}>
        {(account) => (
          <div class="carddav-settings__account">
            <div class="carddav-settings__row">
              <strong>{account.username}</strong>
              <span>{account.serverUrl}</span>
              <button
                type="button"
                disabled={busy()}
                onClick={() =>
                  void props.store.loadCarddavRemoteBooks(account.id)
                }
              >
                Show linked books
              </button>
              <button
                type="button"
                disabled={busy()}
                onClick={() =>
                  void props.store.disconnectCarddavAccount(account.id)
                }
              >
                Disconnect
              </button>
            </div>
            <For
              each={props.store
                .carddavBookLinks()
                .filter((link) => link.accountId === account.id)}
            >
              {(linked) => (
                <div class="carddav-settings__row">
                  <span>{linked.displayName ?? linked.remoteUrl}</span>
                  <span>
                    {linked.lastSyncedAt === null
                      ? "never synced"
                      : `synced ${linked.lastSyncedAt}`}
                  </span>
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => void sync(linked.id)}
                  >
                    Sync now
                  </button>
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() =>
                      void props.store.unlinkCarddavBook(linked.id)
                    }
                  >
                    Unlink
                  </button>
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </section>
  );
}
