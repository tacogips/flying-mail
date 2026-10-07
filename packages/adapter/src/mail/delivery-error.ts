import type { MailDeliveryReason } from "@flying-mail/application/ports/mail-sender";

const GENERIC_DELIVERY_ERROR = "Email delivery is unavailable";
const ERROR_CODE_PATTERN = /\bE_[A-Z_]+\b/;

const PROVIDER_REASON_BY_CODE: Readonly<Record<string, MailDeliveryReason>> = {
  E_SENDER_NOT_VERIFIED: "SENDER_NOT_VERIFIED",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "SENDER_DOMAIN_NOT_AVAILABLE",
  E_RECIPIENT_NOT_ALLOWED: "RECIPIENT_NOT_ALLOWED",
  E_RECIPIENT_SUPPRESSED: "RECIPIENT_SUPPRESSED",
  E_RATE_LIMIT_EXCEEDED: "RATE_LIMITED",
  E_DAILY_LIMIT_EXCEEDED: "RATE_LIMITED",
  E_VALIDATION_ERROR: "MESSAGE_REJECTED",
  E_FIELD_MISSING: "MESSAGE_REJECTED",
  E_TOO_MANY_RECIPIENTS: "MESSAGE_REJECTED",
  E_CONTENT_TOO_LARGE: "MESSAGE_REJECTED",
};

/** A provider failure with an address-free message and stable reason code. */
export class MailDeliveryError extends Error {
  readonly reason: MailDeliveryReason;

  constructor(reason: MailDeliveryReason = "PROVIDER_ERROR") {
    super(GENERIC_DELIVERY_ERROR);
    this.name = "MailDeliveryError";
    this.reason = reason;
  }
}

/** Maps one Cloudflare provider error code to the application's safe model. */
export function classifyProviderCode(code: string | null): MailDeliveryReason {
  if (code === null) {
    return "PROVIDER_ERROR";
  }
  if (/^E_HEADER_/.test(code)) {
    return "MESSAGE_REJECTED";
  }
  return PROVIDER_REASON_BY_CODE[code] ?? "PROVIDER_ERROR";
}

/** Extracts a provider code without retaining its possibly sensitive text. */
export function classifyProviderError(error: unknown): MailDeliveryReason {
  if (typeof error !== "object" || error === null) {
    return "PROVIDER_ERROR";
  }
  if ("code" in error && typeof error.code === "string") {
    return classifyProviderCode(error.code);
  }
  if ("message" in error && typeof error.message === "string") {
    return classifyProviderCode(
      error.message.match(ERROR_CODE_PATTERN)?.[0] ?? null,
    );
  }
  return "PROVIDER_ERROR";
}
