import type { ConnectionStatus } from "@flying-mail/realtime-client";
import type { JSX } from "solid-js";
import "./connection-indicator.css";

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "live":
      return "Live";
    case "connecting":
    case "reconnecting":
      return "Reconnecting...";
    case "offline":
      return "Offline";
  }
}

export function ConnectionIndicator(props: {
  readonly status: ConnectionStatus;
}): JSX.Element {
  const label = (): string => statusLabel(props.status);
  return (
    <span
      class={`connection-indicator connection-indicator--${props.status}`}
      title={label()}
      role="status"
    >
      <span class="connection-indicator-dot" aria-hidden="true" />
      <span class="sr-only">{label()}</span>
    </span>
  );
}
