import { describe, expect, test } from "vitest";
import { ValidationError } from "../errors";
import { createEmailAddress } from "../value-objects/email-address";
import {
  createExternalAccountId,
  createMailAddressId,
} from "../value-objects/ids";
import {
  createExternalMailAccount,
  type ExternalFetchConfig,
  ExternalAccountStatus,
  isExternalAccountActive,
  markExternalMailAccountFetched,
  normalizeJmapSessionUrl,
  renameExternalMailAccount,
  replaceExternalMailAccountFetch,
  replaceExternalMailAccountSmtp,
  setExternalMailAccountStatus,
  type SmtpSubmissionConfig,
  validatePop3Endpoint,
  validateSmtpSubmissionConfig,
} from "./external-mail-account";

const NOW = "2026-08-24T00:00:00.000Z";
const LATER = "2026-08-25T00:00:00.000Z";

const jmapFetch: ExternalFetchConfig = {
  kind: "JMAP",
  sessionUrl: "https://api.fastmail.com/jmap/session",
  username: "taco@fastmail.com",
  passwordCiphertext: "v1:jmap-secret",
};

const pop3Fetch: ExternalFetchConfig = {
  kind: "POP3",
  host: "pop.gmail.com",
  port: 995,
  username: "taco@gmail.com",
  passwordCiphertext: "v1:pop3-secret",
};

const implicitSmtp: SmtpSubmissionConfig = {
  host: "smtp.gmail.com",
  port: 465,
  security: "IMPLICIT_TLS",
  username: "taco@gmail.com",
  passwordCiphertext: "v1:smtp-secret",
};

function mint(
  overrides: Partial<Parameters<typeof createExternalMailAccount>[0]> = {},
) {
  return createExternalMailAccount({
    id: createExternalAccountId("ext-1"),
    mailAddressId: createMailAddressId("addr-1"),
    externalAddress: createEmailAddress("taco@gmail.com"),
    fetch: jmapFetch,
    createdAt: NOW,
    ...overrides,
  });
}

describe("createExternalMailAccount", () => {
  test("creates a JMAP account starting ACTIVE with no smtp/lastFetchedAt", () => {
    const account = mint();
    expect(account.fetch.kind).toBe("JMAP");
    expect(account.smtp).toBeNull();
    expect(account.status).toBe(ExternalAccountStatus.Active);
    expect(account.lastFetchedAt).toBeNull();
    expect(account.createdAt).toBe(NOW);
    expect(account.updatedAt).toBe(NOW);
  });

  test("creates a POP3 account", () => {
    const account = mint({ fetch: pop3Fetch });
    expect(account.fetch).toEqual({ ...pop3Fetch });
  });

  test("normalizes the JMAP session URL", () => {
    const account = mint({
      fetch: {
        ...jmapFetch,
        sessionUrl: "https://api.fastmail.com/jmap/session",
      },
    });
    expect(account.fetch).toMatchObject({ kind: "JMAP" });
    if (account.fetch.kind === "JMAP") {
      expect(account.fetch.sessionUrl).toBe(
        "https://api.fastmail.com/jmap/session",
      );
    }
  });

  test("rejects a non-https, non-localhost JMAP session URL", () => {
    expect(() =>
      mint({
        fetch: {
          ...jmapFetch,
          sessionUrl: "http://api.fastmail.com/jmap/session",
        },
      }),
    ).toThrow(ValidationError);
  });

  test("rejects POP3 port other than 995", () => {
    expect(() => mint({ fetch: { ...pop3Fetch, port: 110 } })).toThrow(
      ValidationError,
    );
  });

  test("rejects an empty fetch username", () => {
    expect(() => mint({ fetch: { ...jmapFetch, username: "  " } })).toThrow(
      ValidationError,
    );
  });

  test("rejects an empty fetch password ciphertext", () => {
    expect(() =>
      mint({ fetch: { ...jmapFetch, passwordCiphertext: "" } }),
    ).toThrow(ValidationError);
  });

  test("stores ciphertext only, never a plaintext field", () => {
    const account = mint();
    expect(Object.keys(account.fetch)).not.toContain("password");
  });

  test("accepts a valid smtp config", () => {
    const account = mint({ smtp: implicitSmtp });
    expect(account.smtp).toEqual(implicitSmtp);
  });

  test("rejects an smtp port/security mismatch", () => {
    expect(() =>
      mint({ smtp: { ...implicitSmtp, port: 465, security: "STARTTLS" } }),
    ).toThrow(ValidationError);
    expect(() =>
      mint({
        smtp: { ...implicitSmtp, port: 587, security: "IMPLICIT_TLS" },
      }),
    ).toThrow(ValidationError);
  });

  test("normalizes displayName, treating blank as null", () => {
    expect(mint({ displayName: "  Taco  " }).displayName).toBe("Taco");
    expect(mint({ displayName: "   " }).displayName).toBeNull();
    expect(mint({ displayName: null }).displayName).toBeNull();
  });
});

