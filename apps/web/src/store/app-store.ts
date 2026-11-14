import { createSignal } from "solid-js";
import {
  graphqlRequest,
  type GraphQLResult,
  sessionStore,
} from "../api/graphql-client";
import {
  MAIL_TEMPLATES_QUERY,
  MAIL_TEMPLATE_VALIDATION_QUERY,
  PREVIEW_MAIL_TEMPLATE_QUERY,
  SEND_TEMPLATED_MESSAGE_MUTATION,
  DELETE_MESSAGES_MUTATION,
  DOMAINS_QUERY,
  CREATE_MESSAGE_EVENT_MUTATION,
  DELETE_MESSAGE_EVENT_MUTATION,
  LOGOUT_MUTATION,
  SAVE_DRAFT_MUTATION,
  SEND_DRAFT_MUTATION,
  UNREAD_COUNT_QUERY,
  UPCOMING_EVENTS_QUERY,
  UPDATE_MESSAGE_EVENT_MUTATION,
  MARK_NOT_SPAM_MUTATION,
  MARK_READ_MUTATION,
  MARK_SPAM_MUTATION,
  MESSAGES_QUERY,
  SEND_MESSAGE_MUTATION,
  TAG_MESSAGES_MUTATION,
  TAGS_QUERY,
  UNTAG_MESSAGES_MUTATION,
  VIEWER_QUERY,
} from "../api/documents";
import type {
  MailTemplateView,
  RenderedTemplateView,
  SendTemplatedMessageVariables,
  TemplateValidationView,
  TemplateValueInput,
  MessageEventKind,
  MessageEventView,
  MailDomainView,
  MessagePageView,
  MessageView,
  SendMessageVariables,
  SystemTagSlug,
  TagView,
  ViewerView,
} from "../api/schema-types";
import { type MailboxView, viewToFilter } from "../lib/filter-params";
import { describeErrors } from "../lib/mutation-error";
import { pushToast } from "../lib/toast";

const PAGE_SIZE = 50;

export interface AppStore {
  readonly viewer: () => ViewerView | null;
  readonly domains: () => readonly MailDomainView[];
  readonly tags: () => readonly TagView[];
  readonly messages: () => readonly MessageView[];
  readonly totalCount: () => number;
  readonly hasMore: () => boolean;
  readonly loading: () => boolean;
  readonly selectedIds: () => ReadonlySet<string>;
  readonly view: () => MailboxView;
  readonly unreadOnly: () => boolean;
  readonly inboxUnreadCount: () => number;
  readonly upcomingEvents: () => readonly MessageEventView[];
  reloadUpcomingEvents(): Promise<void>;

  rehydrateSession(): Promise<void>;
  loadReferenceData(): Promise<void>;
  setView(view: MailboxView): Promise<void>;
  setUnreadOnly(value: boolean): Promise<void>;
  reloadMessages(): Promise<void>;
  loadMore(): Promise<void>;

  toggleSelection(id: string): void;
  clearSelection(): void;
  selectAll(): void;

  systemTag(slug: SystemTagSlug): TagView | null;
  tagSelected(tagIds: readonly string[]): Promise<void>;
  untagSelected(tagIds: readonly string[]): Promise<void>;
  markSelectedSpam(spam: boolean): Promise<void>;
  markSelectedRead(read: boolean): Promise<void>;
  deleteSelected(): Promise<void>;
  setStarred(messageIds: readonly string[], starred: boolean): Promise<boolean>;
  setArchived(
    messageIds: readonly string[],
    archived: boolean,
  ): Promise<boolean>;
  send(input: SendMessageVariables): Promise<boolean>;
  saveDraft(input: SaveDraftVariables): Promise<MessageView | null>;
  sendDraft(id: string): Promise<boolean>;
  createMessageEvent(
    input: CreateMessageEventVariables,
  ): Promise<MessageEventView | null>;
  updateMessageEvent(
    id: string,
    input: UpdateMessageEventVariables,
  ): Promise<MessageEventView | null>;
  deleteMessageEvent(id: string): Promise<boolean>;
  logout(): Promise<void>;

