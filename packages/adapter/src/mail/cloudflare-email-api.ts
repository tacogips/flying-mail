import type {
  MailSender,
  OutboundAttachment,
  OutboundMail,
} from "@mailcal/application/ports/mail-sender";
import { MailDeliveryError } from "./cloudflare-email";

/**
 * Cloudflare Email Service's REST send API.
 *
 * The `send_email` Workers binding can only deliver to addresses already
 * verified as *destination addresses* on the account -- that is what it is
 * for, and it makes it unusable as a general mail server's outbound path.
 * This adapter targets the Email Sending REST API instead, which delivers
 * to any recipient and assembles the MIME itself, so structured attachments
 * are passed through rather than pre-encoded.
 *
 * Plain `fetch`, so it runs unchanged in the Workers runtime and under Bun.
 */

const SEND_PATH = "email/sending/send";
const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

/** Cloudflare's documented cap for one message including its attachments. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export interface CloudflareEmailApiConfig {
  readonly accountId: string;
  readonly apiToken: string;
  /** Overridable for tests; defaults to the public API. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface SendRequestAttachment {
  readonly content: string;
  readonly filename: string;
  readonly type: string;
  readonly disposition: "attachment" | "inline";
}

/** Base64 without Node's Buffer, so the same code runs in Workers.
 * Chunked because `String.fromCharCode(...bytes)` overflows the call stack
 * on a multi-megabyte attachment. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function toRequestAttachment(
  attachment: OutboundAttachment,
): SendRequestAttachment {
  return {
    content: toBase64(attachment.content),
    filename: attachment.fileName,
    type: attachment.contentType,
    disposition: attachment.inline ? "inline" : "attachment",
  };
}

/** Rough byte budget: the base64 expansion plus the text parts. Checked
 * before the request so an oversized message fails as itself rather than as
 * an opaque provider rejection. */
function estimateBytes(
  mail: OutboundMail,
  attachments: readonly SendRequestAttachment[],
): number {
  const bodyBytes = (mail.text?.length ?? 0) + (mail.html?.length ?? 0);
  return attachments.reduce(
    (total, attachment) => total + attachment.content.length,
    bodyBytes,
  );
}

export function createCloudflareEmailApiSender(
  config: CloudflareEmailApiConfig,
): MailSender {
  const doFetch = config.fetch ?? fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const endpoint = `${baseUrl}/accounts/${config.accountId}/${SEND_PATH}`;

  return {
    async send(mail: OutboundMail): Promise<void> {
      const attachments = (mail.attachments ?? []).map(toRequestAttachment);
      if (estimateBytes(mail, attachments) > MAX_MESSAGE_BYTES) {
        throw new MailDeliveryError();
      }

      // The API takes one recipient per field rather than a combined list,
      // and Bcc must stay out of the header -- so each Bcc recipient gets
      // its own request, exactly as the binding path fans out.
      const visibleTo = [...mail.to];
      const cc = mail.cc ?? [];
      const bcc = mail.bcc ?? [];

      const deliveries: { to: readonly string[]; cc: readonly string[] }[] = [];
      if (visibleTo.length > 0 || cc.length > 0) {
        deliveries.push({ to: visibleTo, cc });
      }
      for (const hidden of bcc) {
        deliveries.push({ to: [hidden], cc: [] });
      }

      for (const delivery of deliveries) {
        const body: Record<string, unknown> = {
          from: mail.from,
          to: delivery.to.length === 1 ? delivery.to[0] : [...delivery.to],
          subject: mail.subject,
        };
        if (delivery.cc.length > 0) {
          body["cc"] = [...delivery.cc];
        }
        if (mail.text.length > 0) {
          body["text"] = mail.text;
        }
        if (mail.html !== undefined) {
          body["html"] = mail.html;
        }
        if (attachments.length > 0) {
          body["attachments"] = attachments;
        }
        if (mail.headers !== undefined && mail.headers.size > 0) {
          body["headers"] = Object.fromEntries(mail.headers);
        }

        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        } catch {
          throw new MailDeliveryError();
        }
        if (!response.ok) {
          // The provider's error text echoes recipients and subjects, and
          // this reaches API clients -- including keys scoped to one
          // mailbox. Read and discard it rather than surfacing it.
          await response.text().catch(() => "");
          throw new MailDeliveryError();
        }
      }
    },
  };
}
