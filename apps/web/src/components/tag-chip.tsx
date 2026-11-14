import type { JSX } from "solid-js";
import type { TagView } from "../api/schema-types";
import "./tag-chip.css";

export function TagChip(props: {
  readonly tag: TagView;
  readonly onRemove?: () => void;
}): JSX.Element {
  return (
    <span
      class="tag-chip"
      style={
        props.tag.color === null
          ? undefined
          : { "border-color": props.tag.color, color: props.tag.color }
      }
    >
      {props.tag.name}
      {props.onRemove !== undefined ? (
        <button
          type="button"
          class="tag-chip-remove"
          aria-label={`Remove ${props.tag.name}`}
          onClick={() => props.onRemove?.()}
        >
          x
        </button>
      ) : null}
    </span>
  );
}
