import type { Attachment } from "@flying-mail/domain/entities/attachment";
import type {
  Message,
  MessageRecipient,
} from "@flying-mail/domain/entities/message";
import type { Tag } from "@flying-mail/domain/entities/tag";
import { HTML_INPUT_TRUNCATION_MARKER, htmlToText } from "./html-text";
import { sanitizeHtml } from "./html-sanitize";

export const TRUNCATION_MARKER = (shown: number, total: number): string =>
  `\n[truncated: showing ${shown} of ${total} characters]`;

export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

export function truncateText(text: string, maxChars: number): TruncatedText {
  const limit = Math.max(0, maxChars);
  if (text.length <= limit)
    return { text, truncated: false, totalChars: text.length };
  let shown = limit;
  const last = text.charCodeAt(shown - 1);
  const next = text.charCodeAt(shown);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
    shown -= 1;
  return {
    text: text.slice(0, shown) + TRUNCATION_MARKER(shown, text.length),
    truncated: true,
    totalChars: text.length,
  };
}

export type BodySource = "text" | "html_converted" | "none";

interface SelectedBody {
  readonly text: string;
  readonly source: BodySource;
  readonly inputTruncated: boolean;
}

function selectBody(message: Message): SelectedBody {
  if (message.textBody !== null && message.textBody.trim().length > 0) {
    return { text: message.textBody, source: "text", inputTruncated: false };
  }
  if (message.htmlBody !== null) {
    const converted = htmlToText(message.htmlBody);
    return {
      text: converted.text,
      source: "html_converted",
      inputTruncated: converted.inputTruncated,
    };
  }
  return { text: "", source: "none", inputTruncated: false };
}

function bodyTextWithInputTruncationMarker(
  text: string,
  inputTruncated: boolean,
): string {
  if (!inputTruncated || text.endsWith(HTML_INPUT_TRUNCATION_MARKER)) {
    return text;
  }
  return `${text}${HTML_INPUT_TRUNCATION_MARKER}`;
}

export function selectBodyText(message: Message): {
  readonly text: string;
  readonly source: BodySource;
} {
  const selected = selectBody(message);
  return { text: selected.text, source: selected.source };
}

export interface MessageSummaryView {
  readonly id: string;
  readonly thread_id: string;
  readonly direction: string;
  readonly status: string;
  readonly delivery_status: string;
  readonly from_address: string;
  readonly occurred_at: string;
  readonly read: boolean;
  readonly is_mailing_list: boolean;
  readonly untrusted_content: {
    readonly subject: string;
    readonly from_name: string | null;
    readonly snippet: string;
  };
}

export function toMessageSummaryView(message: Message): MessageSummaryView {
  return {
    id: message.id,
    thread_id: message.threadId,
    direction: message.direction,
    status: message.status,
    delivery_status: message.deliveryStatus,
    from_address: message.fromAddress,
    occurred_at: message.occurredAt,
    read: message.readAt !== null,
    is_mailing_list: message.isMailingList,
    untrusted_content: {
      subject: message.subject,
      from_name: message.fromName,
      snippet: message.snippet,
    },
  };
}

export interface ThreadEntryView extends MessageSummaryView {
  readonly untrusted_content: MessageSummaryView["untrusted_content"] & {
    readonly body_text: string;
    readonly body_source: BodySource;
    readonly body_truncated: boolean;
    readonly body_total_chars: number;
  };
}

export function toThreadEntryView(
  message: Message,
  maxBodyChars: number,
): ThreadEntryView {
  const selected = selectBody(message);
  const body = truncateText(selected.text, maxBodyChars);
  return {
    ...toMessageSummaryView(message),
    untrusted_content: {
      ...toMessageSummaryView(message).untrusted_content,
      body_text: bodyTextWithInputTruncationMarker(
        body.text,
        selected.inputTruncated,
      ),
      body_source: selected.source,
      body_truncated: body.truncated || selected.inputTruncated,
      body_total_chars: body.totalChars,
    },
  };
}

export interface AttachmentView {
  readonly id: string;
  readonly content_type: string;
  readonly size: number;
  readonly inline: boolean;
  readonly kind: string;
  readonly untrusted_content: { readonly file_name: string };
}

export function toAttachmentView(attachment: Attachment): AttachmentView {
  return {
    id: attachment.id,
    content_type: attachment.contentType,
    size: attachment.size,
    inline: attachment.inline,
    kind: attachment.kind,
    untrusted_content: { file_name: attachment.fileName },
  };
}

export interface MessageDetailInput {
  readonly message: Message;
  readonly recipients: readonly MessageRecipient[];
  readonly attachments: readonly Attachment[];
  readonly tags: readonly Tag[];
  readonly includeHtml: boolean;
  readonly maxBodyChars: number;
}

export interface MessageDetailView extends MessageSummaryView {
  readonly recipients: readonly {
    readonly kind: string;
    readonly address: string;
  }[];
  readonly tags: readonly {
    readonly id: string;
    readonly name: string;
    readonly system_slug: string | null;
  }[];
  readonly attachments: readonly AttachmentView[];
  readonly stored_body_truncated: boolean;
  readonly untrusted_content: MessageSummaryView["untrusted_content"] & {
    readonly reply_to: string | null;
    readonly rfc_message_id: string | null;
    readonly in_reply_to: string | null;
    readonly list_id: string | null;
    readonly body_text: string;
    readonly body_source: BodySource;
    readonly body_truncated: boolean;
    readonly body_total_chars: number;
    readonly html_sanitized?: string;
    readonly html_truncated?: boolean;
  };
}

export function toMessageDetailView(
  input: MessageDetailInput,
): MessageDetailView {
  const { message } = input;
  const selected = selectBody(message);
  const body = truncateText(selected.text, input.maxBodyChars);
  const untrustedContent: MessageDetailView["untrusted_content"] = {
    subject: message.subject,
    from_name: message.fromName,
    snippet: message.snippet,
    reply_to: message.replyTo,
    rfc_message_id: message.rfcMessageId,
    in_reply_to: message.inReplyTo,
    list_id: message.listId,
    body_text: bodyTextWithInputTruncationMarker(
      body.text,
      selected.inputTruncated,
    ),
    body_source: selected.source,
    body_truncated: body.truncated || selected.inputTruncated,
    body_total_chars: body.totalChars,
    ...(input.includeHtml && message.htmlBody !== null
      ? (() => {
          const sanitized = sanitizeHtml(message.htmlBody, input.maxBodyChars);
          return {
            html_sanitized: sanitized.html,
            html_truncated: sanitized.truncated,
          };
        })()
      : {}),
  };
  return {
    ...toMessageSummaryView(message),
    recipients: input.recipients.map(({ kind, address }) => ({
      kind,
      address,
    })),
    tags: input.tags.map(({ id, name, systemSlug }) => ({
      id,
      name,
      system_slug: systemSlug,
    })),
    attachments: input.attachments.map(toAttachmentView),
    stored_body_truncated: message.bodyTruncated,
    untrusted_content: untrustedContent,
  };
}
