import { useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, type JSX, on, Show } from "solid-js";
import { MESSAGE_QUERY } from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type {
  MessageDetailView,
  MessageView,
  SendMessageVariables,
  TagView,
} from "../api/schema-types";
import { AppShell } from "../components/app-shell";
import {
  type ComposeContent,
  type ComposeDraft,
  ComposeForm,
} from "../components/compose-form";
import { TemplateSendPanel } from "../components/template-send-panel";
import { EnvelopeIcon } from "../components/icons";
import { MailboxSidebar } from "../components/mailbox-sidebar";
import { MessageList } from "../components/message-list";
import { MessageView as MessageDetail } from "../components/message-view";
import { Topbar } from "../components/topbar";
import { buildReplyRecipients } from "../lib/address-format";
import {
  type MailboxView,
  searchParamsToView,
  viewTitle,
  viewToSearchParams,
} from "../lib/filter-params";
import { describeErrors } from "../lib/mutation-error";
import {
  forwardBody,
  forwardSubject,
  quoteBody,
  replySubject,
} from "../lib/quote-reply";
import { pushToast } from "../lib/toast";
import { useStore } from "../store/store-context";
import "./mailbox-page.css";

const EMPTY_DRAFT: ComposeDraft = {
  from: "",
  to: "",
  cc: "",
  subject: "",
  text: "",
};

export default function MailboxPage(): JSX.Element {
  const store = useStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [active, setActive] = createSignal<MessageDetailView | null>(null);
  const [draft, setDraft] = createSignal<ComposeDraft | null>(null);
  const [templateSendOpen, setTemplateSendOpen] = createSignal(false);
  /** The catalogue is only fetched when the panel is actually opened: a
   * mailbox visitor who never sends from a template should not pay for it. */
  const canUseTemplates = (): boolean =>
    store.viewer()?.capabilities.includes("TEMPLATE_READ") ?? false;
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
    setActive(null);
    setSearchParams(Object.fromEntries(viewToSearchParams(view)));
  }

  async function openMessage(message: MessageView): Promise<void> {
    return openMessageById(message.id);
  }

  async function openMessageById(messageId: string): Promise<void> {
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
      const detail = result.data.message;
      const joined = (kind: string): string =>
        detail.recipients
          .filter((recipient) => recipient.kind === kind)
          .map((recipient) => recipient.address)
          .join(", ");
      setActive(null);
      setDraft({
        draftId: detail.id,
        from: detail.from.address,
        to: joined("TO"),
        cc: joined("CC"),
        subject: detail.subject,
        text: detail.textBody ?? "",
      });
      return;
    }
    setActive(result.data.message);
    setDraft(null);
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
    const sender = store.viewer()?.sendableAddresses[0] ?? "";
    setActive(null);
    setDraft({ ...EMPTY_DRAFT, from: sender });
  }

  /** The mailbox that received a message, used as the sender for a reply
   * or forward: the envelope recipient when known, else the reader's
   * first sendable address. */
  function resolveSelfAddress(message: MessageDetailView): string | null {
    const viewer = store.viewer();
    const envelope = message.recipients.find(
      (recipient) => recipient.kind === "ENVELOPE",
    );
    return envelope?.address ?? viewer?.sendableAddresses[0] ?? null;
  }

  function startReply(replyAll: boolean): void {
    const message = active();
    if (message === null) {
      return;
    }
    const viewer = store.viewer();
    const self = resolveSelfAddress(message);
    const { to, cc } = buildReplyRecipients({
      from: message.from,
      recipients: message.recipients,
      replyAll,
      selfAddress: self,
    });
    setDraft({
      from: self ?? viewer?.sendableAddresses[0] ?? "",
      to: to.join(", "),
      cc: cc.join(", "),
      subject: replySubject(message.subject),
      text: quoteBody(message),
      inReplyToMessageId: message.id,
    });
  }

  function startForward(): void {
    const message = active();
    if (message === null) {
      return;
    }
    const viewer = store.viewer();
    const self = resolveSelfAddress(message);
    setDraft({
      from: self ?? viewer?.sendableAddresses[0] ?? "",
      to: "",
      cc: "",
      subject: forwardSubject(message.subject),
      text: forwardBody(message),
    });
  }

  async function send(input: SendMessageVariables): Promise<boolean> {
    const sent = await store.send(input);
    if (sent) {
      await store.reloadMessages();
    }
    return sent;
  }

  async function saveDraft(content: ComposeContent): Promise<string | null> {
    const saved = await store.saveDraft({
      from: content.from,
      to: content.to,
      cc: content.cc,
      subject: content.subject,
      text: content.text,
      ...(content.draftId === undefined ? {} : { draftId: content.draftId }),
      ...(content.inReplyToMessageId === undefined
        ? {}
        : { inReplyToMessageId: content.inReplyToMessageId }),
      ...(content.attachmentIds.length > 0
        ? { attachmentIds: content.attachmentIds }
        : {}),
    });
    if (saved !== null) {
      await store.reloadMessages();
    }
    return saved?.id ?? null;
  }

  /** Send for a stored draft: persist the latest edits first, then
   * dispatch, so what goes out is what is on screen. */
  async function sendDraft(content: ComposeContent): Promise<boolean> {
    const savedId = await saveDraft(content);
    if (savedId === null) {
      return false;
    }
    const sent = await store.sendDraft(savedId);
    if (sent) {
      await store.reloadMessages();
    }
    return sent;
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
      topbar={
        <Topbar
          viewer={store.viewer()}
          onSearch={(query) =>
            selectView(
              query.trim().length === 0
                ? { kind: "INBOX" }
                : { kind: "SEARCH", query: query.trim() },
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
          tags={store.tags()}
          upcomingEvents={store.upcomingEvents()}
          inboxUnread={store.inboxUnreadCount()}
          onSelect={selectView}
          onOpenEvent={(messageId) => void openMessageById(messageId)}
          onCompose={startCompose}
          onComposeFromTemplate={
            canUseTemplates() ? openTemplateSend : undefined
          }
        />
      }
    >
      <MessageList
        title={viewTitle(store.view())}
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
            <EnvelopeIcon size={48} />
            <p>Select a message to read</p>
            <p class="muted">or start a new one with New message</p>
          </div>
        }
      >
        <MessageDetail
          message={active() as MessageDetailView}
          onReply={startReply}
          onForward={startForward}
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

      <Show when={draft() !== null}>
        <ComposeForm
          draft={draft() as ComposeDraft}
          sendableAddresses={store.viewer()?.sendableAddresses ?? []}
          onCancel={() => setDraft(null)}
          onSend={send}
          onSaveDraft={saveDraft}
          onSendDraft={sendDraft}
        />
      </Show>
    </AppShell>
  );
}
