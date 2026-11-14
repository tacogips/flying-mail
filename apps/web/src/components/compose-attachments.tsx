import { For, Show, type JSX } from "solid-js";
import type { ComposeAttachmentChip } from "../lib/compose-types";
import { formatBytes } from "../lib/relative-time";
import "./compose-form.css";

export interface ComposeAttachmentsProps {
  readonly chips: readonly ComposeAttachmentChip[];
  readonly onRemove: (localKey: string) => void;
  readonly totalBytes: number;
  readonly maxTotalBytes: number;
}

export function ComposeAttachments(
  props: ComposeAttachmentsProps,
): JSX.Element {
  return (
    <div class="compose-attachments-wrap">
      <Show when={props.chips.length > 0}>
        <ul class="compose-attachments">
          <For each={props.chips}>
            {(chip) => (
              <li class="compose-attachment-chip">
                <span>{chip.fileName}</span>
                <span class="compose-attachment-size">
                  {formatBytes(chip.size)}
                </span>
                <Show when={chip.origin === "forward"}>
                  <span class="compose-forward-label">from original</span>
                </Show>
                <Show when={chip.status === "uploading"}>
                  <progress
                    max="100"
                    value={chip.progress}
                    aria-label={`Uploading ${chip.fileName}`}
                  />
                </Show>
                <Show when={chip.error !== undefined}>
                  <span class="compose-attachment-error">{chip.error}</span>
                </Show>
                <button
                  type="button"
                  aria-label={`Remove ${chip.fileName}`}
                  onClick={() => props.onRemove(chip.localKey)}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.totalBytes > props.maxTotalBytes}>
        <p class="compose-limit-warning" role="alert">
          Attachments exceed the {formatBytes(props.maxTotalBytes)} total limit.
        </p>
      </Show>
    </div>
  );
}
