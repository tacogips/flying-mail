import { For, type JSX, Show } from "solid-js";
import type {
  MailDomainView,
  MessageEventView,
  SystemTagSlug,
  TagView,
} from "../api/schema-types";
import type { MailboxView } from "../lib/filter-params";
import {
  ArchiveIcon,
  FileIcon,
  FlameIcon,
  GearIcon,
  InboxIcon,
  type IconComponent,
  PaperPlaneIcon,
  StarIcon,
  TagIcon,
  TrashIcon,
} from "./icons";
import "./mailbox-sidebar.css";

const SYSTEM_VIEWS: readonly {
  readonly view: MailboxView;
  readonly label: string;
  readonly icon: IconComponent;
  /** System tags carry a message count from the `tags` prop; views without
   * one (Sent, Drafts, Spam) show no meta at all. */
  readonly slug?: SystemTagSlug;
}[] = [
  { view: { kind: "INBOX" }, label: "Inbox", icon: InboxIcon },
  {
    view: { kind: "STARRED" },
    label: "Starred",
    icon: StarIcon,
    slug: "STARRED",
  },
  { view: { kind: "SENT" }, label: "Sent", icon: PaperPlaneIcon },
  { view: { kind: "DRAFTS" }, label: "Drafts", icon: FileIcon },
  {
    view: { kind: "ARCHIVED" },
    label: "Archived",
    icon: ArchiveIcon,
    slug: "ARCHIVED",
  },
  { view: { kind: "SPAM" }, label: "Spam", icon: FlameIcon },
  {
    view: { kind: "TRASH" },
    label: "Trash",
    icon: TrashIcon,
    slug: "TRASH",
  },
];

function sameView(a: MailboxView, b: MailboxView): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "TAG" && b.kind === "TAG") {
    return a.tagId === b.tagId;
  }
  if (a.kind === "ADDRESS" && b.kind === "ADDRESS") {
    return a.address === b.address;
  }
  return true;
}

function dueLabel(value: string | null): string {
  if (value === null) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MailboxSidebar(props: {
  readonly current: MailboxView;
  readonly domains: readonly MailDomainView[];
  readonly tags: readonly TagView[];
  readonly upcomingEvents: readonly MessageEventView[];
  readonly inboxUnread: number;
  readonly onSelect: (view: MailboxView) => void;
  readonly onCompose: () => void;
  /** Absent for a viewer without TEMPLATE_READ, which hides the entry. */
  readonly onComposeFromTemplate?: (() => void) | undefined;
  readonly onOpenEvent: (messageId: string) => void;
}): JSX.Element {
  // System tags already have dedicated views above, so listing them again
  // under "Tags" would be a confusing duplicate.
  const userTags = () => props.tags.filter((tag) => tag.kind === "USER");
  const systemTagCount = (slug: SystemTagSlug): number =>
    props.tags.find((tag) => tag.kind === "SYSTEM" && tag.systemSlug === slug)
      ?.messageCount ?? 0;

  return (
    <nav class="mailbox-sidebar">
      <div class="sidebar-brand">mailcal</div>

      <button
        type="button"
        class="primary pill sidebar-compose"
        onClick={() => props.onCompose()}
      >
        New message
      </button>

      <Show when={props.onComposeFromTemplate !== undefined}>
        <button
          type="button"
          class="pill sidebar-compose sidebar-compose--secondary"
          onClick={() => props.onComposeFromTemplate?.()}
        >
          From template
        </button>
      </Show>

      <ul class="sidebar-group">
        <For each={SYSTEM_VIEWS}>
          {(entry) => (
            <li>
              <button
                type="button"
                classList={{
                  "sidebar-item": true,
                  "sidebar-item-active": sameView(props.current, entry.view),
                }}
                onClick={() => props.onSelect(entry.view)}
              >
                <span class="sidebar-item-icon">
                  <entry.icon size={16} />
                </span>
                <span class="sidebar-item-label">{entry.label}</span>
                <Show
                  when={entry.view.kind === "INBOX" && props.inboxUnread > 0}
                >
                  <span class="sidebar-badge">{props.inboxUnread}</span>
                </Show>
                <Show
                  when={
                    entry.slug !== undefined && systemTagCount(entry.slug) > 0
                  }
                >
                  <span class="sidebar-item-meta muted">
                    {entry.slug === undefined ? 0 : systemTagCount(entry.slug)}
                  </span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>

      <Show when={props.upcomingEvents.length > 0}>
        <h2 class="sidebar-heading">Upcoming</h2>
        <ul class="sidebar-group">
          <For each={props.upcomingEvents}>
            {(event) => (
              <li>
                <button
                  type="button"
                  class="sidebar-item sidebar-event"
                  title={event.message?.subject ?? event.title}
                  onClick={() => props.onOpenEvent(event.messageId)}
                >
                  <span class="sidebar-event-due">{dueLabel(event.dueAt)}</span>
                  <span class="sidebar-event-title">{event.title}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.domains.length > 0}>
        <h2 class="sidebar-heading">Domains</h2>
        <ul class="sidebar-group">
          <For each={props.domains}>
            {(domain) => (
              <li>
                <span class="sidebar-static">
                  {domain.name}
                  <span class="sidebar-item-meta muted">
                    {" "}
                    ({domain.messageCount})
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={userTags().length > 0}>
        <div class="sidebar-heading-row">
          <h2 class="sidebar-heading">Tags</h2>
          <a
            href="/settings/tags"
            class="sidebar-heading-action"
            aria-label="Manage tags"
          >
            <GearIcon size={14} />
          </a>
        </div>
        <ul class="sidebar-group">
          <For each={userTags()}>
            {(tag) => (
              <li>
                <button
                  type="button"
                  classList={{
                    "sidebar-item": true,
                    "sidebar-item-active": sameView(props.current, {
                      kind: "TAG",
                      tagId: tag.id,
                      name: tag.name,
                    }),
                  }}
                  onClick={() =>
                    props.onSelect({
                      kind: "TAG",
                      tagId: tag.id,
                      name: tag.name,
                    })
                  }
                >
                  <span
                    class="sidebar-item-icon"
                    style={
                      tag.color === null ? undefined : { color: tag.color }
                    }
                  >
                    <TagIcon size={16} />
                  </span>
                  <span class="sidebar-item-label">{tag.name}</span>
                  <span class="sidebar-item-meta muted">
                    {tag.messageCount}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </nav>
  );
}