describe("normalizeJmapSessionUrl", () => {
  test("accepts https and localhost http", () => {
    expect(normalizeJmapSessionUrl("https://api.fastmail.com/jmap")).toBe(
      "https://api.fastmail.com/jmap",
    );
    expect(normalizeJmapSessionUrl("http://localhost:8080/jmap")).toBe(
      "http://localhost:8080/jmap",
    );
  });

  test("rejects plain http to a remote host", () => {
    expect(() =>
      normalizeJmapSessionUrl("http://api.fastmail.com/jmap"),
    ).toThrow(ValidationError);
  });

  test("rejects a non-URL", () => {
    expect(() => normalizeJmapSessionUrl("api.fastmail.com/jmap")).toThrow(
      ValidationError,
    );
  });
});

describe("validatePop3Endpoint", () => {
  test("accepts port 995", () => {
    expect(() => validatePop3Endpoint("pop.gmail.com", 995)).not.toThrow();
  });

  test("rejects plaintext port 110", () => {
    expect(() => validatePop3Endpoint("pop.gmail.com", 110)).toThrow(
      ValidationError,
    );
  });

  test("rejects an empty host", () => {
    expect(() => validatePop3Endpoint("  ", 995)).toThrow(ValidationError);
  });
});

describe("validateSmtpSubmissionConfig", () => {
  test("accepts 465 with IMPLICIT_TLS and 587 with STARTTLS", () => {
    expect(() => validateSmtpSubmissionConfig(implicitSmtp)).not.toThrow();
    expect(() =>
      validateSmtpSubmissionConfig({
        ...implicitSmtp,
        port: 587,
        security: "STARTTLS",
      }),
    ).not.toThrow();
  });

  test("rejects a port/security mismatch", () => {
    expect(() =>
      validateSmtpSubmissionConfig({
        ...implicitSmtp,
        port: 587,
        security: "IMPLICIT_TLS",
      }),
    ).toThrow(ValidationError);
  });

  test("rejects an unsupported port", () => {
    expect(() =>
      validateSmtpSubmissionConfig({
        ...implicitSmtp,
        port: 25,
        security: "STARTTLS",
      }),
    ).toThrow(ValidationError);
  });

  test("rejects empty host, username, or ciphertext", () => {
    expect(() =>
      validateSmtpSubmissionConfig({ ...implicitSmtp, host: " " }),
    ).toThrow(ValidationError);
    expect(() =>
      validateSmtpSubmissionConfig({ ...implicitSmtp, username: " " }),
    ).toThrow(ValidationError);
    expect(() =>
      validateSmtpSubmissionConfig({
        ...implicitSmtp,
        passwordCiphertext: " ",
      }),
    ).toThrow(ValidationError);
  });
});

describe("replaceExternalMailAccountFetch", () => {
  test("swaps JMAP for POP3 and bumps updatedAt", () => {
    const account = mint();
    const replaced = replaceExternalMailAccountFetch(account, pop3Fetch, LATER);
    expect(replaced.fetch.kind).toBe("POP3");
    expect(replaced.updatedAt).toBe(LATER);
  });

  test("validates the new fetch config", () => {
    const account = mint();
    expect(() =>
      replaceExternalMailAccountFetch(
        account,
        { ...pop3Fetch, port: 110 },
        LATER,
      ),
    ).toThrow(ValidationError);
  });
});

describe("replaceExternalMailAccountSmtp", () => {
  test("sets the smtp config", () => {
    const account = mint();
    const replaced = replaceExternalMailAccountSmtp(
      account,
      implicitSmtp,
      LATER,
    );
    expect(replaced.smtp).toEqual(implicitSmtp);
    expect(replaced.updatedAt).toBe(LATER);
  });

  test("clears the smtp config with null", () => {
    const account = mint({ smtp: implicitSmtp });
    const replaced = replaceExternalMailAccountSmtp(account, null, LATER);
    expect(replaced.smtp).toBeNull();
  });
});

describe("renameExternalMailAccount", () => {
  test("trims and treats blank as null", () => {
    const account = mint();
    expect(
      renameExternalMailAccount(account, "  Work  ", LATER).displayName,
    ).toBe("Work");
    expect(
      renameExternalMailAccount(account, "   ", LATER).displayName,
    ).toBeNull();
  });
});

describe("setExternalMailAccountStatus", () => {
  test("transitions status and bumps updatedAt", () => {
    const account = mint();
    const disabled = setExternalMailAccountStatus(
      account,
      ExternalAccountStatus.Disabled,
      LATER,
    );
    expect(disabled.status).toBe(ExternalAccountStatus.Disabled);
    expect(disabled.updatedAt).toBe(LATER);
  });

  test("is a no-op when the status is unchanged", () => {
    const account = mint();
    const result = setExternalMailAccountStatus(
      account,
      ExternalAccountStatus.Active,
      LATER,
    );
    expect(result).toBe(account);
  });
});

describe("markExternalMailAccountFetched", () => {
  test("sets lastFetchedAt and updatedAt", () => {
    const account = mint();
    const fetched = markExternalMailAccountFetched(account, LATER);
    expect(fetched.lastFetchedAt).toBe(LATER);
    expect(fetched.updatedAt).toBe(LATER);
  });
});

describe("isExternalAccountActive", () => {
  test("reflects status", () => {
    const account = mint();
    expect(isExternalAccountActive(account)).toBe(true);
    expect(
      isExternalAccountActive(
        setExternalMailAccountStatus(
          account,
          ExternalAccountStatus.Disabled,
          LATER,
        ),
      ),
    ).toBe(false);
  });
});
