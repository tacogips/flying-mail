import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors";
import { createCarddavAccountId, createUserId } from "../value-objects/ids";
import {
  createCarddavAccount,
  normalizeCarddavServerUrl,
} from "./carddav-account";

const base = {
  id: createCarddavAccountId("card-1"),
  userId: createUserId("usr-1"),
  username: "taco@example.com",
  passwordCiphertext: "v1:abcdef",
  createdAt: "2026-08-24T00:00:00.000Z",
};

describe("createCarddavAccount", () => {
  it("stores ciphertext and never a plaintext field", () => {
    const account = createCarddavAccount({
      ...base,
      serverUrl: "https://contacts.icloud.com",
    });
    expect(account.passwordCiphertext).toBe("v1:abcdef");
    expect(Object.keys(account)).not.toContain("password");
    expect(account.principalUrl).toBeNull();
    expect(account.homeSetUrl).toBeNull();
  });

  it("rejects an empty username", () => {
    expect(() =>
      createCarddavAccount({
        ...base,
        username: "  ",
        serverUrl: "https://contacts.icloud.com",
      }),
    ).toThrow(ValidationError);
  });

  it("rejects empty ciphertext", () => {
    expect(() =>
      createCarddavAccount({
        ...base,
        passwordCiphertext: "",
        serverUrl: "https://contacts.icloud.com",
      }),
    ).toThrow(ValidationError);
  });
});

describe("normalizeCarddavServerUrl", () => {
  it("accepts https and localhost http", () => {
    expect(normalizeCarddavServerUrl("https://contacts.icloud.com")).toBe(
      "https://contacts.icloud.com/",
    );
    expect(normalizeCarddavServerUrl("http://localhost:8080/dav")).toBe(
      "http://localhost:8080/dav",
    );
    expect(normalizeCarddavServerUrl("http://127.0.0.1:8080/dav")).toBe(
      "http://127.0.0.1:8080/dav",
    );
  });

  it("rejects plain http to a remote host", () => {
    expect(() =>
      normalizeCarddavServerUrl("http://contacts.example.com"),
    ).toThrow(ValidationError);
  });

  it("rejects a non-URL", () => {
    expect(() => normalizeCarddavServerUrl("contacts.icloud.com")).toThrow(
      ValidationError,
    );
  });
});
