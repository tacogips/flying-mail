import { createSignal, type JSX, Show } from "solid-js";
import type { ViewerView } from "../api/schema-types";
import { avatarClass, avatarInitial } from "../lib/avatar";
import { SearchIcon } from "./icons";
import "./topbar.css";

const SEARCH_HINT =
  "Search... (from: to: cc: has:attachment kind:pdf tag:name is:unread)";

export function Topbar(props: {
  readonly viewer: ViewerView | null;
  readonly onSearch: (query: string) => void;
  readonly onLogout: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal("");
  const isAdmin = () => props.viewer?.user?.role === "ADMIN";
  /** The catalogue link is shown to anyone who may read templates at all --
   * the page itself hides the editor without the write capabilities. */
  const canReadTemplates = () =>
    props.viewer?.capabilities.includes("TEMPLATE_READ") ?? false;
  const userLabel = () => {
    const user = props.viewer?.user;
    if (user === null || user === undefined) {
      return "";
    }
    const name = user.name.trim();
    return name.length > 0 ? name : user.email;
  };

  return (
    <header class="topbar">
      <form
        class="topbar-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSearch(query());
        }}
      >
        <span class="topbar-search-icon">
          <SearchIcon size={16} />
        </span>
        <input
          type="search"
          class="topbar-search-input"
          aria-label="Search mail"
          placeholder="Search messages"
          title={SEARCH_HINT}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </form>

      <div class="topbar-actions">
        <a href="/calendar" class="topbar-link">
          Calendar
        </a>
        <Show when={isAdmin()}>
          <a href="/settings/domains" class="topbar-link">
            Domains
          </a>
          <a href="/settings/api-keys" class="topbar-link">
            API keys
          </a>
          <a href="/settings/rules" class="topbar-link">
            Rules
          </a>
          <a href="/settings/users" class="topbar-link">
            Users
          </a>
        </Show>
        <a href="/settings/tags" class="topbar-link">
          Tags
        </a>
        <Show when={canReadTemplates()}>
          <a href="/settings/templates" class="topbar-link">
            Templates
          </a>
        </Show>
        <Show when={props.viewer?.user !== null && props.viewer !== null}>
          <button type="button" onClick={() => props.onLogout()}>
            Sign out
          </button>
        </Show>
        <Show when={props.viewer?.user !== null && props.viewer !== null}>
          <span
            class={`avatar topbar-avatar ${avatarClass(props.viewer?.user?.email ?? "")}`}
            title={props.viewer?.user?.email ?? ""}
          >
            {avatarInitial(userLabel())}
          </span>
        </Show>
      </div>
    </header>
  );
}
