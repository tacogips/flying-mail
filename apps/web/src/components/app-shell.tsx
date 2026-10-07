import { Show, type JSX } from "solid-js";
import "./app-shell.css";

/** Three-pane frame: sidebar, list, detail. Kept structural -- every pane's
 * content is supplied by the routed page, so a page can render a full-width
 * settings form by passing nothing for the list. */
export function AppShell(props: {
  readonly topbar: JSX.Element;
  readonly rail: JSX.Element;
  readonly sidebar: JSX.Element;
  readonly children: JSX.Element;
  readonly sidebarOpen: boolean;
  readonly messageOpen: boolean;
  readonly onCloseSidebar: () => void;
}): JSX.Element {
  return (
    <div
      classList={{
        "app-shell": true,
        "app-shell-sidebar-open": props.sidebarOpen,
        "app-shell-message-open": props.messageOpen,
      }}
    >
      {props.topbar}
      <div class="app-shell-body">
        <div class="app-shell-nav">
          {props.rail}
          {props.sidebar}
        </div>
        <Show when={props.sidebarOpen}>
          <button
            type="button"
            class="app-shell-backdrop"
            aria-label="Close mailbox menu"
            onClick={() => props.onCloseSidebar()}
          />
        </Show>
        <main class="app-shell-main">{props.children}</main>
      </div>
    </div>
  );
}
