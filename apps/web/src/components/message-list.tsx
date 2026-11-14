import { For, type JSX, Show } from "solid-js";
import type { MessageView } from "../api/schema-types";
import { shortMailbox } from "../lib/address-format";
import { avatarClass, avatarInitial } from "../lib/avatar";
import { formatListTime } from "../lib/relative-time";
import {
  ArchiveIcon,
  CheckIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  FlameIcon,
  PaperclipIcon,
  RefreshIcon,
  StarIcon,
  TrashIcon,
} from "./icons";
import { TagChip } from "./tag-chip";
import "./message-list.css";

function isStarred(message: MessageView): boolean {
  return message.tags.some(
    (tag) => tag.kind === "SYSTEM" && tag.systemSlug === "STARRED",
  );
}

export function MessageList(props: {
  readonly title: string;
  readonly totalCount: number;
  readonly unreadOnly: boolean;
  readonly messages: readonly MessageView[];
  readonly selectedIds: ReadonlySet<string>;
  readonly activeId: string | null;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly onOpen: (message: MessageView) => void;
  readonly onToggleSelect: (id: string) => void;
  readonly onToggleUnreadOnly: () => void;
  readonly onRefresh: () => void;
  readonly onSelectAll: (all: boolean) => void;
  readonly onMarkRead: (read: boolean) => void;
  readonly onMarkSpam: (spam: boolean) => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onLoadMore: () => void;
}): JSX.Element {
  const now = new Date();
  const allSelected = () =>
    props.messages.length > 0 &&
    props.messages.every((message) => props.selectedIds.has(message.id));

  return (
    <div class="message-list">
      <div class="message-list-header">
        <div class="message-list-header-row">
          <input
            type="checkbox"
            aria-label="Select all messages"
            checked={allSelected()}
            onChange={(event) => props.onSelectAll(event.currentTarget.checked)}
          />
          <strong>{props.title}</strong>
          <span class="muted message-list-count"> {props.totalCount}</span>
          <span class="message-list-spacer" />
          <button
            type="button"
            classList={{ pill: true, active: props.unreadOnly }}
            onClick={() => props.onToggleUnreadOnly()}
          >
            Unread
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => props.onRefresh()}
          >
            <RefreshIcon />
          </button>
        </div>
        <Show when={props.selectedIds.size > 0}>
          <div class="message-list-header-row message-list-bulk">
            <span class="muted">{props.selectedIds.size} selected</span>
            <span class="message-list-spacer" />
            <button
              type="button"
              class="icon-button"
              aria-label="Mark read"
              title="Mark read"
              onClick={() => props.onMarkRead(true)}
            >
              <EnvelopeOpenIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Mark unread"
              title="Mark unread"
              onClick={() => props.onMarkRead(false)}
            >
              <EnvelopeIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Archive"
              title="Archive"
              onClick={() => props.onArchive()}
            >
              <ArchiveIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Mark spam"
              title="Mark spam"
              onClick={() => props.onMarkSpam(true)}
            >
              <FlameIcon />
            </button>
            <button
              type="button"
              class="icon-button"
              aria-label="Not spam"
              title="Not spam"
              onClick={() => props.onMarkSpam(false)}
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              class="icon-button danger"
              aria-label="Delete"
              title="Delete"
              onClick={() => props.onDelete()}
            >
              <TrashIcon />
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={props.messages.length > 0 || props.loading}
        fallback={<p class="empty">No messages here.</p>}
      >
        <ul class="message-list-items">
          <For each={props.messages}>
            {(message) => {
              const unread = () => message.readAt === null;
              const userTags = () =>
                message.tags.filter((tag) => tag.kind === "USER");
              return (
                <li
                  classList={{
                    "message-row": true,
                    "message-row-unread": unread(),
                    "message-row-active": props.activeId === message.id,
                  }}
                >
                  <input
                    type="checkbox"
                    class="message-select"
                    aria-label={`Select ${message.subject}`}
                    checked={props.selectedIds.has(message.id)}
                    onChange={() => props.onToggleSelect(message.id)}
                  />
                  <span
                    class={`avatar ${avatarClass(message.from.address)} message-avatar`}
                  >
                    {avatarInitial(shortMailbox(message.from))}
                  </span>
                  <button
                    type="button"
                    class="message-open"
                    onClick={() => props.onOpen(message)}
                  >
                    <span class="message-line">
                      <span
                        classList={{
                          "message-from": true,
                          "message-from-unread": unread(),
                        }}
                      >
                        {shortMailbox(message.from)}
                      </span>
                      <span
                        classList={{
                          "message-time": true,
                          "message-time-unread": unread(),
                          muted: !unread(),
                        }}
                      >
                        {formatListTime(message.occurredAt, now)}
                      </span>
                    </span>
                    <span class="message-line">
                      <span
                        classList={{
                          "message-subject": true,
                          "message-subject-unread": unread(),
                        }}
                      >
                        {message.subject.length === 0
                          ? "(no subject)"
                          : message.subject}
                      </span>
                      <span class="message-line-icons">
                        <Show when={message.attachments.length > 0}>
                          <span
                            class="muted"
                            title={`${message.attachments.length} attachments`}
                          >
                            <PaperclipIcon size={14} />
                          </span>
                        </Show>
                        <Show when={isStarred(message)}>
                          <span class="message-star-icon">
                            <StarIcon size={14} filled />
                          </span>
                        </Show>
                      </span>
                    </span>
                    <span class="message-snippet muted">{message.snippet}</span>
                    <Show when={userTags().length > 0}>
                      <span class="message-tags">
                        <For each={userTags()}>
                          {(tag) => <TagChip tag={tag} />}
                        </For>
                      </span>
                    </Show>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={props.hasMore}>
        <button
          type="button"
          class="message-load-more"
          disabled={props.loading}
          onClick={() => props.onLoadMore()}
        >
          {props.loading ? "Loading..." : "Load more"}
        </button>
      </Show>
    </div>
  );
}
