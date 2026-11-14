import {
  DomainError,
  DomainNotVerifiedError,
  InvalidStateTransitionError,
  SystemTagImmutableError,
  ValidationError,
} from "@mailcal/domain/errors";
import { describe, expect, test } from "vitest";
import { BadUserInputError, ConflictError, NotFoundError } from "../errors";
import {
  translateDomainError,
  withAsyncDomainErrorTranslation,
  withDomainErrorTranslation,
} from "./translate-domain-error";

class UnknownDomainError extends DomainError {
  readonly code = "UNKNOWN_DOMAIN_ERROR";
}

describe("translateDomainError", () => {
  test("ValidationError becomes BadUserInputError preserving the field", () => {
    // `translateDomainError` is typed `never`, so no post-call assertion is
    // reachable here -- the catch block is the whole test.
    try {
      translateDomainError(new ValidationError("bad subject", "subject"));
    } catch (error) {
      expect(error).toBeInstanceOf(BadUserInputError);
      expect((error as BadUserInputError).field).toBe("subject");
    }
  });

  test.each([
    ["SystemTagImmutableError", new SystemTagImmutableError("nope", "tag-1")],
    [
      "InvalidStateTransitionError",
      new InvalidStateTransitionError("nope", "SENT", "QUEUED"),
    ],
    [
      "DomainNotVerifiedError",
      new DomainNotVerifiedError("nope", "example.com"),
    ],
  ])("%s becomes ConflictError", (_name, domainError) => {
    expect(() => translateDomainError(domainError)).toThrow(ConflictError);
  });

  test("an unrecognized DomainError still surfaces as a client error", () => {
    expect(() => translateDomainError(new UnknownDomainError("odd"))).toThrow(
      BadUserInputError,
    );
  });

  test("an ApplicationError passes through untouched", () => {
    const original = new NotFoundError("Message", "msg-1");
    try {
      translateDomainError(original);
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  test("a plain Error passes through untouched", () => {
    const original = new Error("network down");
    try {
      translateDomainError(original);
    } catch (error) {
      expect(error).toBe(original);
    }
  });
});

describe("wrappers", () => {
  test("withDomainErrorTranslation returns the value on success", () => {
    expect(withDomainErrorTranslation(() => 42)).toBe(42);
  });

  test("withDomainErrorTranslation translates a throw", () => {
    expect(() =>
      withDomainErrorTranslation(() => {
        throw new ValidationError("bad", "field");
      }),
    ).toThrow(BadUserInputError);
  });

  test("withAsyncDomainErrorTranslation translates a rejection", async () => {
    await expect(
      withAsyncDomainErrorTranslation(async () => {
        throw new ValidationError("bad", "field");
      }),
    ).rejects.toBeInstanceOf(BadUserInputError);
  });

  test("withAsyncDomainErrorTranslation resolves on success", async () => {
    await expect(
      withAsyncDomainErrorTranslation(async () => "ok"),
    ).resolves.toBe("ok");
  });
});
