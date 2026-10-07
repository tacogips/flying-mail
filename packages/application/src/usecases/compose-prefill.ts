import type { Attachment } from "@flying-mail/domain/entities/attachment";
import {
  type Message,
  MessageDirection,
  type MessageRecipient,
  RecipientKind,
} from "@flying-mail/domain/entities/message";
import {
  createEmailAddress,
  type EmailAddress,
} from "@flying-mail/domain/value-objects/email-address";
import {
  matchAddressPattern,
  parseAddressPattern,
} from "@flying-mail/domain/value-objects/address-pattern";
import type { MessageId } from "@flying-mail/domain/value-objects/ids";

export type ComposeMode = "REPLY" | "REPLY_ALL" | "FORWARD";

export interface ComposePrefill {
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly inReplyToMessageId: MessageId | null;
  readonly forwardedFromMessageId: MessageId | null;
  readonly forwardAttachments: readonly Attachment[];
  readonly quotedText: string;
  readonly quotedHtml: string | null;
}

export interface PrefillSource {
  readonly message: Message;
  readonly recipients: readonly MessageRecipient[];
  readonly attachments: readonly Attachment[];
}

function orderedRecipients(
  recipients: readonly MessageRecipient[],
  kind: RecipientKind,
): readonly MessageRecipient[] {
  return recipients
    .filter((recipient) => recipient.kind === kind)
    .toSorted((left, right) => left.position - right.position);
}

function matchesSendableAddress(
  address: EmailAddress,
  sendable: readonly string[],
): boolean {
  const normalized = String(address).toLowerCase();
  return sendable.some((candidate) => {
    if (candidate.trim() === "*") {
      return false;
    }
    if (candidate.includes("*")) {
      const pattern = parseAddressPattern(candidate);
      return pattern !== null && matchAddressPattern(pattern, address);
    }
    return candidate.toLowerCase() === normalized;
  });
}

function uniqueAddresses(
  addresses: readonly EmailAddress[],
): readonly string[] {
  const unique = new Map<string, string>();
  for (const address of addresses) {
    const value = String(address);
    const key = value.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, value);
    }
  }
  return [...unique.values()];
}

function prefixedSubject(subject: string, mode: ComposeMode): string {
  if (mode === "FORWARD") {
    return /^fwd?:\s*/i.test(subject) ? subject : `Fwd: ${subject}`;
  }
  return /^re:\s*/i.test(subject) ? subject : `Re: ${subject}`;
}

function formatDate(occurredAt: string): string {
  const date = new Date(occurredAt);
  const twoDigits = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())} ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())} UTC`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function senderLabel(message: Message): string {
  return message.fromName === null || message.fromName.length === 0
    ? String(message.fromAddress)
    : `${message.fromName} <${message.fromAddress}>`;
}

function bodyText(message: Message): string {
  return message.textBody ?? message.snippet;
}

function quoteLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function quoteText(
  message: Message,
  recipients: readonly MessageRecipient[],
  mode: ComposeMode,
): string {
  const date = formatDate(message.occurredAt);
  const body = bodyText(message);
  if (mode !== "FORWARD") {
    return `\n\nOn ${date}, ${senderLabel(message)} wrote:\n${quoteLines(body)}`;
  }

  const to = orderedRecipients(recipients, RecipientKind.To).map((entry) =>
    String(entry.address),
  );
  const cc = orderedRecipients(recipients, RecipientKind.Cc).map((entry) =>
    String(entry.address),
  );
  const headers = [
    "---------- Forwarded message ----------",
    `From: ${senderLabel(message)}`,
    `Date: ${date}`,
    `Subject: ${message.subject}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc.length > 0) {
    headers.push(`Cc: ${cc.join(", ")}`);
  }
  return `\n\n${headers.join("\n")}\n\n${body}`;
}

function quoteHtml(
  message: Message,
  recipients: readonly MessageRecipient[],
  mode: ComposeMode,
): string | null {
  if (message.htmlBody === null) {
    return null;
  }
  const date = formatDate(message.occurredAt);
  if (mode !== "FORWARD") {
    const attribution = escapeHtml(
      `On ${date}, ${senderLabel(message)} wrote:`,
    );
    return `<p>${attribution}</p><blockquote type="cite">${message.htmlBody}</blockquote>`;
  }

  const to = orderedRecipients(recipients, RecipientKind.To).map((entry) =>
    String(entry.address),
  );
  const cc = orderedRecipients(recipients, RecipientKind.Cc).map((entry) =>
    String(entry.address),
  );
  const headers = [
    "---------- Forwarded message ----------",
    `From: ${senderLabel(message)}`,
    `Date: ${date}`,
    `Subject: ${message.subject}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc.length > 0) {
    headers.push(`Cc: ${cc.join(", ")}`);
  }
  return `${headers.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}<br>${message.htmlBody}`;
}

export function computeComposePrefill(
  source: PrefillSource,
  mode: ComposeMode,
  sendable: readonly string[],
): ComposePrefill {
  const { message, recipients, attachments } = source;
  const envelope = orderedRecipients(recipients, RecipientKind.Envelope);
  const headerRecipients = [
    ...orderedRecipients(recipients, RecipientKind.To),
    ...orderedRecipients(recipients, RecipientKind.Cc),
  ];
  const fromAddress =
    message.direction === MessageDirection.Outbound
      ? message.fromAddress
      : (envelope.find((entry) =>
          matchesSendableAddress(entry.address, sendable),
        )?.address ??
        headerRecipients.find((entry) =>
          matchesSendableAddress(entry.address, sendable),
        )?.address ??
        sendable
          .filter((candidate) => !candidate.includes("*"))
          .map((candidate) => {
            try {
              return createEmailAddress(candidate);
            } catch {
              return null;
            }
          })
          .find((candidate) => candidate !== null) ??
        null);

  const isOwn = (address: EmailAddress): boolean =>
    (fromAddress !== null &&
      String(address).toLowerCase() === String(fromAddress).toLowerCase()) ||
    matchesSendableAddress(address, sendable);

  let to: readonly EmailAddress[] = [];
  let cc: readonly EmailAddress[] = [];
  if (mode !== "FORWARD") {
    if (message.direction === MessageDirection.Inbound) {
      to = [message.replyTo ?? message.fromAddress];
      if (mode === "REPLY_ALL") {
        cc = headerRecipients.map((entry) => entry.address);
      }
    } else {
      to = orderedRecipients(recipients, RecipientKind.To).map(
        (entry) => entry.address,
      );
      if (mode === "REPLY_ALL") {
        cc = orderedRecipients(recipients, RecipientKind.Cc).map(
          (entry) => entry.address,
        );
      }
    }
    if (mode === "REPLY_ALL") {
      to = to.filter((address) => !isOwn(address));
      cc = cc.filter((address) => !isOwn(address));
      const toKeys = new Set(
        to.map((address) => String(address).toLowerCase()),
      );
      cc = cc.filter((address) => !toKeys.has(String(address).toLowerCase()));
      if (message.direction === MessageDirection.Inbound && to.length === 0) {
        to = [message.fromAddress];
      }
    }
  }

  return {
    from: fromAddress === null ? null : String(fromAddress),
    to: uniqueAddresses(to),
    cc: uniqueAddresses(cc),
    subject: prefixedSubject(message.subject, mode),
    inReplyToMessageId: mode === "FORWARD" ? null : message.id,
    forwardedFromMessageId: mode === "FORWARD" ? message.id : null,
    forwardAttachments: mode === "FORWARD" ? attachments : [],
    quotedText: quoteText(message, recipients, mode),
    quotedHtml: quoteHtml(message, recipients, mode),
  };
}
