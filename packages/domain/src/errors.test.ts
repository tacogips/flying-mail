import { describe, expect, test } from "vitest";
import {
  DomainError,
  DomainNotVerifiedError,
  InvalidStateTransitionError,
  SystemTagImmutableError,
  ValidationError,
} from "./errors";

describe("DomainError subclasses", () => {
  test("ValidationError carries its code, name and field", () => {
    const error = new ValidationError("subject must not be empty", "subject");
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.name).toBe("ValidationError");
    expect(error.field).toBe("subject");
    expect(error.message).toBe("subject must not be empty");
  });

  test("SystemTagImmutableError carries the offending tag id", () => {
    const error = new SystemTagImmutableError("cannot rename", "tag-spam");
    expect(error.code).toBe("SYSTEM_TAG_IMMUTABLE");
    expect(error.name).toBe("SystemTagImmutableError");
    expect(error.tagId).toBe("tag-spam");
  });

  test("InvalidStateTransitionError carries both states", () => {
    const error = new InvalidStateTransitionError("bad move", "SENT", "QUEUED");
    expect(error.code).toBe("INVALID_STATE_TRANSITION");
    expect(error.from).toBe("SENT");
    expect(error.to).toBe("QUEUED");
  });

  test("DomainNotVerifiedError carries the domain name", () => {
    const error = new DomainNotVerifiedError("not verified", "example.com");
    expect(error.code).toBe("DOMAIN_NOT_VERIFIED");
    expect(error.domainName).toBe("example.com");
  });
});
