import { For, type JSX } from "solid-js";
import { activeToasts, dismissToast } from "../lib/toast";
import "./toast-shelf.css";

export function ToastShelf(): JSX.Element {
  return (
    <div class="toast-shelf" aria-live="polite">
      <For each={activeToasts()}>
        {(toast) => (
          <div class={`toast toast-${toast.kind}`}>
            <span>{toast.message}</span>
            <button
              type="button"
              class="toast-dismiss"
              aria-label="Dismiss"
              onClick={() => dismissToast(toast.id)}
            >
              x
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
