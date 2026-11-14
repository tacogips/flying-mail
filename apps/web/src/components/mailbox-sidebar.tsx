import { createEffect, createSignal, For, type JSX, Show } from "solid-js";
import type {
  MailDomainView,
  MessageEventView,
  SystemTagSlug,
  TagView,
} from "../api/schema-types";
import type {
  MailboxFolder,
  MailboxScope,
  MailboxView,
} from "../lib/filter-params";
import { addressDomain, readableActiveDomains } from "../lib/domain-rail";
import {
  readAddressListExpanded,
  visibleAddressActivity,
  writeAddressListExpanded,
} from "../lib/address-activity";
import type { AddressActivityView } from "../api/schema-types";
import { useStore } from "../store/store-context";
import { ConnectionIndicator } from "./connection-indicator";
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

const SYSTEM_FOLDERS: readonly {
  readonly folder: MailboxFolder;
  readonly label: string;
  readonly icon: IconComponent;
  readonly slug?: SystemTagSlug;
}[] = [
  { folder: { kind: "INBOX" }, label: "Inbox", icon: InboxIcon },
  {
    folder: { kind: "STARRED" },
    label: "Starred",
    icon: StarIcon,
    slug: "STARRED",
  },
  { folder: { kind: "SENT" }, label: "Sent", icon: PaperPlaneIcon },
  { folder: { kind: "DRAFTS" }, label: "Drafts", icon: FileIcon },
  {
    folder: { kind: "ARCHIVED" },
    label: "Archived",
    icon: ArchiveIcon,
    slug: "ARCHIVED",
  },
  { folder: { kind: "SPAM" }, label: "Spam", icon: FlameIcon },
  {
    folder: { kind: "TRASH" },
    label: "Trash",
    icon: TrashIcon,
    slug: "TRASH",
  },
];

function sameFolder(a: MailboxFolder, b: MailboxFolder): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "TAG" || (b.kind === "TAG" && a.tagId === b.tagId);
}

function sameScope(a: MailboxScope, b: MailboxScope): boolean {
  return a.domainId === b.domainId && a.address === b.address;
}

