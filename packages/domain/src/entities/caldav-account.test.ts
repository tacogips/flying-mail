import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createCaldavAccountId, createUserId } from "../value-objects/ids";
import {
  createCaldavAccount,
  normalizeCaldavServerUrl,
} from "./caldav-account";

const base = {
  id: createCaldavAccountId("dav-1"),
  userId: createUserId("usr-1"),
  username: "taco@example.com",
  passwordCiphertext: "v1:abcdef",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("createCaldavAccount", () => {
  it("stores ciphertext and never a plaintext field", () => {
    const account = createCaldavAccount({
      ...base,
      serverUrl: "https://caldav.icloud.com",
    });
    expect(account.passwordCiphertext).toBe("v1:abcdef");
    expect(Object.keys(account)).not.toContain("password");
    expect(account.principalUrl).toBeNull();
  });

  it("rejects an empty username", () => {
    expect(() =>
      createCaldavAccount({
        ...base,
        username: "  ",
        serverUrl: "https://caldav.icloud.com",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects empty ciphertext", () => {
    expect(() =>
      createCaldavAccount({
        ...base,
        passwordCiphertext: "",
        serverUrl: "https://caldav.icloud.com",
      }),
    ).toThrow(ValidationError);
  });
});

describe("normalizeCaldavServerUrl", () => {
  it("accepts https and localhost http", () => {
    expect(normalizeCaldavServerUrl("https://caldav.icloud.com")).toBe(
      "https://caldav.icloud.com/",
    );
    expect(normalizeCaldavServerUrl("http://localhost:8080/dav")).toBe(
      "http://localhost:8080/dav",
    );
  });

  it("rejects plain http to a remote host", () => {
    expect(() => normalizeCaldavServerUrl("http://caldav.example.com")).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-URL", () => {
    expect(() => normalizeCaldavServerUrl("caldav.icloud.com")).toThrow(
      ValidationError,
    );
  });
});