  // --- mail templates ---
  readonly mailTemplates: () => readonly MailTemplateView[];
  loadMailTemplates(): Promise<void>;
  validateTemplateValues(
    id: string,
    values: readonly TemplateValueInput[],
  ): Promise<TemplateValidationView | null>;
  previewTemplate(
    id: string,
    values: readonly TemplateValueInput[],
  ): Promise<RenderedTemplateView | null>;
  sendTemplatedMessage(input: SendTemplatedMessageVariables): Promise<boolean>;
}

export interface SaveDraftVariables {
  readonly draftId?: string;
  readonly inReplyToMessageId?: string;
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string;
  readonly text?: string;
  readonly attachmentIds?: readonly string[];
}

export interface CreateMessageEventVariables {
  readonly messageId: string;
  readonly kind: MessageEventKind;
  readonly dueAt?: string;
  readonly title: string;
  readonly note?: string;
}

export interface UpdateMessageEventVariables {
  readonly kind?: MessageEventKind;
  readonly dueAt?: string | null;
  readonly title?: string;
  readonly note?: string | null;
  readonly completed?: boolean;
}

/** Applies an optimistic patch to the loaded messages and returns a rollback
 * closure.
 *
 * Tag, read and spam toggles are frequent and individually cheap, so waiting
 * for a round trip before showing the change makes the client feel broken.
 * Rolling back on failure keeps the list honest when the server disagrees. */
function optimisticPatch(
  setMessages: (
    updater: (current: readonly MessageView[]) => readonly MessageView[],
  ) => void,
  current: readonly MessageView[],
  ids: ReadonlySet<string>,
  patch: (message: MessageView) => MessageView,
): () => void {
  const before = current;
  setMessages((messages) =>
    messages.map((message) => (ids.has(message.id) ? patch(message) : message)),
  );
  return () => setMessages(() => before);
}

