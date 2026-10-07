import { describe, expect, test } from "vitest";
import { readDeliveryReason } from "@flying-mail/application/ports/mail-sender";
import {
  classifyProviderCode,
  classifyProviderError,
  MailDeliveryError,
} from "./delivery-error";

describe("classifyProviderCode", () => {
  test.each([
    ["E_SENDER_NOT_VERIFIED", "SENDER_NOT_VERIFIED"],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "SENDER_DOMAIN_NOT_AVAILABLE"],
    ["E_RECIPIENT_NOT_ALLOWED", "RECIPIENT_NOT_ALLOWED"],
    ["E_RECIPIENT_SUPPRESSED", "RECIPIENT_SUPPRESSED"],
    ["E_RATE_LIMIT_EXCEEDED", "RATE_LIMITED"],
    ["E_DAILY_LIMIT_EXCEEDED", "RATE_LIMITED"],
    ["E_VALIDATION_ERROR", "MESSAGE_REJECTED"],
    ["E_FIELD_MISSING", "MESSAGE_REJECTED"],
    ["E_TOO_MANY_RECIPIENTS", "MESSAGE_REJECTED"],
    ["E_CONTENT_TOO_LARGE", "MESSAGE_REJECTED"],
    ["E_HEADER_USE_API_FIELD", "MESSAGE_REJECTED"],
    ["E_UNKNOWN_PROVIDER_FAILURE", "PROVIDER_ERROR"],
  ] as const)("maps %s", (code, expected) => {
    expect(classifyProviderCode(code)).toBe(expected);
  });

  test("maps a missing code to PROVIDER_ERROR", () => {
    expect(classifyProviderCode(null)).toBe("PROVIDER_ERROR");
  });
});

describe("provider error classification", () => {
  test("prefers an explicit code over a code in the message", () => {
    expect(
      classifyProviderError({
        code: "E_RECIPIENT_NOT_ALLOWED",
        message: "E_SENDER_NOT_VERIFIED",
      }),
    ).toBe("RECIPIENT_NOT_ALLOWED");
  });

  test("extracts the first code from an error message", () => {
    expect(
      classifyProviderError(new Error("E_RATE_LIMIT_EXCEEDED: a@x.test")),
    ).toBe("RATE_LIMITED");
  });

  test("unknown errors become PROVIDER_ERROR with a fixed message", () => {
    const error = new MailDeliveryError(
      classifyProviderError(new Error("unknown a@x.test")),
    );
    expect(error.reason).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("Email delivery is unavailable");
    expect(error.message).not.toContain("a@x.test");
    expect(readDeliveryReason(new MailDeliveryError("RATE_LIMITED"))).toBe(
      "RATE_LIMITED",
    );
    expect(readDeliveryReason(new Error("plain error"))).toBe("PROVIDER_ERROR");
  });
});
