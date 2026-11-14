import {
  RecipientKind,
  type Message,
} from "@flying-mail/domain/entities/message";
import type { AppDependencies } from "../dependencies";
import { NotFoundError } from "../errors";
import type { OutboundMail } from "../ports/mail-sender";
import type { BuildMimeAttachment } from "../ports/mime";

export interface AssembleOutboundOptions {
  readonly customHeaders?: ReadonlyMap<string, string>;
}

/** Builds the stored RFC 5322 source and provider payload from persisted rows. */
export async function assembleOutbound(
  deps: AppDependencies,
  message: Message,
  options: AssembleOutboundOptions = {},
): Promise<{ readonly mail: OutboundMail; readonly raw: string }> {
  const recipientRowsByMessage = await deps.messageRepository.listRecipients([
    message.id,
  ]);
  const recipientRows = recipientRowsByMessage.get(message.id) ?? [];
  const recipients = (kind: RecipientKind): readonly string[] =>
    recipientRows
      .filter((recipient) => recipient.kind === kind)
      .map((recipient) => recipient.address);
  const to = recipients(RecipientKind.To);
  const cc = recipients(RecipientKind.Cc);
  const bcc = recipients(RecipientKind.Bcc);

  const attachmentRowsByMessage = await deps.messageRepository.listAttachments([
    message.id,
  ]);
  const attachmentRows = attachmentRowsByMessage.get(message.id) ?? [];
  const attachments: BuildMimeAttachment[] = [];
  for (const attachment of attachmentRows) {
    const blob = await deps.blobs.get(attachment.blobKey);
    if (blob === null) {
      throw new NotFoundError("Attachment body", attachment.id);
    }
    attachments.push({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      content: new Uint8Array(await new Response(blob.body).arrayBuffer()),
      contentId: attachment.contentId,
      inline: attachment.inline,
    });
  }
  const raw = deps.mimeBuilder.build({
    from: { address: message.fromAddress, name: message.fromName },
    to: to.map((address) => ({ address, name: null })),
    cc: cc.map((address) => ({ address, name: null })),
    ...(message.replyTo === null
      ? {}
      : { replyTo: { address: message.replyTo, name: null } }),
    subject: message.subject,
    ...(message.textBody === null ? {} : { text: message.textBody }),
    ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
    messageId: message.rfcMessageId ?? String(message.id),
    ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
    references: message.references,
    date: message.occurredAt,
    ...(options.customHeaders === undefined
      ? {}
      : { headers: options.customHeaders }),
    attachments,
  });

  const mail: OutboundMail = {
    from: message.fromAddress,
    to,
    cc,
    bcc,
    subject: message.subject,
    text: message.textBody ?? "",
    ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
    ...(message.rfcMessageId === null
      ? {}
      : { messageId: message.rfcMessageId }),
    ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
    ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
    references: message.references,
    ...(options.customHeaders === undefined
      ? {}
      : { headers: options.customHeaders }),
    raw,
    attachments: attachments.map((attachment) => ({
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      content: attachment.content,
      inline: attachment.inline,
      contentId: attachment.contentId,
    })),
  };
  return { mail, raw };
}