export function createAppStore(): AppStore {
  const [viewer, setViewer] = createSignal<ViewerView | null>(null);
  const [domains, setDomains] = createSignal<readonly MailDomainView[]>([]);
  const [tags, setTags] = createSignal<readonly TagView[]>([]);
  const [messages, setMessages] = createSignal<readonly MessageView[]>([]);
  const [upcomingEvents, setUpcomingEvents] = createSignal<
    readonly MessageEventView[]
  >([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [totalCount, setTotalCount] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [mailTemplates, setMailTemplates] = createSignal<
    readonly MailTemplateView[]
  >([]);
  const [view, setViewSignal] = createSignal<MailboxView>({ kind: "INBOX" });
  const [unreadOnly, setUnreadOnlySignal] = createSignal(false);
  const [inboxUnreadCount, setInboxUnreadCount] = createSignal(0);

  function reportFailure(result: GraphQLResult<unknown>): boolean {
    if (result.ok) {
      return false;
    }
    pushToast("error", describeErrors(result.errors));
    return true;
  }

  async function fetchPage(after: string | null): Promise<void> {
    setLoading(true);
    const result = await graphqlRequest<
      { readonly messages: MessagePageView },
      Record<string, unknown>
    >(MESSAGES_QUERY, {
      filter: {
        ...viewToFilter(view(), tags()),
        ...(unreadOnly() ? { unreadOnly: true } : {}),
      },
      first: PAGE_SIZE,
      after,
    });
    setLoading(false);
    if (reportFailure(result)) {
      return;
    }
    if (!result.ok) {
      return;
    }
    const page = result.data.messages;
    setMessages((current) =>
      after === null ? page.nodes : [...current, ...page.nodes],
    );
    setCursor(page.nextCursor);
    setTotalCount(page.totalCount);
  }

  async function mutateSelected<TData>(
    document: string,
    variables: Record<string, unknown>,
    optimistic: (message: MessageView) => MessageView,
  ): Promise<boolean> {
    const ids = selectedIds();
    if (ids.size === 0) {
      return false;
    }
    const rollback = optimisticPatch(setMessages, messages(), ids, optimistic);
    const result = await graphqlRequest<TData, Record<string, unknown>>(
      document,
      variables,
    );
    if (!result.ok) {
      rollback();
      pushToast("error", describeErrors(result.errors));
      return false;
    }
    // Re-reads the page so counts and any server-side reclassification
    // (spam leaving the inbox, for instance) are reflected.
    await fetchPage(null);
    return true;
  }

  /** Everything due in the next 30 days, open items only. */
  async function reloadUpcomingEvents(): Promise<void> {
    const dueBefore = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = await graphqlRequest<
      { readonly messageEvents: readonly MessageEventView[] },
      Record<string, unknown>
    >(UPCOMING_EVENTS_QUERY, { dueBefore });
    if (result.ok) {
      setUpcomingEvents(result.data.messageEvents);
    }
  }

  /** Re-runs the tags query so system-tag counts (Starred, Archived,
   * Trash) and user-tag counts stay in sync after a mutation, shared by
   * initial load and the star/archive toggles. */
  async function reloadTags(): Promise<void> {
    const result = await graphqlRequest<{
      readonly tags: readonly TagView[];
    }>(TAGS_QUERY);
    if (result.ok) {
      setTags(result.data.tags);
    }
  }

  /** Best-effort inbox unread count for the sidebar badge: a stale or
   * missing count is a cosmetic problem, not worth a toast. */
  async function reloadInboxUnread(): Promise<void> {
    const result = await graphqlRequest<
      { readonly messages: MessagePageView },
      Record<string, unknown>
    >(UNREAD_COUNT_QUERY, {
      filter: { direction: "INBOUND", unreadOnly: true },
    });
    if (result.ok) {
      setInboxUnreadCount(result.data.messages.totalCount);
    }
  }

  function findSystemTag(slug: SystemTagSlug): TagView | null {
    return (
      tags().find((tag) => tag.kind === "SYSTEM" && tag.systemSlug === slug) ??
      null
    );
  }

  async function setSystemTagged(
    messageIds: readonly string[],
    slug: SystemTagSlug,
    tagged: boolean,
    missingTagMessage: string,
  ): Promise<boolean> {
    if (messageIds.length === 0) {
      return false;
    }
    const tag = findSystemTag(slug);
    if (tag === null) {
      pushToast("error", missingTagMessage);
      return false;
    }
    const document = tagged ? TAG_MESSAGES_MUTATION : UNTAG_MESSAGES_MUTATION;
    const result = await graphqlRequest<unknown, Record<string, unknown>>(
      document,
      { messageIds, tagIds: [tag.id] },
    );
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return false;
    }
    await fetchPage(null);
    await reloadTags();
    return true;
  }

  return {
    viewer,
    domains,
    tags,
    mailTemplates,
    messages,
    totalCount,
    hasMore: () => cursor() !== null,
    loading,
    selectedIds,
    view,
    unreadOnly,
    inboxUnreadCount,

    async rehydrateSession() {
      const result = await graphqlRequest<{
        readonly viewer: ViewerView | null;
      }>(VIEWER_QUERY);
      if (!result.ok || result.data.viewer === null) {
        setViewer(null);
        sessionStore.clear();
        return;
      }
      setViewer(result.data.viewer);
      sessionStore.markEstablished();
    },

    async loadReferenceData() {
      const [domainResult] = await Promise.all([
        graphqlRequest<{ readonly domains: readonly MailDomainView[] }>(
          DOMAINS_QUERY,
        ),
        reloadTags(),
      ]);
      if (domainResult.ok) {
        setDomains(domainResult.data.domains);
      }
      // Best-effort: the agenda and unread count failing must not block the
      // mailbox.
      await Promise.all([
        reloadUpcomingEvents().catch(() => undefined),
        reloadInboxUnread().catch(() => undefined),
      ]);
    },

    reloadUpcomingEvents,

    async setView(next) {
      setViewSignal(() => next);
      setUnreadOnlySignal(false);
      setSelectedIds(new Set<string>());
      setCursor(null);
      await fetchPage(null);
    },

    async setUnreadOnly(value) {
      setUnreadOnlySignal(value);
      setCursor(null);
      await fetchPage(null);
    },

    async reloadMessages() {
      setCursor(null);
      await fetchPage(null);
      await reloadInboxUnread().catch(() => undefined);
    },

    async loadMore() {
      const after = cursor();
      if (after === null || loading()) {
        return;
      }
      await fetchPage(after);
    },

    toggleSelection(id) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (!next.delete(id)) {
          next.add(id);
        }
        return next;
      });
    },

    clearSelection() {
      setSelectedIds(new Set<string>());
    },

    selectAll() {
      setSelectedIds(new Set(messages().map((message) => message.id)));
    },

    systemTag(slug) {
      return findSystemTag(slug);
    },

    async tagSelected(tagIds) {
      await mutateSelected(
        TAG_MESSAGES_MUTATION,
        { messageIds: [...selectedIds()], tagIds },
        (message) => message,
      );
    },

    async untagSelected(tagIds) {
      await mutateSelected(
        UNTAG_MESSAGES_MUTATION,
        { messageIds: [...selectedIds()], tagIds },
        (message) => message,
      );
    },

    async markSelectedSpam(spam) {
      const succeeded = await mutateSelected(
        spam ? MARK_SPAM_MUTATION : MARK_NOT_SPAM_MUTATION,
        { messageIds: [...selectedIds()] },
        (message) => ({ ...message, isSpam: spam }),
      );
      if (succeeded) {
        await reloadInboxUnread().catch(() => undefined);
      }
    },

    async markSelectedRead(read) {
      const succeeded = await mutateSelected(
        MARK_READ_MUTATION,
        { messageIds: [...selectedIds()], read },
        (message) => ({
          ...message,
          readAt: read ? new Date().toISOString() : null,
        }),
      );
      if (succeeded) {
        await reloadInboxUnread().catch(() => undefined);
      }
    },

    async deleteSelected() {
      const ids = selectedIds();
      if (ids.size === 0) {
        return;
      }
      const rollback = optimisticPatch(
        setMessages,
        messages(),
        ids,
        (message) => message,
      );
      setMessages((current) =>
        current.filter((message) => !ids.has(message.id)),
      );
      const result = await graphqlRequest<
        { readonly deleteMessages: number },
        Record<string, unknown>
      >(DELETE_MESSAGES_MUTATION, { messageIds: [...ids] });
      if (!result.ok) {
        rollback();
        pushToast("error", describeErrors(result.errors));
        return;
      }
      pushToast("success", `Deleted ${result.data.deleteMessages} message(s)`);
      setSelectedIds(new Set<string>());
      await fetchPage(null);
      await reloadInboxUnread().catch(() => undefined);
    },

    async setStarred(messageIds, starred) {
      return setSystemTagged(
        messageIds,
        "STARRED",
        starred,
        "Star tag is not available",
      );
    },

    async setArchived(messageIds, archived) {
      return setSystemTagged(
        messageIds,
        "ARCHIVED",
        archived,
        "Archive tag is not available",
      );
    },

    async send(input) {
      const result = await graphqlRequest<
        { readonly sendMessage: MessageView },
        Record<string, unknown>
      >(SEND_MESSAGE_MUTATION, { input });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return false;
      }
      pushToast(
        "success",
        result.data.sendMessage.deliveryStatus === "SENT"
          ? "Message sent"
          : "Message queued",
      );
      return true;
    },

    upcomingEvents,

    async saveDraft(input) {
      const result = await graphqlRequest<
        { readonly saveDraft: MessageView },
        Record<string, unknown>
      >(SAVE_DRAFT_MUTATION, { input });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return null;
      }
      pushToast("success", "Draft saved");
      return result.data.saveDraft;
    },

    async sendDraft(id) {
      const result = await graphqlRequest<
        { readonly sendDraft: MessageView },
        Record<string, unknown>
      >(SEND_DRAFT_MUTATION, { id });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return false;
      }
      pushToast(
        "success",
        result.data.sendDraft.deliveryStatus === "SENT"
          ? "Message sent"
          : "Message queued",
      );
      return true;
    },

    async createMessageEvent(input) {
      const result = await graphqlRequest<
        { readonly createMessageEvent: MessageEventView },
        Record<string, unknown>
      >(CREATE_MESSAGE_EVENT_MUTATION, { input });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return null;
      }
      return result.data.createMessageEvent;
    },

    async updateMessageEvent(id, input) {
      const result = await graphqlRequest<
        { readonly updateMessageEvent: MessageEventView },
        Record<string, unknown>
      >(UPDATE_MESSAGE_EVENT_MUTATION, { id, input });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return null;
      }
      return result.data.updateMessageEvent;
    },

    async deleteMessageEvent(id) {
      const result = await graphqlRequest<
        { readonly deleteMessageEvent: boolean },
        Record<string, unknown>
      >(DELETE_MESSAGE_EVENT_MUTATION, { id });
      if (!result.ok) {
        pushToast("error", describeErrors(result.errors));
        return false;
      }
      return true;
    },

    async logout() {
      // Invalidate the server session first: clearing only local state
      // would leave the HttpOnly cookie valid until its natural expiry,
      // still usable by anyone with access to the browser profile. The
      // request is best-effort -- local state clears even when the server
      // is unreachable, since keeping the UI signed in would be worse.
      await graphqlRequest(LOGOUT_MUTATION).catch(() => undefined);
      setViewer(null);
      setMessages([]);
      setSelectedIds(new Set<string>());
      sessionStore.clear();
    },

    async loadMailTemplates(): Promise<void> {
      const result = await graphqlRequest<{
        readonly mailTemplates: readonly MailTemplateView[];
      }>(MAIL_TEMPLATES_QUERY);
      if (reportFailure(result) || !result.ok) {
        return;
      }
      setMailTemplates(result.data.mailTemplates);
    },

    /** Validation is asked of the *server* rather than re-derived here: a
     * client-side copy of "is this filled in?" is one more place for the two
     * to disagree. */
    async validateTemplateValues(id, values) {
      const result = await graphqlRequest<
        { readonly mailTemplateValidation: TemplateValidationView },
        { id: string; values: readonly TemplateValueInput[] }
      >(MAIL_TEMPLATE_VALIDATION_QUERY, { id, values });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      return result.data.mailTemplateValidation;
    },

    async previewTemplate(id, values) {
      const result = await graphqlRequest<
        { readonly previewMailTemplate: RenderedTemplateView },
        { id: string; values: readonly TemplateValueInput[] }
      >(PREVIEW_MAIL_TEMPLATE_QUERY, { id, values });
      if (reportFailure(result) || !result.ok) {
        return null;
      }
      return result.data.previewMailTemplate;
    },

    async sendTemplatedMessage(input) {
      const result = await graphqlRequest<
        { readonly sendTemplatedMessage: MessageView },
        { input: SendTemplatedMessageVariables }
      >(SEND_TEMPLATED_MESSAGE_MUTATION, { input });
      if (reportFailure(result) || !result.ok) {
        return false;
      }
      pushToast("success", "Message sent");
      await fetchPage(null);
      return true;
    },
  };
}
