import type { JSX } from "solid-js";
import "./app-shell.css";

/** Three-pane frame: sidebar, list, detail. Kept structural -- every pane's
 * content is supplied by the routed page, so a page can render a full-width
 * settings form by passing nothing for the list. */
export function AppShell(props: {
  readonly topbar: JSX.Element;
  readonly sidebar: JSX.Element;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <div class="app-shell">
      {props.topbar}
      <div class="app-shell-body">
        {props.sidebar}
        <main class="app-shell-main">{props.children}</main>
      </div>
    </div>
  );
}
