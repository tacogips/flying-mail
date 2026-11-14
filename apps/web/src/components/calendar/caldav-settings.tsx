import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import type {
  CaldavDiscoveredCalendarView,
  CalendarView,
} from "../../api/calendar-types";
import { pushToast } from "../../lib/toast";
import type { CalendarStore } from "../../store/calendar-store";

/** Connect an iCloud (or other CalDAV) account, link its collections to
 * local calendars, and run a sync.
 *
 * The app-specific password is typed here and sent once; nothing in this
 * component ever reads it back, because the server never returns it. */
export function CaldavSettings(props: {
  readonly store: CalendarStore;
  readonly calendars: readonly CalendarView[];
}): JSX.Element {
  const [serverUrl, setServerUrl] = createSignal("https://caldav.icloud.com/");
  const [username, setUsername] = createSignal("");
  const [appPassword, setAppPassword] = createSignal("");
  const [discovered, setDiscovered] = createSignal<
    readonly CaldavDiscoveredCalendarView[]
  >([]);
  const [activeAccountId, setActiveAccountId] = createSignal<string | null>(
    null,
  );
  const [bindTargets, setBindTargets] = createSignal<
    Readonly<Record<string, string>>
  >({});
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void props.store.loadCaldavAccounts();
  });

  async function connect(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await props.store.connectCaldavAccount({
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
    setDiscovered(result.calendars);
    pushToast(
      "success",
      `Connected. Found ${result.calendars.length} calendar(s).`,
    );
  }

  async function link(
    remote: CaldavDiscoveredCalendarView,
    accountId: string,
  ): Promise<void> {
    const target = bindTargets()[remote.remoteUrl] ?? "";
    setBusy(true);
    const linked = await props.store.linkCaldavCalendar({
      accountId,
      remoteUrl: remote.remoteUrl,
      mode: target.length === 0 ? "IMPORT_NEW" : "BIND_EXISTING",
      ...(target.length === 0 ? {} : { calendarId: target }),
      ...(remote.displayName === null
        ? {}
        : { displayName: remote.displayName }),
    });
    setBusy(false);
    if (linked !== null) {
      pushToast("success", "Calendar linked. Run a sync to pull events.");
    }
  }

  async function sync(calendarId: string): Promise<void> {
    setBusy(true);
    const result = await props.store.syncCalendar(calendarId);
    setBusy(false);
    if (result === null) {
      return;
    }
    pushToast(
      result.warnings.length > 0 ? "info" : "success",
      `Pulled ${result.pulled}, pushed ${result.pushed}, deleted ${result.deleted}` +
        (result.conflictsResolvedRemoteWins > 0
          ? `; ${result.conflictsResolvedRemoteWins} conflict(s) resolved in the server's favor`
          : "") +
        (result.truncated ? "; more remains, sync again" : "") +
        (result.warnings.length > 0 ? `. ${result.warnings.join(" ")}` : ""),
    );
  }

  return (
    <section class="caldav-settings">
      <h3>CalDAV</h3>
      <form
        class="caldav-settings__row"
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
        <div class="caldav-settings__account">
          <strong>Discovered collections</strong>
          <For each={discovered()}>
            {(remote) => (
              <div class="caldav-settings__row">
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
                    <option value="">Create a new calendar</option>
                    <For each={props.calendars}>
                      {(calendar) => (
                        <option value={calendar.id}>{calendar.name}</option>
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

      <For each={props.store.caldavAccounts()}>
        {(account) => (
          <div class="caldav-settings__account">
            <div class="caldav-settings__row">
              <strong>{account.username}</strong>
              <span>{account.serverUrl}</span>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void props.store.loadCaldavCalendars(account.id)}
              >
                Show linked calendars
              </button>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void props.store.deleteCaldavAccount(account.id)}
              >
                Disconnect
              </button>
            </div>
            <For
              each={props.store
                .caldavCalendars()
                .filter((link) => link.accountId === account.id)}
            >
              {(linked) => (
                <div class="caldav-settings__row">
                  <span>{linked.displayName ?? linked.remoteUrl}</span>
                  <span>
                    {linked.lastSyncedAt === null
                      ? "never synced"
                      : `synced ${linked.lastSyncedAt}`}
                  </span>
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => void sync(linked.calendarId)}
                  >
                    Sync now
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
