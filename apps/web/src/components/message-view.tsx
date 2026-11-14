import { createSignal, For, type JSX, Show } from "solid-js";
import { CREATE_RAW_MESSAGE_LINK_MUTATION } from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type {
  CreatedFileLinkView,
  MessageDetailView,
} from "../api/schema-types";
import { formatMailbox, formatRecipients } from "../lib/address-format";
import { avatarClass, avatarInitial } from "../lib/avatar";
import { describeErrors } from "../lib/mutation-error";
import { formatAbsoluteTime, formatBytes } from "../lib/relative-time";
import { pushToast } from "../lib/toast";
import { AttachmentTile } from "./attachment-tile";
import { EventPanel } from "./event-panel";
import { HtmlBodyFrame } from "./html-body-frame";
import {
  ArchiveIcon,
  DownloadIcon,
  EnvelopeIcon,
  FlameIcon,
  ForwardIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  TrashIcon,
} from "./icons";
import { SpamBanner } from "./spam-banner";
import { TagChip } from "./tag-chip";
import "./message-view.css";

function hasSystemTag(
  message: MessageDetailView,
  slug: "STARRED" | "ARCHIVED",
): boolean {
  return message.tags.some(
    (tag) => tag.kind === "SYSTEM" && tag.systemSlug === slug,
  );
}

