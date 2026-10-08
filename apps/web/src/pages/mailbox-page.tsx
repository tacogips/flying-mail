import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  createEffect,
  createSignal,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { MESSAGE_QUERY, UNREAD_COUNT_QUERY } from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type {
  MessageDetailView,
  MessageView,
  TagView,
} from "../api/schema-types";
import type { LiveMessageEvent } from "../store/app-store";
import { AppShell } from "../components/app-shell";
import { DomainRail, domainForAddress } from "../components/domain-rail";
import { ComposeHost } from "../components/compose-host";
import { TemplateSendPanel } from "../components/template-send-panel";
import { EnvelopeIcon } from "../components/icons";
import { MailboxSidebar } from "../components/mailbox-sidebar";
import { MessageList } from "../components/message-list";
import { MessageView as MessageDetail } from "../components/message-view";
import { Topbar } from "../components/topbar";
import type { ComposeRequest } from "../lib/compose-types";
import {
  type MailboxView,
  type MailboxScope,
  searchParamsToView,
  viewTitle,
  fullSearchParamsForView,
} from "../lib/filter-params";
import { describeErrors } from "../lib/mutation-error";
import { readableActiveDomains } from "../lib/domain-rail";
import { pushToast } from "../lib/toast";
import { useStore } from "../store/store-context";
import "./mailbox-page.css";

export function applyLiveMessageEvent(
  active: MessageDetailView | null,
  event: LiveMessageEvent,
): { readonly active: MessageDetailView | null; readonly deleted: boolean } {
  if (event.type === "MESSAGE_UPDATED") {
    return {
      active:
        active !== null && active.id === event.message.id
          ? { ...active, ...event.message }
          : active,
      deleted: false,
    };
  }
  return active?.id === event.messageId
    ? { active: null, deleted: true }
    : { active, deleted: false };
}

