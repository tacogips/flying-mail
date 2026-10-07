import { createEffect, createSignal, For, type JSX, on, Show } from "solid-js";
import { CREATE_RAW_MESSAGE_LINK_MUTATION } from "../api/documents";
import { graphqlRequest } from "../api/graphql-client";
import type {
  CreatedFileLinkView,
  MessageDetailView,
} from "../api/schema-types";
import type { ContactView } from "../api/contact-types";
import { formatMailbox, formatRecipients } from "../lib/address-format";
import { avatarClass, avatarInitial } from "../lib/avatar";
import { lookupContactByEmail } from "../lib/contact-lookup";
import { normalizeContentId } from "../lib/mail-html";
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

const MAX_INLINE_TILE_HIDDEN_BYTES = 5 * 1024 * 1024;

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
  readonly onBack: () => void;
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
  const visibleAttachments = () =>
    props.message.attachments.filter((attachment) => {
      if (
        !attachment.inline ||
        attachment.contentId === null ||
        !attachment.contentType.startsWith("image/") ||
        attachment.size > MAX_INLINE_TILE_HIDDEN_BYTES
      ) {
        return true;
      }
      const htmlBody = props.message.htmlBody;
      if (htmlBody === null) return true;
      const contentId = normalizeContentId(attachment.contentId).toLowerCase();
      return ![...htmlBody.matchAll(/cid:\s*<?([^"'\s>)]+)>?/gi)].some(
        (match) =>
          match[1] !== undefined &&
          normalizeContentId(match[1]).toLowerCase() === contentId,
      );
    });

  const deduplicateRecipients = (
    recipients: readonly (typeof props.message.recipients)[number][],
  ) => {
    const seen = new Set<string>();
    return recipients.filter((recipient) => {
      const key = recipient.address.trim().toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  };
  const headerRecipients = () =>
    deduplicateRecipients(
      props.message.recipients.filter(
        (recipient) => recipient.kind === "TO" || recipient.kind === "CC",
      ),
    );
  const toRecipients = () =>
    headerRecipients().filter((recipient) => recipient.kind === "TO");
  const ccRecipients = () =>
    headerRecipients().filter((recipient) => recipient.kind === "CC");
  const bccRecipients = () =>
    props.message.direction === "OUTBOUND"
      ? deduplicateRecipients(
          props.message.recipients.filter(
            (recipient) => recipient.kind === "BCC",
          ),
        )
      : [];
  const envelopeRecipients = () => {
    const recipients = deduplicateRecipients(
      props.message.recipients.filter(
        (recipient) => recipient.kind === "ENVELOPE",
      ),
    );
    const headerAddresses = new Set(
      [...toRecipients(), ...ccRecipients()].map((recipient) =>
        recipient.address.trim().toLowerCase(),
      ),
    );
    return recipients.length > 0 &&
      recipients.some(
        (recipient) =>
          !headerAddresses.has(recipient.address.trim().toLowerCase()),
      )
      ? recipients
      : [];
  };
  const recipientLines = () => [
    ...(toRecipients().length > 0
      ? [{ label: "To", recipients: toRecipients() }]
      : []),
    ...(ccRecipients().length > 0
      ? [{ label: "Cc", recipients: ccRecipients() }]
      : []),
    ...(bccRecipients().length > 0
      ? [{ label: "Bcc", recipients: bccRecipients() }]
      : []),
  ];

  // "Who is this?" lookup hook: resolves the sender and recipient addresses
  // through contactsByEmail (via `contact-lookup.ts`'s short-lived cache),
  // entirely after the initial paint. A miss leaves these signals at their
  // initial empty values, so the render below is byte-for-byte what it was
  // before contacts existed.
  const [fromContact, setFromContact] = createSignal<ContactView | null>(null);
  const [recipientContacts, setRecipientContacts] = createSignal<
    readonly ContactView[]
  >([]);

  createEffect(
    on(
      () => props.message.id,
      () => {
        setFromContact(null);
        setRecipientContacts([]);

        void lookupContactByEmail(props.message.from.address).then((contact) =>
          setFromContact(contact),
        );

        const addresses = [
          ...new Set(
            [...toRecipients(), ...ccRecipients()].map(
              (recipient) => recipient.address,
            ),
          ),
        ];
        void Promise.all(
          addresses.map((address) => lookupContactByEmail(address)),
        ).then((contacts) =>
          setRecipientContacts(
            contacts.filter(
              (contact): contact is ContactView => contact !== null,
            ),
          ),
        );
      },
    ),
  );

  return (
    <article class="message-view">
      <div class="message-view-toolbar">
        <button
          type="button"
          class="message-view-back"
          onClick={() => props.onBack()}
        >
          Back to messages
        </button>
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
            <strong>
              {formatMailbox(props.message.from)}
              <Show when={fromContact() !== null}>
                {" "}
                <a
                  class="message-view-contact-hint"
                  href={`/contacts?contactId=${fromContact()?.id}`}
                >
                  ({fromContact()?.displayName})
                </a>
              </Show>
            </strong>
            <div class="muted message-view-recipients">
              <For each={recipientLines()}>
                {(line) => (
                  <span class="message-view-recipient-line">
                    {line.label}: {formatRecipients(line.recipients)}
                  </span>
                )}
              </For>
              <Show when={envelopeRecipients().length > 0}>
                <span class="message-view-recipient-line message-view-delivered-to">
                  Delivered to: {formatRecipients(envelopeRecipients())}
                </span>
              </Show>
            </div>
            <Show when={recipientContacts().length > 0}>
              <span class="muted message-view-contact-hints">
                Known contacts:{" "}
                <For each={recipientContacts()}>
                  {(contact) => (
                    <a href={`/contacts?contactId=${contact.id}`}>
                      {contact.displayName}
                    </a>
                  )}
                </For>
              </span>
            </Show>
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
          <HtmlBodyFrame
            html={props.message.htmlBody ?? ""}
            attachments={props.message.attachments}
          />
        </Show>
      </section>

      <Show when={visibleAttachments().length > 0}>
        <section class="message-view-attachments">
          <h2>Attachments</h2>
          <For each={visibleAttachments()}>
            {(attachment) => <AttachmentTile attachment={attachment} />}
          </For>
        </section>
      </Show>
    </article>
  );
}
