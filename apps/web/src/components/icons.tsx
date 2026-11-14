import type { JSX } from "solid-js";

/**
 * Small presentational SVG icons, feather-icons-like: a 24x24 viewBox,
 * stroke-based paths, and a `size` prop so callers can scale them inline
 * without reaching for CSS. Purely decorative -- callers that use an icon
 * as the entire content of a button are responsible for an `aria-label` on
 * that button.
 */

interface IconProps {
  readonly size?: number;
}

/** Shape shared by every plain icon component here (excludes `StarIcon`,
 * which takes an extra `filled` prop), so callers can hold one in a table
 * and render it dynamically. */
export type IconComponent = (props: IconProps) => JSX.Element;

function svgProps(size: number | undefined) {
  const dimension = size ?? 16;
  return {
    width: dimension,
    height: dimension,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
    "aria-hidden": "true" as const,
  };
}

export function InboxIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

export function FileIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function PaperPlaneIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function StarIcon(
  props: IconProps & { readonly filled?: boolean },
): JSX.Element {
  return (
    <svg
      {...svgProps(props.size)}
      aria-hidden="true"
      fill={props.filled === true ? "currentColor" : "none"}
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

export function ArchiveIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

export function FlameIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

export function TagIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function PaperclipIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L9.64 17.5a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function ReplyIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

export function ReplyAllIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="13 17 8 12 13 7" />
      <polyline points="19 17 14 12 19 7" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </svg>
  );
}

export function ForwardIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="15 17 20 12 15 7" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function EnvelopeIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="22 6 12 13 2 6" />
    </svg>
  );
}

export function EnvelopeOpenIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M22 13V7l-10-5L2 7v13a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7" />
      <polyline points="22 7 12 13 2 7" />
    </svg>
  );
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function MinusIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function GearIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function DownloadIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg {...svgProps(props.size)} aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