function dueLabel(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function MailboxSidebar(props: {
  readonly current: MailboxView;
  readonly domains: readonly MailDomainView[];
  readonly readableAddresses: readonly string[];
  readonly addressActivity?: readonly AddressActivityView[] | undefined;
  readonly tags: readonly TagView[];
  readonly upcomingEvents: readonly MessageEventView[];
  readonly inboxUnread: number;
  readonly onSelect: (view: MailboxView) => void;
  readonly onSelectScope: (scope: MailboxScope) => void;
  readonly onCompose: () => void;
  readonly onComposeFromTemplate?: (() => void) | undefined;
  readonly onOpenEvent: (messageId: string) => void;
}): JSX.Element {
  const store = useStore();
  const addressActivity = () =>
    props.addressActivity ?? store.viewer()?.addressActivity ?? [];
  const activeDomains = () =>
    readableActiveDomains(props.domains, props.readableAddresses);
  const selectedDomain = () =>
    activeDomains().find(
      (domain) => domain.id === props.current.scope.domainId,
    );
  const userTags = () => props.tags.filter((tag) => tag.kind === "USER");
  const [addressFilter, setAddressFilter] = createSignal("");
  const [addressListExpanded, setAddressListExpanded] = createSignal(
    readAddressListExpanded(browserStorage()),
  );
  createEffect(() => {
    selectedDomain()?.id;
    setAddressFilter("");
  });
  const systemTagCount = (slug: SystemTagSlug): number =>
    props.tags.find((tag) => tag.kind === "SYSTEM" && tag.systemSlug === slug)
      ?.messageCount ?? 0;
  const addressesForDomain = (name: string): readonly string[] =>
    props.readableAddresses.filter(
      (address) => addressDomain(address) === name.toLowerCase(),
    );
  const currentScope = (): MailboxScope => {
    const scope = props.current.scope;
    if (scope.domainId !== undefined || scope.address === undefined) {
      return scope;
    }
    const address = scope.address;
    const domain = props.domains.find((entry) =>
      addressesForDomain(entry.name).includes(address),
    );
    return domain === undefined ? scope : { ...scope, domainId: domain.id };
  };
  const scopedAddressActivity = () => {
    const domainId = selectedDomain()?.id;
    const selectedAddress = currentScope().address;
    return visibleAddressActivity(addressActivity(), {
      ...(domainId === undefined ? {} : { domainId }),
      ...(selectedAddress === undefined ? {} : { selectedAddress }),
      filter: scopedActivityCount() > 7 ? addressFilter() : "",
      expanded: addressListExpanded(),
    });
  };
  const scopedActivityCount = () =>
    addressActivity().filter(
      (row) =>
        selectedDomain() === undefined || row.domainId === selectedDomain()?.id,
    ).length;
  const filteredActivityCount = () => {
    const domainId = selectedDomain()?.id;
    const query =
      scopedActivityCount() > 7
        ? addressFilter().trim().toLocaleLowerCase()
        : "";
    return addressActivity().filter(
      (row) =>
        (domainId === undefined || row.domainId === domainId) &&
        (query.length === 0 || row.address.toLocaleLowerCase().includes(query)),
    ).length;
  };
  const selectFolder = (folder: MailboxFolder): void =>
    props.onSelect({ folder, scope: props.current.scope });

  return (
    <nav class="mailbox-sidebar">
      <div class="sidebar-brand">flying-mail</div>
      <div
        class="sidebar-domain-header"
        style={{
          display: "flex",
          "align-items": "center",
          gap: "8px",
          margin: "0 8px 12px",
        }}
      >
        <h1
          class="sidebar-domain-heading"
          style={{ flex: 1, "min-width": 0, margin: 0 }}
        >
          {props.domains.find((domain) => domain.id === currentScope().domainId)
            ?.name ?? "All mail"}
        </h1>
        <ConnectionIndicator status={store.liveStatus?.() ?? "offline"} />
      </div>
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

      <Show when={activeDomains().length > 0}>
        <h2 class="sidebar-heading">ADDRESSES</h2>
        <Show when={scopedActivityCount() > 7}>
          <input
            class="sidebar-address-filter"
            type="search"
            aria-label="Filter addresses"
            placeholder="Filter addresses"
            value={addressFilter()}
            onInput={(event) => setAddressFilter(event.currentTarget.value)}
          />
        </Show>
        <ul class="sidebar-group sidebar-address-list">
          <For each={scopedAddressActivity()}>
            {(activity) => {
              const separatorIndex = activity.address.lastIndexOf("@");
              const localPart =
                separatorIndex === -1
                  ? activity.address
                  : activity.address.slice(0, separatorIndex);
              const domainPart =
                separatorIndex === -1
                  ? ""
                  : activity.address.slice(separatorIndex);
              const mailboxScope = {
                domainId: activity.domainId,
                address: activity.address,
              };
              return (
                <li>
                  <button
                    type="button"
                    classList={{
                      "sidebar-item": true,
                      "sidebar-scope-mailbox": true,
                      "sidebar-scope-active": sameScope(
                        currentScope(),
                        mailboxScope,
                      ),
                    }}
                    onClick={() => props.onSelectScope(mailboxScope)}
                    title={activity.address}
                  >
                    <span class="sidebar-item-label">
                      <span class="sidebar-address-local-part">
                        {localPart}
                      </span>
                      <span class="sidebar-address-domain-part">
                        {domainPart}
                      </span>
                    </span>
                    <Show when={activity.unreadCount > 0}>
                      <span class="sidebar-badge">{activity.unreadCount}</span>
                    </Show>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={scopedActivityCount() > 7}>
          <button
            type="button"
            class="sidebar-address-expand"
            onClick={() => {
              const expanded = !addressListExpanded();
              setAddressListExpanded(expanded);
              writeAddressListExpanded(browserStorage(), expanded);
            }}
          >
            {addressListExpanded()
              ? "Show fewer"
              : `Show all (${filteredActivityCount()})`}
          </button>
        </Show>
      </Show>

      <h2 class="sidebar-heading">Mail</h2>
      <ul class="sidebar-group">
        <li>
          <button
            type="button"
            classList={{
              "sidebar-item": true,
              "sidebar-scope-active": sameScope(currentScope(), {}),
            }}
            onClick={() => props.onSelectScope({})}
          >
            <span class="sidebar-item-label">All mail</span>
          </button>
        </li>
        <For each={SYSTEM_FOLDERS}>
          {(entry) => (
            <li>
              <button
                type="button"
                classList={{
                  "sidebar-item": true,
                  "sidebar-item-active": sameFolder(
                    props.current.folder,
                    entry.folder,
                  ),
                }}
                onClick={() => selectFolder(entry.folder)}
              >
                <span class="sidebar-item-icon">
                  <entry.icon size={16} />
                </span>
                <span class="sidebar-item-label">{entry.label}</span>
                <Show
                  when={entry.folder.kind === "INBOX" && props.inboxUnread > 0}
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
            {(tag) => {
              const folder: MailboxFolder = {
                kind: "TAG",
                tagId: tag.id,
                name: tag.name,
              };
              return (
                <li>
                  <button
                    type="button"
                    classList={{
                      "sidebar-item": true,
                      "sidebar-item-active": sameFolder(
                        props.current.folder,
                        folder,
                      ),
                    }}
                    onClick={() => selectFolder(folder)}
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
              );
            }}
          </For>
        </ul>
      </Show>
    </nav>
  );
}