export function MessageView(props: {
  readonly message: MessageDetailView;
  readonly onReply: (replyAll: boolean) => void;
  readonly onForward: () => void;
  readonly onNotSpam: () => void;
  readonly onMarkSpam: () => void;
  readonly onMarkUnread: () => void;
  readonly onDelete: () => void;
  readonly onToggleStar: (starred: boolean) => void;
  readonly onToggleArchive: (archived: boolean) => void;
}): JSX.Element {
  const [rawLink, setRawLink] = createSignal<string | null>(null);

  async function mintRawLink(): Promise<void> {
    const result = await graphqlRequest<
      { readonly createRawMessageLink: CreatedFileLinkView },
      Record<string, unknown>
    >(CREATE_RAW_MESSAGE_LINK_MUTATION, {
      messageId: props.message.id,
      ttlSeconds: 3600,
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setRawLink(result.data.createRawMessageLink.url);
    pushToast("success", "Temporary link to the raw message created");
  }

  const starred = () => hasSystemTag(props.message, "STARRED");
  const archived = () => hasSystemTag(props.message, "ARCHIVED");
  const userTags = () =>
    props.message.tags.filter((tag) => tag.kind === "USER");

  const toRecipients = () =>
    props.message.recipients.filter(
      (recipient) => recipient.kind === "TO" || recipient.kind === "ENVELOPE",
    );
  const ccRecipients = () =>
    props.message.recipients.filter((recipient) => recipient.kind === "CC");

  return (
    <article class="message-view">
      <div class="message-view-toolbar">
        <button
          type="button"
          class="icon-button"
          title="Mark as unread"
          aria-label="Mark as unread"
          onClick={() => props.onMarkUnread()}
        >
          <EnvelopeIcon />
        </button>
        <button
          type="button"
          classList={{ "icon-button": true, active: archived() }}
          title={archived() ? "Unarchive" : "Archive"}
          aria-label={archived() ? "Unarchive" : "Archive"}
          onClick={() => props.onToggleArchive(!archived())}
        >
          <ArchiveIcon />
        </button>
        <Show when={!props.message.isSpam}>
          <button
            type="button"
            class="icon-button"
            title="Mark spam"
            aria-label="Mark spam"
            onClick={() => props.onMarkSpam()}
          >
            <FlameIcon />
          </button>
        </Show>
        <button
          type="button"
          class="icon-button danger"
          title="Delete"
          aria-label="Delete"
          onClick={() => props.onDelete()}
        >
          <TrashIcon />
        </button>
        <button
          type="button"
          class="icon-button"
          title={`Raw message (${formatBytes(props.message.rawSize)})`}
          aria-label={`Raw message (${formatBytes(props.message.rawSize)})`}
          onClick={() => void mintRawLink()}
        >
          <DownloadIcon />
        </button>
        <span class="message-view-toolbar-spacer" />
        <button
          type="button"
          class="icon-button"
          title="Reply"
          aria-label="Reply"
          onClick={() => props.onReply(false)}
        >
          <ReplyIcon />
        </button>
        <button
          type="button"
          class="icon-button"
          title="Reply all"
          aria-label="Reply all"
          onClick={() => props.onReply(true)}
        >
          <ReplyAllIcon />
        </button>
        <button
          type="button"
          class="icon-button"
          title="Forward"
          aria-label="Forward"
          onClick={() => props.onForward()}
        >
          <ForwardIcon />
        </button>
      </div>

      <Show when={rawLink() !== null}>
        <code class="message-view-rawlink">{rawLink()}</code>
      </Show>

      <Show when={props.message.isSpam}>
        <SpamBanner message={props.message} onNotSpam={props.onNotSpam} />
      </Show>

      <header class="message-view-header">
        <h1 class="message-view-subject">
          {props.message.subject.length === 0
            ? "(no subject)"
            : props.message.subject}
        </h1>

        <div class="message-view-sender-row">
          <span
            class={`avatar message-view-avatar ${avatarClass(props.message.from.address)}`}
          >
            {avatarInitial(
              props.message.from.name ?? props.message.from.address,
            )}
          </span>
          <div class="message-view-sender-col">
            <strong>{formatMailbox(props.message.from)}</strong>
            <span class="muted message-view-recipients">
              To: {formatRecipients(toRecipients())}
              <Show when={ccRecipients().length > 0}>
                {" "}
                Cc: {formatRecipients(ccRecipients())}
              </Show>
            </span>
            <Show when={props.message.deliveryStatus === "FAILED"}>
              <span class="error-text">
                Delivery failed
                {props.message.deliveryError === null
                  ? ""
                  : ` (${props.message.deliveryError})`}
              </span>
            </Show>
          </div>
          <div class="message-view-header-meta">
            <button
              type="button"
              classList={{ "icon-button": true, active: starred() }}
              aria-label={starred() ? "Unstar" : "Star"}
              title={starred() ? "Unstar" : "Star"}
              onClick={() => props.onToggleStar(!starred())}
            >
              <StarIcon filled={starred()} />
            </button>
            <span class="muted message-view-date">
              {formatAbsoluteTime(props.message.occurredAt)}
            </span>
          </div>
        </div>

        <Show when={props.message.isMailingList}>
          <div class="mailing-list-banner">
            <EnvelopeIcon size={16} />
            <span>
              This message is from a mailing list.
              <Show when={props.message.listId !== null}>
                {" "}
                <span class="muted">{props.message.listId}</span>
              </Show>
            </span>
          </div>
        </Show>

        <Show when={userTags().length > 0}>
          <div class="message-view-tags">
            <For each={userTags()}>{(tag) => <TagChip tag={tag} />}</For>
          </div>
        </Show>
      </header>

      <EventPanel
        messageId={props.message.id}
        initialEvents={props.message.events}
      />

      <Show when={props.message.bodyTruncated}>
        <p class="muted message-view-truncated">
          This body was truncated for storage. Use the raw message link above
          for the complete original.
        </p>
      </Show>

      <section class="message-view-body">
        <Show
          when={props.message.htmlBody !== null}
          fallback={
            <pre class="message-view-text">
              {props.message.textBody ?? props.message.snippet}
            </pre>
          }
        >
          <HtmlBodyFrame html={props.message.htmlBody ?? ""} />
        </Show>
      </section>

      <Show when={props.message.attachments.length > 0}>
        <section class="message-view-attachments">
          <h2>Attachments</h2>
          <For each={props.message.attachments}>
            {(attachment) => <AttachmentTile attachment={attachment} />}
          </For>
        </section>
      </Show>
    </article>
  );
}
