import type {
  MailSender,
  OutboundAttachment,
  OutboundMail,
} from "@flying-mail/application/ports/mail-sender";
import { classifyProviderError, MailDeliveryError } from "./delivery-error";

const LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

declare const cloudflareSenderAddressBrand: unique symbol;

/** One canonical plain mailbox accepted by the Workers email binding. */
export type CloudflareSenderAddress = string & {
  readonly [cloudflareSenderAddressBrand]: true;
};

/** Parses one ASCII mailbox with no display-name or address-list syntax.
 * Kept separate from the domain layer's `EmailAddress` because this is a
 * *provider* constraint: the binding rejects anything else, and finding
 * that out at send time would surface as an opaque failure. */
export function parseCloudflareSenderAddress(
  value: string,
): CloudflareSenderAddress | null {
  if (
    value.length > 254 ||
    value !== value.trim() ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    return null;
  }
  const parts = value.split("@");
  if (parts.length !== 2) {
    return null;
  }
  const local = parts[0];
  const domain = parts[1];
  if (
    local === undefined ||
    domain === undefined ||
    local.length === 0 ||
    local.length > 64 ||
    !LOCAL_PART_PATTERN.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length === 0 ||
    domain.length > 253
  ) {
    return null;
  }
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !DOMAIN_LABEL_PATTERN.test(label))
  ) {
    return null;
  }
  return value.toLowerCase() as CloudflareSenderAddress;
}

/** Structural mirror of the Workers EmailMessageBuilder input. */
export interface CloudflareEmailAttachment {
  readonly disposition: "attachment" | "inline";
  readonly contentId?: string;
  readonly filename: string;
  readonly type: string;
  readonly content: Uint8Array;
}

export interface CloudflareEmailMessage {
  readonly from: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachments?: readonly CloudflareEmailAttachment[];
  readonly headers?: Readonly<Record<string, string>>;
}

export interface CloudflareEmailSendResult {
  readonly messageId?: string;
}

/** Minimal structural Workers binding, avoiding an ambient runtime
 * dependency (see the local types in `../sql/d1.ts` for the same rationale). */
export interface CloudflareSendEmailBinding {
  send(
    message: CloudflareEmailMessage,
  ): Promise<CloudflareEmailSendResult | undefined>;
}

export { MailDeliveryError } from "./delivery-error";

/** Raised when a message's own sender is not a mailbox the binding will
 * accept. Distinct from {@link MailDeliveryError} so the send use case can
 * tell "the provider refused us" from "this From could never work". */
export class InvalidSenderAddressError extends Error {
  constructor(readonly address: string) {
    super("Sender address is not a valid mailbox");
    this.name = "InvalidSenderAddressError";
  }
}

function toBindingAttachment(
  attachment: OutboundAttachment,
): CloudflareEmailAttachment {
  const common = {
    filename: attachment.fileName,
    type: attachment.contentType,
    content: attachment.content,
  };
  if (attachment.inline && attachment.contentId) {
    return {
      ...common,
      disposition: "inline",
      contentId: attachment.contentId,
    };
  }
  return { ...common, disposition: "attachment" };
}

function toProviderHeaders(mail: OutboundMail): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of mail.headers ?? []) {
    if (!/^message-id$/i.test(name) && !/^bcc$/i.test(name)) {
      headers[name] = value;
    }
  }
  if (mail.inReplyTo !== undefined) {
    headers["In-Reply-To"] = `<${mail.inReplyTo}>`;
  }
  if (mail.references !== undefined && mail.references.length > 0) {
    headers["References"] = mail.references.map((id) => `<${id}>`).join(" ");
  }
  return headers;
}

/** Cloudflare Email Service adapter for the native Workers `send_email` binding. */
export function createCloudflareMailSender(
  binding: CloudflareSendEmailBinding,
): MailSender {
  return {
    async send(mail: OutboundMail) {
      // Checked here rather than at the call site because it is a *provider*
      // constraint: the binding rejects anything else, and finding out at
      // send time would surface as an opaque failure.
      const from = parseCloudflareSenderAddress(mail.from);
      if (from === null) {
        throw new InvalidSenderAddressError(mail.from);
      }
      const headers = toProviderHeaders(mail);
      const attachments = mail.attachments?.map(toBindingAttachment);
      try {
        const result = await binding.send({
          from,
          ...(mail.to.length > 0 ? { to: [...mail.to] } : {}),
          ...(mail.cc !== undefined && mail.cc.length > 0
            ? { cc: [...mail.cc] }
            : {}),
          ...(mail.bcc !== undefined && mail.bcc.length > 0
            ? { bcc: [...mail.bcc] }
            : {}),
          ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
          subject: mail.subject,
          ...(mail.text.length > 0 ? { text: mail.text } : {}),
          ...(mail.html === undefined ? {} : { html: mail.html }),
          ...(attachments !== undefined && attachments.length > 0
            ? { attachments }
            : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        return { providerMessageId: result?.messageId ?? null };
      } catch (error) {
        throw new MailDeliveryError(classifyProviderError(error));
      }
    },
  };
}

/** Deferred failure used when the deployment has no verified sender, or is
 * running outside Workers. Failing here -- rather than at configuration
 * time -- keeps the server startable so an operator can log in and finish
 * setting it up, while every send attempt says plainly what is missing. */
export function createUnavailableMailSender(): MailSender {
  return {
    async send() {
      throw new MailDeliveryError("NOT_CONFIGURED");
    },
  };
}
