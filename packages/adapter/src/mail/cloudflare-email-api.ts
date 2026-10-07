import type {
  MailSender,
  OutboundAttachment,
  OutboundMail,
} from "@flying-mail/application/ports/mail-sender";
import { classifyProviderCode, MailDeliveryError } from "./delivery-error";

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
  readonly contentId?: string;
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
  const contentId = attachment.inline ? attachment.contentId : undefined;
  return {
    content: toBase64(attachment.content),
    filename: attachment.fileName,
    type: attachment.contentType,
    disposition: attachment.inline ? "inline" : "attachment",
    ...(contentId == null ? {} : { contentId }),
  };
}

function providerCodeFromResponse(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "errors" in parsed) {
      const errors: unknown = parsed.errors;
      if (Array.isArray(errors)) {
        const first: unknown = errors[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "code" in first &&
          typeof first.code === "string"
        ) {
          return first.code;
        }
      }
    }
  } catch {
    // The raw response is still checked for a provider code below.
  }
  return raw.match(/\bE_[A-Z_]+\b/)?.[0] ?? null;
}

function providerMessageIdFromResponse(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      const result: unknown = parsed.result;
      if (
        typeof result === "object" &&
        result !== null &&
        "message_id" in result &&
        typeof result.message_id === "string"
      ) {
        return result.message_id;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function providerHeaders(mail: OutboundMail): Record<string, string> {
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
    async send(mail: OutboundMail) {
      const attachments = (mail.attachments ?? []).map(toRequestAttachment);
      if (estimateBytes(mail, attachments) > MAX_MESSAGE_BYTES) {
        throw new MailDeliveryError("MESSAGE_REJECTED");
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

      let providerMessageId: string | null = null;
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
        if (mail.replyTo !== undefined) {
          body["reply_to"] = mail.replyTo;
        }
        const headers = providerHeaders(mail);
        if (Object.keys(headers).length > 0) {
          body["headers"] = headers;
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
        } catch (error) {
          throw new MailDeliveryError(
            classifyProviderCode(
              error instanceof Error
                ? (error.message.match(/\bE_[A-Z_]+\b/)?.[0] ?? null)
                : null,
            ),
          );
        }
        const responseBody = await response.text().catch(() => "");
        if (!response.ok) {
          // The provider's error text echoes recipients and subjects, and
          // this reaches API clients -- including keys scoped to one
          // mailbox. Read and discard it rather than surfacing it.
          throw new MailDeliveryError(
            classifyProviderCode(providerCodeFromResponse(responseBody)),
          );
        }
        providerMessageId ??= providerMessageIdFromResponse(responseBody);
      }
      return {
        providerMessageId,
      };
    },
  };
}
