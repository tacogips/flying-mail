import {
  BadUserInputError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
} from "@flying-mail/application/errors";
import { describe, expect, test, vi } from "vitest";
import { toolErrorResult } from "./errors";

describe("MCP tool error mapping", () => {
  test.each([
    [new ForbiddenError("denied"), "FORBIDDEN"],
    [new NotFoundError("Message", "m1"), "NOT_FOUND"],
    [new ConflictError("conflict"), "CONFLICT"],
    [new RateLimitedError("slow down"), "RATE_LIMITED"],
    [new ServiceUnavailableError("offline"), "SERVICE_UNAVAILABLE"],
  ])("maps application errors", (error, code) => {
    expect(toolErrorResult(error).structuredContent.error.code).toBe(code);
  });

  test("preserves bad input field and maps MailDeliveryError", () => {
    expect(
      toolErrorResult(new BadUserInputError("bad", "subject")).structuredContent
        .error,
    ).toEqual({
      code: "BAD_USER_INPUT",
      message: "bad",
      field: "subject",
    });
    const mailError = new Error("provider details");
    mailError.name = "MailDeliveryError";
    expect(toolErrorResult(mailError).structuredContent.error).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "Email delivery is not configured on this server",
    });
  });

  test("masks internal errors and logs cause only on server", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = toolErrorResult(new Error("db secret"));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "Error INTERNAL_ERROR: Internal server error",
    );
    expect(JSON.stringify(result)).not.toContain("db secret");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
