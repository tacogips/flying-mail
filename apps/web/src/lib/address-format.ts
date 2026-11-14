import type { MailboxAddressView } from "../api/schema-types";

/** `Name <addr@example.com>` when a display name is present, else the bare
 * address. */
export function formatMailbox(mailbox: MailboxAddressView): string {
  return mailbox.name === null || mailbox.name.length === 0
    ? mailbox.address
    : `${mailbox.name} <${mailbox.address}>`;
}

/** The short label a message list shows: the display name when there is
 * one, otherwise the local part. Full addresses are too wide for a list
 * column and the domain is rarely the distinguishing part. */
export function shortMailbox(mailbox: MailboxAddressView): string {
  if (mailbox.name !== null && mailbox.name.length > 0) {
    return mailbox.name;
  }
  const separator = mailbox.address.lastIndexOf("@");
  return separator === -1
    ? mailbox.address
    : mailbox.address.slice(0, separator);
}

/** Joins a recipient list for a header line, truncating past `max` so one
 * mailing-list message cannot push the layout apart. */
export function formatRecipients(
  mailboxes: readonly MailboxAddressView[],
  max = 3,
): string {
  if (mailboxes.length === 0) {
    return "";
  }
  const shown = mailboxes.slice(0, max).map(formatMailbox).join(", ");
  const remaining = mailboxes.length - max;
  return remaining > 0 ? `${shown} +${remaining} more` : shown;
}

/** The addresses a reply should go to: the sender, plus every other
 * recipient when replying to all, minus the mailbox that received it (so a
 * reply-all does not address the reader). */
export function buildReplyRecipients(params: {
  readonly from: MailboxAddressView;
  readonly recipients: readonly MailboxAddressView[];
  readonly replyAll: boolean;
  readonly selfAddress: string | null;
}): { readonly to: readonly string[]; readonly cc: readonly string[] } {
  const to = [params.from.address];
  if (!params.replyAll) {
    return { to, cc: [] };
  }
  const seen = new Set<string>([params.from.address]);
  if (params.selfAddress !== null) {
    seen.add(params.selfAddress);
  }
  const cc: string[] = [];
  for (const recipient of params.recipients) {
    if (recipient.kind === "BCC" || seen.has(recipient.address)) {
      continue;
    }
    seen.add(recipient.address);
    cc.push(recipient.address);
  }
  return { to, cc };
}