export default function MailboxPage(): JSX.Element {
  const store = useStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [active, setActive] = createSignal<MessageDetailView | null>(null);
  const [activeDeleted, setActiveDeleted] = createSignal(false);
  const [unreadByDomain, setUnreadByDomain] = createSignal<
    Readonly<Record<string, number>>
  >({});
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [composeRequest, setComposeRequest] =
    createSignal<ComposeRequest | null>(null);
  const [templateSendOpen, setTemplateSendOpen] = createSignal(false);
  /** The catalogue is only fetched when the panel is actually opened: a
   * mailbox visitor who never sends from a template should not pay for it. */
  const canUseTemplates = (): boolean =>
    store.viewer()?.capabilities.includes("TEMPLATE_READ") ?? false;

  const unsubscribeLiveMessages = store.subscribeToLiveMessageEvents(
    (event) => {
      const result = applyLiveMessageEvent(active(), event);
      setActive(result.active);
      if (result.deleted) setActiveDeleted(true);
    },
  );
  onCleanup(unsubscribeLiveMessages);

  let unreadRequest = 0;
  createEffect(() => {
    // Re-fetch per-domain totals whenever the inbox count is refreshed after
    // a read or unread mutation.
    store.inboxUnreadCount();
    const domains = readableActiveDomains(
      store.domains(),
      store.viewer()?.readableAddresses ?? [],
    );
    const requestId = ++unreadRequest;
    void Promise.all(
      domains.map(async (domain) => {
        const result = await graphqlRequest<
          { readonly messages: { readonly totalCount: number } },
          Record<string, unknown>
        >(UNREAD_COUNT_QUERY, {
          filter: {
            direction: "INBOUND",
            domainId: domain.id,
            unreadOnly: true,
          },
        });
        return result.ok
          ? ([domain.id, result.data.messages.totalCount] as const)
          : null;
      }),
    ).then((counts) => {
      if (requestId !== unreadRequest) return;
      setUnreadByDomain(
        Object.fromEntries(counts.filter((entry) => entry !== null)),
      );
    });
  });
  function openTemplateSend(): void {
    void store.loadMailTemplates();
    setTemplateSendOpen(true);
  }

  // The URL is the source of truth for which mailbox is shown, so a
  // bookmark or a reload lands on the same view.
  createEffect(
    on(
      () =>
        new URLSearchParams(searchParams as Record<string, string>).toString(),
      () => {
        const view = searchParamsToView(
          new URLSearchParams(searchParams as Record<string, string>),
        );
        void store.setView(view);
      },
    ),
  );

  function selectView(view: MailboxView): void {
    setSidebarOpen(false);
    setActive(null);
    setActiveDeleted(false);
    setSearchParams(fullSearchParamsForView(view));
  }

  function selectScope(scope: MailboxScope): void {
    selectView({ folder: store.view().folder, scope });
  }

  const selectedDomainId = (): string | undefined => {
    const scope = store.view().scope;
    if (scope.domainId !== undefined) return scope.domainId;
    const address = scope.address;
    return address === undefined
      ? undefined
      : domainForAddress(address, store.domains())?.id;
  };

  async function openMessage(message: MessageView): Promise<void> {
    setSidebarOpen(false);
    setActiveDeleted(false);
    if (message.status === "DRAFT") {
      setActive(null);
      setComposeRequest({ kind: "DRAFT", messageId: message.id });
      return;
    }
    return openMessageById(message.id);
  }

  async function openMessageById(messageId: string): Promise<void> {
    setSidebarOpen(false);
    setActiveDeleted(false);
    const result = await graphqlRequest<
      { readonly message: MessageDetailView | null },
      Record<string, unknown>
    >(MESSAGE_QUERY, { id: messageId });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    if (result.data.message === null) {
      pushToast("error", "That message is no longer available");
      await store.reloadMessages();
      return;
    }
    if (result.data.message.status === "DRAFT") {
      setActive(null);
      setComposeRequest({ kind: "DRAFT", messageId });
      return;
    }
    setActive(result.data.message);
    if (result.data.message.readAt === null) {
      // Opening a message marks it read, matching every mail client; the
      // list is refreshed by the store so the unread styling clears.
      store.clearSelection();
      store.toggleSelection(messageId);
      await store.markSelectedRead(true);
      store.clearSelection();
    }
  }

  function startCompose(): void {
    setSidebarOpen(false);
    setActive(null);
    setComposeRequest({ kind: "NEW" });
  }

  async function deleteActive(): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    store.clearSelection();
    store.toggleSelection(message.id);
    await store.deleteSelected();
    setActive(null);
  }

  async function markActiveNotSpam(): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    store.clearSelection();
    store.toggleSelection(message.id);
    await store.markSelectedSpam(false);
    store.clearSelection();
    setActive({ ...message, isSpam: false });
  }

  async function markActiveSpam(): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    store.clearSelection();
    store.toggleSelection(message.id);
    await store.markSelectedSpam(true);
    store.clearSelection();
    setActive(null);
  }

  async function markActiveUnread(): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    store.clearSelection();
    store.toggleSelection(message.id);
    await store.markSelectedRead(false);
    store.clearSelection();
    setActive(null);
  }

  function patchActiveSystemTag(
    slug: "STARRED" | "ARCHIVED",
    tagged: boolean,
  ): void {
    const message = active();
    const tag = store.systemTag(slug);
    if (message === null || tag === null) {
      return;
    }
    const nextTags: readonly TagView[] = tagged
      ? [...message.tags, tag]
      : message.tags.filter((entry) => entry.id !== tag.id);
    setActive({ ...message, tags: nextTags });
  }

  async function toggleActiveStar(starred: boolean): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    const succeeded = await store.setStarred([message.id], starred);
    if (succeeded) {
      patchActiveSystemTag("STARRED", starred);
    }
  }

  async function toggleActiveArchive(archived: boolean): Promise<void> {
    const message = active();
    if (message === null) {
      return;
    }
    const succeeded = await store.setArchived([message.id], archived);
    if (succeeded) {
      patchActiveSystemTag("ARCHIVED", archived);
    }
  }

  return (
    <AppShell
      rail={
        <DomainRail
          domains={store.domains()}
          readableAddresses={store.viewer()?.readableAddresses ?? []}
          selectedDomainId={selectedDomainId()}
          allUnread={store.inboxUnreadCount()}
          unreadByDomain={unreadByDomain()}
          isAdmin={store.viewer()?.user?.role === "ADMIN"}
          onSelectDomain={(domainId) =>
            selectScope(domainId === undefined ? {} : { domainId })
          }
        />
      }
      sidebarOpen={sidebarOpen()}
      messageOpen={active() !== null}
      onCloseSidebar={() => setSidebarOpen(false)}
      topbar={
        <Topbar
          viewer={store.viewer()}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen())}
          onSearch={(query) =>
            selectView(
              query.trim().length === 0
                ? { folder: { kind: "INBOX" }, scope: store.view().scope }
                : {
                    folder: { kind: "SEARCH", query: query.trim() },
                    scope: store.view().scope,
                  },
            )
          }
          onLogout={() => {
            void store.logout().finally(() => navigate("/login"));
          }}
        />
      }
      sidebar={
        <MailboxSidebar
          current={store.view()}
          domains={store.domains()}
          readableAddresses={store.viewer()?.readableAddresses ?? []}
          tags={store.tags()}
          upcomingEvents={store.upcomingEvents()}
          inboxUnread={store.inboxUnreadCount()}
          onSelect={selectView}
          onSelectScope={selectScope}
          onOpenEvent={(messageId) => void openMessageById(messageId)}
          onCompose={startCompose}
          onComposeFromTemplate={
            canUseTemplates() ? openTemplateSend : undefined
          }
        />
      }
    >
      <MessageList
        title={viewTitle(store.view(), store.domains())}
        totalCount={store.totalCount()}
        unreadOnly={store.unreadOnly()}
        messages={store.messages()}
        selectedIds={store.selectedIds()}
        activeId={active()?.id ?? null}
        loading={store.loading()}
        hasMore={store.hasMore()}
        onOpen={(message) => void openMessage(message)}
        onToggleSelect={(id) => store.toggleSelection(id)}
        onToggleUnreadOnly={() => void store.setUnreadOnly(!store.unreadOnly())}
        onRefresh={() => void store.reloadMessages()}
        onSelectAll={(all) =>
          all ? store.selectAll() : store.clearSelection()
        }
        onMarkRead={(read) => void store.markSelectedRead(read)}
        onMarkSpam={(spam) => void store.markSelectedSpam(spam)}
        onArchive={() => {
          void store
            .setArchived([...store.selectedIds()], true)
            .then(() => store.clearSelection());
        }}
        onDelete={() => void store.deleteSelected()}
        onLoadMore={() => void store.loadMore()}
      />

      <Show
        when={active() !== null}
        fallback={
          <div class="mailbox-empty">
            <Show
              when={activeDeleted()}
              fallback={
                <>
                  <EnvelopeIcon size={48} />
                  <p>Select a message to read</p>
                  <p class="muted">or start a new one with New message</p>
                </>
              }
            >
              <p>This message was deleted</p>
            </Show>
          </div>
        }
      >
        <MessageDetail
          message={active() as MessageDetailView}
          onBack={() => setActive(null)}
          onReply={(replyAll) => {
            const message = active();
            if (message !== null) {
              setComposeRequest({
                kind: replyAll ? "REPLY_ALL" : "REPLY",
                messageId: message.id,
              });
            }
          }}
          onForward={() => {
            const message = active();
            if (message !== null) {
              setComposeRequest({ kind: "FORWARD", messageId: message.id });
            }
          }}
          onNotSpam={() => void markActiveNotSpam()}
          onMarkSpam={() => void markActiveSpam()}
          onMarkUnread={() => void markActiveUnread()}
          onDelete={() => void deleteActive()}
          onToggleStar={(starred) => void toggleActiveStar(starred)}
          onToggleArchive={(archived) => void toggleActiveArchive(archived)}
        />
      </Show>

      <Show when={templateSendOpen()}>
        <TemplateSendPanel
          templates={store.mailTemplates()}
          sendableAddresses={store.viewer()?.sendableAddresses ?? []}
          onValidate={(id, values) => store.validateTemplateValues(id, values)}
          onPreview={(id, values) => store.previewTemplate(id, values)}
          onSend={async (input) => {
            const sent = await store.sendTemplatedMessage(input);
            if (sent) {
              setTemplateSendOpen(false);
            }
            return sent;
          }}
          onClose={() => setTemplateSendOpen(false)}
        />
      </Show>

      <ComposeHost
        request={composeRequest()}
        scope={store.view().scope}
        onClose={() => setComposeRequest(null)}
        onMailboxChanged={() => void store.reloadMessages()}
      />
    </AppShell>
  );
}
